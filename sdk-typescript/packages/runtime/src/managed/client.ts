/**
 * Managed ("hosted") mode (§18, T23): no store, no models, no keys of your
 * own. `ManagedAgent.start()` reads the environment's catalogue (slot tags,
 * declared variables, workflow step ids, the experiment's salt and arms)
 * with a run key, and `run()` / `stream()` POST to the run route. The
 * subject never leaves the process: `subjectHash` is `hex(SHA-256(salt ‖
 * subject))` computed here, exactly as client mode computes it, so an A/B
 * across modes is one A/B. Refusals are typed; the only retry is a 429
 * honouring `Retry-After`. Every run streams under the hood — the run route
 * sits behind an edge that closes a silent connection at 60 s, and a JSON
 * run is silent until the model finishes — and `run()` assembles the `done`
 * frame for callers who did not ask to stream.
 */

import { createHash } from "node:crypto";
import { errorNamed } from "@airprompter/agent-core";

import { subjectHash as saltedSubjectHash } from "@airprompter/agent-core";

export const MANAGED_SDK_USER_AGENT = "airprompter-agent-sdk-ts/managed";

export type ManagedTarget = "dev" | "staging" | "prod";

export type ManagedFetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface ManagedStartOptions {
  agentId: string;
  target: ManagedTarget;
  /** A run key (`agent_run` kind, `agent.run` scope) for this agent and target. */
  apiKey: string;
  /** The run route's origin (the AgentRunUrl output of the execution stack), e.g. `https://d123.cloudfront.net`. */
  baseUrl: string;
  fetch?: ManagedFetchLike;
  /** Retries on 429 only; each waits `Retry-After` (or a second). Default 2. */
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stable per-process id used when the experiment assigns by instance. */
  instanceId?: string;
  userAgent?: string;
}

export interface ManagedSlot {
  tag: string;
  kind: "prompt" | "workflow";
  model: string;
  variables: ReadonlyArray<{ name: string; required: boolean; trust: string }>;
  steps: ReadonlyArray<{ stepId: string }> | null;
}

export interface ManagedCatalogue {
  agentId: string;
  target: string;
  generation: number;
  releaseDigest: string;
  slots: readonly ManagedSlot[];
  /** The legacy single experiment (it covers every slot); S17: the first of `experiments` when the catalogue lists them. */
  experiment: { salt: string; subjectKey: "request" | "instance"; arms: readonly string[] } | null;
  /** S17: one entry per experiment, each naming the slot it splits (`tag` null on the legacy single one). */
  experiments?: readonly { experimentId: string; tag: string | null; salt: string; subjectKey: "request" | "instance"; arms: readonly string[] }[];
}

export interface ManagedRunOptions {
  /** The experiment subject (an end-user id, a session id). Hashed with the experiment's salt; never sent. */
  subject?: string;
  /** A workflow slot's step to run. */
  stepId?: string;
  idempotencyKey?: string;
  maxOutputTokens?: number;
  /** Content-free correlation the customer keeps; echoed on the response. */
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ManagedRunResult {
  runId: string;
  runRef: string;
  output: string;
  model: string;
  versionId: string;
  arm: string;
  generation: number;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  latencyMs: number;
  priceMicros: number;
  priceBookRevision: string;
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "cancelled" | "unknown";
  source: "executed" | "replayed";
  metadata?: Record<string, string>;
}

export type ManagedRefusalCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "render_missing_variable"
  | "render_unknown_variable"
  | "model_not_priced"
  | "model_not_offered"
  | "allowance_exhausted"
  | "agent_cap_exhausted"
  | "target_not_hosted"
  | "slot_not_found"
  | "nothing_promoted"
  | "step_not_found"
  | "already_executed"
  | "rate_limited"
  | "agent_rate_limited"
  | "model_unavailable"
  | "invalid_run_ref"
  | "internal";

/** The run route said no (or the edge did): the code the route named, its status, and what it told us. */
export class ManagedRunError extends Error {
  constructor(
    readonly code: ManagedRefusalCode,
    readonly status: number,
    message: string,
    readonly detail?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`${code} (${status}): ${message}`);
    this.name = "ManagedRunError";
  }
}

/** `ManagedRunError` by name and code — true across duplicated package copies. */
export function isManagedRunError(error: unknown): error is ManagedRunError {
  return errorNamed<ManagedRefusalCode>(error, "ManagedRunError");
}

