import { randomUUID } from "node:crypto";
import { abortError, daemonChanged, DuetError } from "./errors.js";
import type { State } from "./state.js";
export class ObserverStore {
  private records = new Map<string, string | null>();
  private waiters = new Set<{ id: string; finish: (error?: Error, changed?: boolean) => void }>();
  constructor(private state: State<any>, private changed: () => void, records: Array<{id: string; revision: string | null}> = []) {
    for (const entry of records) this.records.set(entry.id, entry.revision);
    state.subscribe(() => { for (const waiter of [...this.waiters]) waiter.finish(undefined, true); });
  }
  private require(id: string): void {
    this.state.assertActive();
    if (!this.records.has(id)) throw new DuetError("ObserverNotFound", `Unknown observer: ${id}`);
  }
  getObserverID(): string { this.state.assertActive(); const id = randomUUID(); this.records.set(id, null); this.changed(); return id; }
  dispose(id: string): void {
    this.require(id); this.records.delete(id); this.changed();
    for (const waiter of [...this.waiters]) if (waiter.id === id) waiter.finish(new DuetError("ObserverNotFound", `Disposed observer: ${id}`));
  }
  observe(id: string): void { this.require(id); this.records.set(id, this.state.revision); this.changed(); }
  isCurrent(id: string): boolean { this.require(id); return this.records.get(id) === this.state.revision; }
  export(): Array<{id: string; revision: string | null}> { return [...this.records].map(([id, revision]) => ({ id, revision })); }
  stop(): void { for (const waiter of [...this.waiters]) waiter.finish(daemonChanged()); }
  async waitChange(id: string, timeoutMs = 10_000, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    this.require(id);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new DuetError("InvalidTimeout", "timeoutMs must be an integer from 0 to 2147483647");
    if (options.signal?.aborted) throw abortError();
    if (!this.isCurrent(id)) return true;
    if (!timeoutMs) return false;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, changed = false) => {
        if (done) return; done = true; clearTimeout(timer); this.waiters.delete(waiter);
        options.signal?.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(changed);
      };
      const aborted = () => finish(abortError());
      const waiter = { id, finish };
      const timer = setTimeout(() => finish(), timeoutMs);
      this.waiters.add(waiter); options.signal?.addEventListener("abort", aborted, { once: true });
    });
  }
}
