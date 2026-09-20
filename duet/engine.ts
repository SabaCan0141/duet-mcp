import { randomUUID } from "node:crypto";
import { State } from "./state.js";
import { ObserverStore } from "./observers.js";
import { dispatch, validateOps } from "./operations.js";
import { PROTOCOL, type Snapshot, type Checkpoint } from "./protocol.js";
import { daemonChanged, DuetError } from "./errors.js";
import type { AppDef, Context } from "./types.js";
export class Engine<D = any> {
  readonly ownerId = randomUUID();
  readonly state: State<D>;
  readonly observers: ObserverStore;
  readonly controller = new AbortController();
  private checkpointSeq: number;
  private listeners = new Set<() => void>();
  private scheduled = false;
  private cleanup?: () => void | Promise<void>;
  private detachOwner = () => {};
  private stopped?: Promise<void>;
  private constructor(readonly app: AppDef<D>, initial: D, readonly url: string, checkpoint?: Checkpoint<D>) {
    const names = Object.keys(app.actions);
    this.state = new State(initial, value => {
      for (const name of names) if (Object.hasOwn(value as object, name)) throw new DuetError("NameCollision", `state key conflicts with operation: ${name}`);
    }, checkpoint);
    this.checkpointSeq = checkpoint?.checkpointSeq ?? 0;
    this.state.subscribe(() => this.changed());
    this.observers = new ObserverStore(this.state, () => this.changed(), checkpoint?.observers);
  }
  static async create<D>(app: AppDef<D>, url: string, checkpoint?: Checkpoint<D>, ownerSignal?: AbortSignal): Promise<Engine<D>> {
    validateOps(app);
    const initial = checkpoint ? checkpoint.doc : await app.initialDoc();
    if (ownerSignal?.aborted) throw daemonChanged();
    const engine = new Engine(app, initial, url, checkpoint);
    const lost = () => { void engine.stop().catch(error => console.error(error)); };
    ownerSignal?.addEventListener("abort", lost, { once: true });
    engine.detachOwner = () => ownerSignal?.removeEventListener("abort", lost);
    try {
      const cleanup = await app.setup?.(engine.context());
      if (engine.controller.signal.aborted) {
        if (cleanup) await cleanup();
        throw daemonChanged();
      }
      engine.cleanup = cleanup || undefined;
      return engine;
    } catch (error) { await engine.stop(); throw error; }
  }
  private changed(): void {
    this.checkpointSeq++;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const listener of this.listeners) { try { listener(); } catch (err) { console.error(err); } }
    });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot(): Snapshot<D> { return { ownerId: this.ownerId, revision: this.state.revision, seq: this.state.seq, doc: this.state.get() as D }; }
  checkpoint(): Checkpoint<D> { return { ...this.snapshot(), protocol: PROTOCOL, appId: this.app.id, appVersion: this.app.version, checkpointSeq: this.checkpointSeq, observers: this.observers.export() }; }
  context(actor = "system", signal?: AbortSignal): Context<D> {
    return { doc: this.state, observers: this.observers, signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal, actor, url: this.url, snapshot: () => this.snapshot() };
  }
  run(name: string, input?: unknown, actor?: string, signal?: AbortSignal): Promise<unknown> { return dispatch(this.app, this.context(actor, signal), name, input); }
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    // Revoke writes synchronously, before any asynchronous resource cleanup.
    this.controller.abort(daemonChanged()); this.observers.stop(); this.state.deactivate();
    this.detachOwner(); this.listeners.clear();
    this.stopped = Promise.resolve().then(() => this.cleanup?.());
    return this.stopped;
  }
}
