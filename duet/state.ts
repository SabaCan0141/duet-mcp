import { randomUUID } from "node:crypto";
import { assertJson } from "./json.js";
import { daemonChanged, DuetError } from "./errors.js";
import type { DocAccess, ReadonlyDeep } from "./types.js";
export type HistoryEntry<D = any> = { revision: string; doc: D };
export type History<D = any> = { entries: HistoryEntry<D>[]; head: number };
export class State<D> implements DocAccess<D> {
  private history: History<D>;
  private updating = false;
  private active = true;
  private listeners = new Set<() => void>();
  seq: number;
  constructor(initial: D, private readonly validateState: (value: D) => void = () => {}, restored?: { revision: string; seq: number; history?: History<D> }, readonly maxLen = 1,
    private readonly changed?: (entry: HistoryEntry<D>, committed: boolean) => void) {
    if (!Number.isSafeInteger(maxLen) || maxLen < 1) throw new DuetError("InvalidMaxLen", "maxLen must be a positive safe integer");
    this.validate(initial);
    this.history = restored?.history ? structuredClone(restored.history) : { entries: [{ revision: restored?.revision ?? randomUUID(), doc: structuredClone(initial) }], head: 0 };
    if (restored?.history) for (const entry of this.history.entries) this.validate(entry.doc);
    this.seq = restored?.seq ?? 0;
  }
  private get current(): HistoryEntry<D> { return this.history.entries[this.history.head]; }
  get revision(): string { return this.current.revision; }
  assertActive(): void { if (!this.active) throw daemonChanged(); }
  deactivate(): void { this.active = false; }
  private validate(value: D): void {
    assertJson(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DuetError("InvalidDoc", "doc must be a JSON object");
    if (Object.hasOwn(value, "then")) throw new DuetError("NameCollision", "reserved state key: then");
    this.validateState(value);
  }
  get(): ReadonlyDeep<D> { this.assertActive(); return structuredClone(this.current.doc) as ReadonlyDeep<D>; }
  at(revision: string): ReadonlyDeep<D> | null {
    this.assertActive();
    const entry = this.history.entries.find(entry => entry.revision === revision);
    return entry ? structuredClone(entry.doc) as ReadonlyDeep<D> : null;
  }
  exportHistory(): History<D> { this.assertActive(); return structuredClone(this.history); }
  private checkWrite(): void {
    this.assertActive();
    if (this.updating) throw new DuetError("NestedUpdate", "doc changes cannot be nested");
    if (!Number.isSafeInteger(this.seq + 1)) throw new Error("state sequence exhausted");
  }
  private notify(committed: boolean): void {
    this.seq++;
    // Internal listeners only mark/wake. Engine schedules application callbacks separately.
    for (const listener of this.listeners) { try { listener(); } catch (error) { console.error(error); } }
    this.changed?.(structuredClone(this.current), committed);
  }
  private move(delta: number): boolean {
    this.checkWrite();
    const head = this.history.head + delta;
    if (head < 0 || head >= this.history.entries.length) return false;
    this.history.head = head; this.notify(false); return true;
  }
  undo(): boolean { return this.move(-1); }
  redo(): boolean { return this.move(1); }
  update<R>(change: (draft: D) => R & (R extends PromiseLike<unknown> ? never : unknown)): void {
    this.checkWrite();
    this.updating = true;
    try {
      const draft = structuredClone(this.current.doc);
      const result = change(draft);
      if (result && typeof (result as any).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new DuetError("AsyncUpdate", "doc.update must be synchronous");
      }
      this.validate(draft);
      const entries = this.history.entries.slice(0, this.history.head + 1);
      entries.push({ doc: structuredClone(draft), revision: randomUUID() });
      if (entries.length > this.maxLen) entries.splice(0, entries.length - this.maxLen);
      this.history = { entries, head: entries.length - 1 };
      this.notify(true);
    } finally { this.updating = false; }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