/** The stream: deltas as they arrive, then the assembled result. */
export interface ManagedRunStream extends AsyncIterable<string> {
  /** Resolves with the `done` frame once the stream ends; rejects with a `ManagedRunError` on an `error` frame. */
  readonly result: Promise<ManagedRunResult>;
}

interface SseFrame {
  event: string;
  data: string;
}

/** SSE frames from a text chunk stream: `event: x\ndata: y\n\n`, tolerant of partial chunks. */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncGenerator<SseFrame> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = frameOf(raw);
      if (frame) yield frame;
      boundary = buffer.indexOf("\n\n");
    }
  }
  const tail = frameOf(buffer);
  if (tail) yield tail;
}

function frameOf(raw: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

async function* textChunks(response: { body?: ReadableStream<Uint8Array> | null; text(): Promise<string> }): AsyncGenerator<string> {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
    return;
  }
  yield await response.text();
}

function refusalFrom(status: number, body: unknown, retryAfterHeader: string | null): ManagedRunError {
  const parsed = (body ?? {}) as { error?: string; code?: string; detail?: string; retryAfterSeconds?: number };
  const code = (parsed.code as ManagedRefusalCode | undefined) ?? (status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : status >= 500 ? "internal" : "invalid_request");
  const retryAfter = parsed.retryAfterSeconds ?? (retryAfterHeader ? Number(retryAfterHeader) : undefined);
  return new ManagedRunError(code, status, parsed.error ?? `HTTP ${status}`, parsed.detail, Number.isFinite(retryAfter) ? retryAfter : undefined);
}

export class ManagedAgent {
  private catalogue: ManagedCatalogue;
  private readonly fetchImpl: ManagedFetchLike;
  private readonly instanceId: string;

