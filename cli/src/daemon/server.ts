/**
 * `airprompterd`: the socket side of `protocol/daemon-socket.md`. One
 * `AirPrompterAgent` in resident mode owns the store and the sync loop;
 * this server hands its verified release to attached SDK processes over a
 * 0600 local socket, forwards unlock / rollback / sync, pushes
 * `generation` events, and answers `GET /healthz` for probes.
 */

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import type { AirPrompterAgent } from "../../../sdk-typescript/src/agent.js";
import { DAEMON_MAX_LINE_BYTES } from "../../../sdk-typescript/src/sync/daemon.js";
import type { SpoolUploader, UploaderStatus } from "../../../sdk-typescript/src/telemetry/uploader.js";

export interface DaemonStatus {
  daemon: string;
  protocol: string;
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  socketPath: string;
  clients: number;
  rssBytes: number;
  agentId: string;
  target: string;
  instanceId: string;
  generation: number;
  stagedGeneration: number | null;
  applyState: string;
  lastRefusal: string | null;
  storageProtection: string;
  signingKeyId: string | null;
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  lastContactAt: string | null;
  lastSyncAt: string | null;
  lastSyncOutcome: string | null;
  consecutiveFailures: number;
  nextSyncAt: string | null;
  spool: { depthSegments: number; depthBytes: number };
  /** T26 P4: the uploader — null when the daemon has no key (offline: the spool is the export). */
  upload: UploaderStatus | null;
}

export interface DaemonServerOptions {
  socketPath: string;
  version: string;
  protocol: string;
  agentId: string;
  target: string;
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
  uploader?: SpoolUploader | null;
}

export class DaemonServer {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private readonly startedMs: number;
  private detachChange: (() => void) | null = null;

