/**
 * The SDK's side of `protocol/daemon-socket.md`: connect to the host's
 * `airprompterd`, `hello`, fetch the active slot, listen for `generation`
 * events, forward unlock / rollback / sync. Absent socket → `null`, and
 * the runtime syncs in-process instead.
 *
 * @example
 * ```ts
 * const socketPath = daemonSocketPath({ stateDir, agentId, target: "prod" });
 * const daemon = await DaemonClient.connect({ socketPath, agentId, target: "prod", sdk: "agent-sdk-ts/0.2.13" });
 * if (daemon === null) return syncInProcess(); // no daemon on this host
 * const active = await daemon.slot(); // the verified release the daemon holds: manifest, payloads, lease
 * daemon.onEvent((event) => { if (event.event === "generation") reload(); });
 * ```
 */

import { createHash } from "node:crypto";
import { errorNamed } from "@airprompter/agent-core";
import { existsSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Manifest, Target } from "@airprompter/agent-core";
import type { LoadedSlot } from "../store/slotStore.js";
import { SlotStore } from "../store/slotStore.js";

export const DAEMON_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface DaemonHello {
  daemon: string;
  protocol: string;
  agentId: string;
  target: Target;
  instanceId: string;
  /** S6: the store's id — the seed of the runRef key every process on the host shares. An older daemon omits it. */
  storeId?: string;
  generation: number;
  stagedGeneration: number | null;
}

export interface DaemonSlotResponse {
  slot: "A" | "B";
  generation: number;
  signingKeyId: string;
  manifest: Manifest;
  payloads: Array<{ contentHash: string; bytes: string }>;
  /** S3: the daemon's lease — when its last contact with the origin runs out; null before any contact. */
  leaseExpiresAt?: string | null;
  /** S4: the apply policy the daemon's host runs under (the store's pin, or the daemon's own local policy). */
  applyPolicy?: DaemonApplyPolicy;
}

/** S4: what the daemon says about the host's apply policy; the same shape as `AgentStatus.applyPolicy`. */
export interface DaemonApplyPolicy {
  effective: "auto" | "unlock_required";
  source: "local" | "pinned" | "operator" | "manifest";
  manifestSaid: "auto" | "unlock_required" | null;
}

/** S4: an operator set the host's apply policy through the daemon (`airprompter policy set`); attached SDKs adopt it. */
export interface DaemonPolicyEvent {
  event: "policy";
  applyPolicy: DaemonApplyPolicy;
}

/** S3: the daemon's contact with the origin renewed; attached SDKs adopt the lease. */
export interface DaemonLeaseEvent {
  event: "lease";
  expiresAt: string | null;
  lastContactAt: string;
}

export interface DaemonGenerationEvent {
  event: "generation";
  generation: number;
  stagedGeneration: number | null;
}

export type DaemonErrorCode = "absent" | "not_owner" | "scope_mismatch" | "refused" | "protocol" | "closed";

export class DaemonError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
    /** The daemon's own reason for a refusal when it named one (a store error code such as `release_staged`). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

/** `DaemonError` by name and code — true across duplicated package copies. */
export function isDaemonError(error: unknown): error is DaemonError {
  return errorNamed<DaemonErrorCode>(error, "DaemonError");
}

/** Unix socket paths are capped (104 bytes on macOS, 108 on Linux); longer store paths use the per-user runtime directory. */
export const UNIX_SOCKET_PATH_MAX = 100;

