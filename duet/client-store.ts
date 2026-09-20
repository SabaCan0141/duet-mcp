import { daemonChanged } from "./errors.js";
import { Transport, type ConnectionOptions } from "./transport.js";
import { consumeEvents } from "./sse.js";
import { assertJson } from "./json.js";
import type { Snapshot } from "./protocol.js";
export class ClientStore {
  readonly transport: Transport;
  private current: any = null;
  private last?: Snapshot;
  private methods: Record<string, (input?: unknown) => Promise<unknown>> = Object.create(null);
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private generation = 0;
  constructor(private options: ConnectionOptions = {}) { this.transport = new Transport(options); }
  getSnapshot = (): any => this.current;
  getMeta = (): Snapshot | undefined => this.last;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.controller) { this.controller = new AbortController(); void this.loop(this.controller.signal, ++this.generation); }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.generation++; this.controller?.abort(); this.controller = undefined; } };
  };
  private async manifest(): Promise<string> {
    const manifest = await this.transport.call<{names: string[]; ownerId: string}>("/api/manifest");
    for (const name of Object.keys(this.methods)) if (!manifest.names.includes(name)) delete this.methods[name];
    for (const name of manifest.names) if (!Object.hasOwn(this.methods, name)) this.methods[name] = (input?: unknown) => {
      if (input !== undefined) assertJson(input, "/input");
      return this.transport.op(name, input);
    };
    return manifest.ownerId;
  }
  private decorate(snap: Snapshot): any {
    if (!snap || typeof snap.ownerId !== "string" || typeof snap.revision !== "string" || !Number.isSafeInteger(snap.seq) || !snap.doc || typeof snap.doc !== "object" || Array.isArray(snap.doc)) throw new Error("Invalid snapshot");
    assertJson(snap.doc);
    const doc = structuredClone(snap.doc);
    for (const [name, method] of Object.entries(this.methods)) {
      if (Object.hasOwn(doc, name)) throw new Error(`State/op collision: ${name}`);
      Object.defineProperty(doc, name, { value: method, enumerable: false });
    }
    return freeze(doc);
  }
  async getDoc(): Promise<any> { const owner = await this.manifest(); const snapshot = await this.transport.call<Snapshot>("/api/doc"); if (snapshot.ownerId !== owner) throw daemonChanged(); return this.decorate(snapshot); }
  getObserverID = (): Promise<string> => this.transport.call("/api/observers", {method: "POST"}, true);
  disposeObserver = (id: string): Promise<void> => this.transport.call(`/api/observers/${encodeURIComponent(id)}`, {method: "DELETE"}, true);
  private async loop(signal: AbortSignal, generation: number): Promise<void> {
    const request = this.options.request ?? fetch;
    while (!signal.aborted && generation === this.generation) {
      const attempt = new AbortController(); const connection = AbortSignal.any([signal, attempt.signal]);
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        const expectedOwner = await this.manifest();
        let lastActivity = Date.now();
        timer = setInterval(() => { if (Date.now() - lastActivity > 4000) attempt.abort(); }, 1000);
        const response = await request(`${this.options.url ?? ""}/api/events`, {signal: connection, headers: { "x-duet-owner": expectedOwner, ...(this.options.id ? {"x-duet-app-id": this.options.id} : {}) }});
        let owner: string | undefined;
        await consumeEvents(response, (snapshot: Snapshot) => {
          if (generation !== this.generation || signal.aborted) return;
          if (owner && owner !== snapshot.ownerId) throw new Error("Owner changed within a stream");
          owner = snapshot.ownerId;
          if (this.last?.ownerId === owner && snapshot.seq <= this.last.seq) return;
          this.current = this.decorate(snapshot); this.last = snapshot; this.transport.ownerId = owner;
          for (const listener of this.listeners) listener();
        }, connection, () => { lastActivity = Date.now(); });
      } catch { /* Keep the last snapshot while reconnecting. */ }
      finally { clearInterval(timer); attempt.abort(); }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 300); signal.addEventListener("abort", done, {once: true}); if (signal.aborted) done();
      });
    }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