  constructor(
    private readonly agent: AirPrompterAgent,
    private readonly options: DaemonServerOptions,
  ) {
    this.startedMs = options.now?.() ?? Date.now();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(event: Record<string, unknown>): void {
    this.options.logger?.(event);
  }

  /** Refuses when another daemon answers on the socket; removes a stale socket file nobody answers on. */
  async listen(): Promise<void> {
    if (process.platform !== "win32" && existsSync(this.options.socketPath)) {
      const alive = await new Promise<boolean>((resolve) => {
        const probe = createConnection(this.options.socketPath);
        const timer = setTimeout(() => {
          probe.destroy();
          resolve(false);
        }, 1000);
        probe.once("connect", () => {
          clearTimeout(timer);
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (alive) throw new Error(`another daemon is listening on ${this.options.socketPath}`);
      unlinkSync(this.options.socketPath);
      this.log({ event: "stale_socket_removed", socketPath: this.options.socketPath });
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") chmodSync(this.options.socketPath, 0o600);
    this.detachChange = this.agent.onChange((change) => this.broadcast({ event: "generation", generation: change.generation, stagedGeneration: change.stagedGeneration }));
    this.log({ event: "listening", socketPath: this.options.socketPath });
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let mode: "unknown" | "ndjson" | "http" = "unknown";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > DAEMON_MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (mode === "unknown") mode = /^GET \/healthz(?:\?\S*)? HTTP\/1\.[01]$/.test(line) ? "http" : "ndjson";
        if (mode === "http") {
          this.answerHealthz(socket);
          return;
        }
        if (line.trim()) void this.handle(socket, line);
        index = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => this.clients.delete(socket));
    socket.on("close", () => this.clients.delete(socket));
  }

  private answerHealthz(socket: Socket): void {
    const status = this.agent.status();
    const healthy = status.generation > 0;
    const upload = this.options.uploader?.status() ?? null;
    const body = JSON.stringify({ ok: healthy, generation: status.generation, stagedGeneration: status.stagedGeneration, leaseExpired: status.leaseExpired, lastSyncAt: status.lastSyncAt, lastSyncOutcome: status.lastSyncOutcome, spoolDepth: upload?.depth.segments ?? status.spool.depthSegments, lastUploadAt: upload?.lastUploadAt ?? null, backoffUntil: upload?.backoffUntil ?? null });
    socket.end(`HTTP/1.1 ${healthy ? "200 OK" : "503 Service Unavailable"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }

  private send(socket: Socket, message: Record<string, unknown>): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const client of this.clients) this.send(client, message);
  }

  private async handle(socket: Socket, line: string): Promise<void> {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      socket.destroy();
      return;
    }
    if (typeof request !== "object" || request === null || typeof request.id !== "string" || typeof request.op !== "string") {
      socket.destroy();
      return;
    }
    const id = request.id;
    try {
      this.send(socket, { id, ok: true, ...(await this.dispatch(request.op, request)) });
    } catch (error) {
      this.send(socket, { id, ok: false, error: (error as Error).message });
    }
  }

  private async dispatch(op: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const status = this.agent.status();
    switch (op) {
      case "hello":
        this.log({ event: "client_attached", sdk: typeof request.sdk === "string" ? request.sdk.slice(0, 64) : null, clients: this.clients.size });
        return { daemon: `airprompter-cli/${this.options.version}`, protocol: this.options.protocol, agentId: this.options.agentId, target: this.options.target, instanceId: status.instanceId, generation: status.generation, stagedGeneration: status.stagedGeneration };
      case "slot": {
        const release = this.agent.release;
        if (!release) throw new Error("no_verified_release");
        return { slot: release.slot, generation: release.generation, signingKeyId: release.signingKeyId, manifest: release.manifest, payloads: [...release.payloads].map(([contentHash, bytes]) => ({ contentHash, bytes: Buffer.from(bytes).toString("base64url") })) };
      }
      case "status":
        return this.status() as unknown as Record<string, unknown>;
      case "sync":
        await this.agent.syncNow();
        return { outcome: this.agent.status().lastSyncOutcome };
      case "unlock": {
        const result = await this.agent.unlock();
        this.log({ event: "unlock", generation: result?.generation ?? null });
        return { generation: result?.generation ?? null };
      }
      case "rollback": {
        const result = await this.agent.rollback();
        this.log({ event: "rollback", generation: result.generation, forced: result.forced });
        return { generation: result.generation, forced: result.forced };
      }
      case "healthz": {
        const upload = this.options.uploader?.status() ?? null;
        return { ok: status.generation > 0, generation: status.generation, leaseExpired: status.leaseExpired, lastSyncAt: status.lastSyncAt, spoolDepth: upload?.depth.segments ?? status.spool.depthSegments, lastUploadAt: upload?.lastUploadAt ?? null, backoffUntil: upload?.backoffUntil ?? null };
      }
      case "upload": {
        // An operator's `airprompter upload`: one pass now, whatever the cadence says.
        const uploader = this.options.uploader;
        if (!uploader) throw new Error("offline");
        const result = await uploader.runOnce();
        return { uploaded: result.uploaded.length, quarantined: result.quarantined.length, dropped: result.dropped, held: result.held, ...uploader.status() };
      }
      default:
        throw new Error("unknown_op");
    }
  }

  status(): DaemonStatus {
    const status = this.agent.status();
    return {
      daemon: `airprompter-cli/${this.options.version}`,
      protocol: this.options.protocol,
      pid: process.pid,
      startedAt: new Date(this.startedMs).toISOString(),
      uptimeSeconds: Math.floor((this.now() - this.startedMs) / 1000),
      socketPath: this.options.socketPath,
      clients: this.clients.size,
      rssBytes: process.memoryUsage().rss,
      agentId: this.options.agentId,
      target: this.options.target,
      instanceId: status.instanceId,
      generation: status.generation,
      stagedGeneration: status.stagedGeneration,
      applyState: status.applyState,
      lastRefusal: status.lastRefusal,
      storageProtection: status.storageProtection,
      signingKeyId: status.signingKeyId,
      leaseExpiresAt: status.leaseExpiresAt,
      leaseExpired: status.leaseExpired,
      lastContactAt: status.lastContactAt,
      lastSyncAt: status.lastSyncAt,
      lastSyncOutcome: status.lastSyncOutcome,
      consecutiveFailures: status.consecutiveSyncFailures,
      nextSyncAt: status.nextSyncAt,
      spool: status.spool,
      upload: this.options.uploader?.status() ?? null,
    };
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async close(): Promise<void> {
    this.detachChange?.();
    this.broadcast({ event: "shutdown" });
    for (const client of this.clients) client.end();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32" && existsSync(this.options.socketPath)) unlinkSync(this.options.socketPath);
    this.log({ event: "closed" });
  }
}