/** Where the daemon for this store listens (see daemon-socket.md). */
export function daemonSocketPath(input: { stateDir: string; agentId: string; target: Target }): string {
  const storeDir = SlotStore.path(input);
  const hash = createHash("sha256").update(storeDir, "utf8").digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\airprompter-${hash}`;
  const inStore = join(storeDir, "daemon.sock");
  if (Buffer.byteLength(inStore) <= UNIX_SOCKET_PATH_MAX) return inStore;
  // $XDG_RUNTIME_DIR and macOS $TMPDIR are per-user 0700 directories; a shared /tmp is the last resort.
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? tmpdir();
  return join(runtimeDir, `airprompter-${hash}.sock`);
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

export class DaemonClient {
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
  private readonly closeListeners = new Set<() => void>();

  private constructor(
    private readonly socket: Socket,
    readonly hello: DaemonHello,
  ) {}

  /** Connects and says hello. `null` when there is no daemon (absent socket, refused connection); throws only for a daemon that answers wrongly. */
  static async connect(input: { socketPath: string; agentId: string; target: Target; sdk: string; timeoutMs?: number }): Promise<DaemonClient | null> {
    if (process.platform !== "win32") {
      if (!existsSync(input.socketPath)) return null;
      // A socket another user could have planted is not ours to trust.
      const owner = statSync(input.socketPath).uid;
      if (typeof process.getuid === "function" && owner !== process.getuid()) throw new DaemonError("not_owner", `${input.socketPath} is owned by uid ${owner}, not this process`);
    }
    const socket = await new Promise<Socket | null>((resolve) => {
      const connection = createConnection(input.socketPath);
      const timer = setTimeout(() => {
        connection.destroy();
        resolve(null);
      }, input.timeoutMs ?? 2000);
      connection.once("connect", () => {
        clearTimeout(timer);
        resolve(connection);
      });
      connection.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (!socket) return null;
    socket.setEncoding("utf8");
    const client = new DaemonClient(socket, { daemon: "", protocol: "", agentId: input.agentId, target: input.target, instanceId: "", generation: 0, stagedGeneration: null });
    client.attach();
    let hello: DaemonHello;
    try {
      hello = (await client.request("hello", { sdk: input.sdk })) as unknown as DaemonHello;
    } catch (error) {
      client.close();
      throw isDaemonError(error) ? error : new DaemonError("protocol", (error as Error).message);
    }
    if (hello.agentId !== input.agentId || hello.target !== input.target) {
      client.close();
      throw new DaemonError("scope_mismatch", `daemon serves ${hello.agentId}/${hello.target}, this runtime is ${input.agentId}/${input.target}`);
    }
    Object.assign(client.hello, hello);
    return client;
  }

  private attach(): void {
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > DAEMON_MAX_LINE_BYTES) {
        this.fail(new DaemonError("protocol", "line too long"));
        return;
      }
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.handleLine(line);
        index = this.buffer.indexOf("\n");
      }
    });
    this.socket.on("error", (error) => this.fail(new DaemonError("closed", error.message)));
    this.socket.on("close", () => this.fail(new DaemonError("closed", "daemon closed the connection")));
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.fail(new DaemonError("protocol", "daemon sent a line that is not JSON"));
      return;
    }
    if (typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok === true) pending.resolve(message);
      else pending.reject(new DaemonError("refused", String(message.error ?? "refused"), typeof message.reason === "string" ? message.reason : undefined));
      return;
    }
    if (typeof message.event === "string") for (const listener of this.listeners) listener(message);
  }

  private fail(error: DaemonError): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.socket.destroy();
    for (const listener of this.closeListeners) listener();
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new DaemonError("closed", "daemon connection is closed"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  async slot(): Promise<LoadedSlot & { leaseExpiresAt: string | null; applyPolicy: DaemonApplyPolicy | null }> {
    const response = (await this.request("slot")) as unknown as DaemonSlotResponse;
    return {
      slot: response.slot,
      generation: response.generation,
      signingKeyId: response.signingKeyId,
      manifest: response.manifest,
      payloads: new Map(response.payloads.map((entry) => [entry.contentHash, Buffer.from(entry.bytes, "base64url")])),
      // S3: the daemon's lease rides the slot answer; an older daemon says nothing and the SDK keeps what it had.
      leaseExpiresAt: typeof response.leaseExpiresAt === "string" ? response.leaseExpiresAt : null,
      applyPolicy: response.applyPolicy && typeof response.applyPolicy === "object" && (response.applyPolicy.effective === "auto" || response.applyPolicy.effective === "unlock_required") ? response.applyPolicy : null,
    };
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}
