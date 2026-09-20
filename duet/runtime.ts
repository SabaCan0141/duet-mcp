import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { Engine } from "./engine.js";
import { createHttpApp, type Host } from "./http.js";
import { PROTOCOL, type Checkpoint, type Hello } from "./protocol.js";
import { consumeEvents } from "./sse.js";
import { baseUrlFor, portFor } from "./wire.js";
import { DuetError } from "./errors.js";
import { assertJson } from "./json.js";
import { validateOps } from "./operations.js";
import type { AppDef } from "./types.js";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function validateCheckpoint(value: any, app: AppDef): asserts value is Checkpoint {
  if (!value || value.protocol !== PROTOCOL || value.appId !== app.id || value.appVersion !== app.version ||
      typeof value.ownerId !== "string" || !value.ownerId || typeof value.revision !== "string" || !value.revision ||
      !Number.isSafeInteger(value.seq) || value.seq < 0 || !Number.isSafeInteger(value.checkpointSeq) || value.checkpointSeq < 0 ||
      !Array.isArray(value.observers) || !value.doc || typeof value.doc !== "object" || Array.isArray(value.doc)) throw new DuetError("InvalidCheckpoint");
  const ids = new Set<string>();
  for (const entry of value.observers) {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || (entry.revision !== null && typeof entry.revision !== "string")) throw new DuetError("InvalidCheckpoint");
    ids.add(entry.id);
  }
  assertJson(value.doc);
}
export class Runtime {
  readonly host: Host;
  private server?: Server;
  private checkpoint?: Checkpoint;
  private followed = false;
  private stopped = false;
  private stopping?: Promise<void>;
  private controller = new AbortController();
  private loop?: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: unknown) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  private constructor(readonly app: AppDef) { this.host = { url: baseUrlFor(app.id, app.port), ready: false }; }
  static async start(app: AppDef): Promise<Runtime> {
    validateOps(app);
    if (app.port === undefined && process.env.DUET_PORT) console.error("[duet] DUET_PORT is deprecated; set app.port instead.");
    const runtime = new Runtime(app);
    runtime.loop = runtime.monitor().catch(async error => { runtime.readyReject(error); console.error("[duet] runtime failed:", error); await runtime.stop(); });
    try { await runtime.ready; return runtime; } catch (error) { await runtime.stop(); throw error; }
  }
  get url(): string { return this.host.url; }
  get isOwner(): boolean { return !!this.host.engine && this.host.ready; }
  private async bind(): Promise<boolean> {
    const http = createHttpApp(this.app, this.host);
    const server = await new Promise<Server | undefined>((resolve, reject) => {
      const s = serve({ fetch: http.fetch, hostname: "127.0.0.1", port: portFor(this.app.id, this.app.port) }) as Server;
      s.once("error", (err: NodeJS.ErrnoException) => { if (err.code === "EADDRINUSE") resolve(undefined); else reject(err); });
      s.once("listening", () => resolve(s));
    });
    if (!server) return false;
    if (this.stopped) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      return true;
    }
    this.server = server;
    if (this.followed && !this.checkpoint) throw new DuetError("HandoffUnavailable", "No complete checkpoint was received");
    this.host.engine = await Engine.create(this.app, this.url, this.checkpoint, this.controller.signal);
    if (this.stopped) { await this.host.engine.stop(); return true; }
    this.host.ready = true; this.readyResolve();
    console.error(`[duet] daemon ${this.url} owner=${this.host.engine.ownerId}`);
    return true;
  }
  private async monitor(): Promise<void> {
    const startupDeadline = Date.now() + 30_000;
    let started = false;
    while (!this.stopped) {
      if (await this.bind()) return;
      this.followed = true;
      try {
        const res = await fetch(`${this.url}/api/hello`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) throw new DuetError("WrongApp", "Port is not a duet daemon");
        let hello: Hello; try { hello = await res.json() as Hello; } catch { throw new DuetError("WrongApp", "Port is not a duet daemon"); }
        if (hello.id !== this.app.id) throw new DuetError("WrongApp", "Port belongs to another app");
        if (hello.protocol !== PROTOCOL) throw new DuetError("ProtocolMismatch");
        if (hello.version !== this.app.version) throw new DuetError("VersionMismatch");
        if (!hello.ready) { if (!started && Date.now() > startupDeadline) throw new DuetError("StartupTimeout"); await pause(100); continue; }
        const connection = new AbortController();
        const signal = AbortSignal.any([connection.signal, this.controller.signal]);
        let last = Date.now();
        const timer = setInterval(() => { if (Date.now() - last > 3000) connection.abort(); }, 500);
        try {
          const response = await fetch(`${this.url}/internal/replica`, { signal, headers: { "x-duet-app-id": this.app.id, "x-duet-protocol": String(PROTOCOL), "x-duet-version": this.app.version } });
          await consumeEvents(response, value => {
            validateCheckpoint(value, this.app);
            if (value.ownerId !== hello.ownerId) throw new DuetError("DaemonChanged");
            if (this.checkpoint?.ownerId === value.ownerId && value.checkpointSeq < this.checkpoint.checkpointSeq) return;
            this.checkpoint = value; started = true; this.readyResolve();
          }, signal, () => { last = Date.now(); });
        } finally { clearInterval(timer); connection.abort(); }
      } catch (error) {
        if (error instanceof DuetError && ["WrongApp", "VersionMismatch", "ProtocolMismatch", "InvalidCheckpoint", "StartupTimeout"].includes(error.code)) throw error;
        if (!started && Date.now() > startupDeadline) throw new DuetError("StartupTimeout");
      }
      if (!this.stopped) await pause(20 + Math.random() * 80);
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true; this.host.ready = false;
    this.controller.abort();
    this.stopping = (async () => {
      try { await this.host.engine?.stop(); }
      finally {
        if (this.server) {
          this.server.closeAllConnections();
          await new Promise<void>(resolve => this.server!.close(() => resolve()));
        }
      }
    })();
    return this.stopping;
  }

}
export const startRuntime = (app: AppDef): Promise<Runtime> => Runtime.start(app);