  private constructor(
    private readonly options: ManagedStartOptions,
    catalogue: ManagedCatalogue,
  ) {
    this.catalogue = catalogue;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ManagedFetchLike);
    this.instanceId = options.instanceId ?? createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex");
  }

  /** Reads the catalogue once; refuses (typed) when the key, the target or the promotion is not there. */
  static async start(options: ManagedStartOptions): Promise<ManagedAgent> {
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ManagedFetchLike);
    if (!fetchImpl) throw new Error("no fetch available: Node 20+ or pass options.fetch");
    const catalogue = await ManagedAgent.readCatalogue(fetchImpl, options);
    return new ManagedAgent(options, catalogue);
  }

  private static async readCatalogue(fetchImpl: ManagedFetchLike, options: ManagedStartOptions): Promise<ManagedCatalogue> {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/v1/agents/${encodeURIComponent(options.agentId)}/targets/${options.target}/slots`, {
      method: "GET",
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json", "user-agent": options.userAgent ?? MANAGED_SDK_USER_AGENT },
    });
    const text = await response.text();
    if (response.status !== 200) throw refusalFrom(response.status, safeJson(text), response.headers.get("retry-after"));
    return JSON.parse(text) as ManagedCatalogue;
  }

  /** The catalogue as last read: tags, variables, steps, the experiment's arms. */
  get slots(): ManagedCatalogue {
    return this.catalogue;
  }

  /** Re-reads the catalogue (a run answered with a newer generation, or on a schedule of your own). */
  async refresh(): Promise<ManagedCatalogue> {
    this.catalogue = await ManagedAgent.readCatalogue(this.fetchImpl, this.options);
    return this.catalogue;
  }

  /** S17: the experiment that splits a slot — the per-prompt one by tag, else the legacy single one (it covers every slot), else null. */
  experimentFor(tag: string): { salt: string; subjectKey: "request" | "instance"; arms: readonly string[] } | null {
    const list = this.catalogue.experiments;
    if (list && list.length > 0) return list.find((experiment) => experiment.tag === tag || experiment.tag === null) ?? null;
    return this.catalogue.experiment;
  }

  /** The hash the route buckets on: the slot's experiment salt over the subject (or this instance when the experiment assigns by instance). Never the subject. */
  subjectHashFor(subject: string | undefined, tag?: string): string | undefined {
    const experiment = tag === undefined ? this.catalogue.experiment : this.experimentFor(tag);
    if (!experiment) return undefined;
    const value = experiment.subjectKey === "instance" || subject === undefined ? this.instanceId : subject;
    return saltedSubjectHash(experiment.salt, value);
  }

  /**
   * T30: quality signals against a run, by the `runRef` it returned — from this process or any other that kept the
   * ref. Numbers, booleans and the declared enums only; the answer says what landed and what was refused and why.
   * A ref that does not verify, or one for another agent or environment, is a `ManagedRunError` (`invalid_run_ref`).
   */
  async feedback(runRef: string, signals: Record<string, unknown>): Promise<{ accepted: boolean; attributedTo: { tag: string; versionId: string; arm: string; minute: string } | null; rejected: Record<string, string> }> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/v1/agents/${encodeURIComponent(this.options.agentId)}/targets/${this.options.target}/feedback`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", accept: "application/json", "user-agent": this.options.userAgent ?? MANAGED_SDK_USER_AGENT },
      body: JSON.stringify({ runRef, signals }),
    });
    const text = await response.text();
    if (response.status !== 202) throw refusalFrom(response.status, safeJson(text), response.headers.get("retry-after"));
    return JSON.parse(text) as { accepted: boolean; attributedTo: { tag: string; versionId: string; arm: string; minute: string } | null; rejected: Record<string, string> };
  }

  /** One managed run: streams under the hood, returns the assembled result. */
  async run(tag: string, variables: Record<string, string>, options: ManagedRunOptions = {}): Promise<ManagedRunResult> {
    const stream = await this.stream(tag, variables, options);
    for await (const _delta of stream) {
      /* drain */
    }
    return stream.result;
  }

  /** A workflow slot: the customer executes tools between steps and calls `step()` for each. */
  workflow(tag: string, options: { subject?: string } = {}) {
    const slot = this.catalogue.slots.find((s) => s.tag === tag);
    return {
      steps: slot?.steps ?? [],
      step: (stepId: string, variables: Record<string, string>, stepOptions: Omit<ManagedRunOptions, "subject" | "stepId"> = {}) => this.run(tag, variables, { ...stepOptions, ...(options.subject !== undefined ? { subject: options.subject } : {}), stepId }),
    };
  }

  /** The run as SSE: iterate the deltas, await `result`. */
  async stream(tag: string, variables: Record<string, string>, options: ManagedRunOptions = {}): Promise<ManagedRunStream> {
    const subjectHash = this.subjectHashFor(options.subject, tag);
    const body = JSON.stringify({
      tag,
      variables,
      stream: true,
      ...(subjectHash ? { subjectHash } : {}),
      ...(options.stepId ? { stepId: options.stepId } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/v1/agents/${encodeURIComponent(this.options.agentId)}/targets/${this.options.target}/run`;
    const headers = { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", accept: "text/event-stream", "user-agent": this.options.userAgent ?? MANAGED_SDK_USER_AGENT };
    const retries = this.options.maxRateLimitRetries ?? 2;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(url, { method: "POST", headers, body, ...(options.signal ? { signal: options.signal } : {}) });
      if (response.status === 200) return this.consume(response);
      const refusal = refusalFrom(response.status, safeJson(await response.text()), response.headers.get("retry-after"));
      if (response.status === 429 && attempt < retries) {
        attempt += 1;
        await sleep(Math.max(1, refusal.retryAfterSeconds ?? 1) * 1000);
        continue;
      }
      throw refusal;
    }
  }

  private consume(response: { headers: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; text(): Promise<string> }): ManagedRunStream {
    let resolveResult!: (r: ManagedRunResult) => void;
    let rejectResult!: (e: Error) => void;
    const result = new Promise<ManagedRunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // A rejection nobody awaits yet must not surface as unhandled; `result` is re-awaited by the caller.
    result.catch(() => {});
    const frames = parseSse(textChunks(response));
    const self = this;
    let settled = false;
    const iterable: ManagedRunStream = {
      result,
      async *[Symbol.asyncIterator]() {
        try {
          for await (const frame of frames) {
            if (frame.event === "delta") {
              yield (JSON.parse(frame.data) as { delta: string }).delta;
            } else if (frame.event === "done") {
              const done = JSON.parse(frame.data) as ManagedRunResult;
              if (done.generation !== self.catalogue.generation) {
                // A newer promotion answered: the catalogue may have new tags; read it lazily on the next call.
                self.catalogue = { ...self.catalogue, generation: done.generation };
              }
              settled = true;
              resolveResult(done);
            } else if (frame.event === "error") {
              const body = JSON.parse(frame.data) as { error: string; code: ManagedRefusalCode; detail?: string; retryAfterSeconds?: number };
              settled = true;
              rejectResult(new ManagedRunError(body.code, 200, body.error, body.detail, body.retryAfterSeconds));
              return;
            }
          }
          if (!settled) rejectResult(new ManagedRunError("internal", 200, "the stream ended without a done frame"));
        } catch (error) {
          if (!settled) rejectResult(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
    };
    return iterable;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}
