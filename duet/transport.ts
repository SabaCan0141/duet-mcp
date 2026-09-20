import { PROTOCOL, type Envelope, type Hello } from "./protocol.js";
import { daemonChanged, DuetError } from "./errors.js";
export type ConnectionOptions = { url?: string; id?: string; version?: string; actor?: string; request?: typeof fetch };
export class Transport {
  ownerId?: string;
  private request: typeof fetch;
  constructor(readonly options: ConnectionOptions = {}) { this.request = options.request ?? ((...args) => fetch(...args)); }
  async hello(): Promise<Hello> {
    const response = await this.request(`${this.options.url ?? ""}/api/hello`, { signal: AbortSignal.timeout(5000) });
    const hello = await response.json() as Hello;
    if (!response.ok || hello.protocol !== PROTOCOL || (this.options.id && hello.id !== this.options.id) || (this.options.version && hello.version !== this.options.version)) throw new DuetError("ProtocolMismatch", "Incompatible app or protocol");
    if (!hello.ready || !hello.ownerId) throw new DuetError("NotReady");
    this.ownerId = hello.ownerId; return hello;
  }
  async call<T>(pathname: string, init?: RequestInit, envelope = false): Promise<T> {
    const hello = await this.hello();
    const headers = new Headers(init?.headers);
    headers.set("x-duet-owner", hello.ownerId); headers.set("x-duet-protocol", String(PROTOCOL));
    if (this.options.id) headers.set("x-duet-app-id", this.options.id);
    if (this.options.version) headers.set("x-duet-version", this.options.version);
    if (this.options.actor) headers.set("x-duet-actor", this.options.actor);
    let body: any;
    try {
      const response = await this.request(`${this.options.url ?? ""}${pathname}`, { ...init, headers });
      body = await response.json();
      if (body.ownerId && body.ownerId !== hello.ownerId) throw daemonChanged();
      if (!response.ok || body.ok === false) throw new DuetError(body.error?.code ?? "HttpError", body.error?.message ?? `HTTP ${response.status}`);
      if (this.ownerId !== hello.ownerId) throw daemonChanged();
    } catch (error) {
      if (error instanceof DuetError) throw error;
      // Diagnose only. Never replay an operation, observer mutation, wait, or one-shot read.
      try { if ((await this.hello()).ownerId !== hello.ownerId) throw daemonChanged(); }
      catch (diagnostic) { if (diagnostic instanceof DuetError && diagnostic.code === "DaemonChanged") throw diagnostic; }
      throw new DuetError("OutcomeUnknown", "The response could not be confirmed. No automatic retry was made.");
    }
    return (envelope ? (body as Envelope<T> & { ok: true }).result : body) as T;
  }
  op<T>(name: string, input?: unknown): Promise<T> {
    return this.call(`/api/op/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input === undefined ? {} : { input }) }, true);
  }
}
