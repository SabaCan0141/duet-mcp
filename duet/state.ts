import { randomUUID } from "node:crypto";
import { assertJson } from "./json.js";
import { daemonChanged, DuetError } from "./errors.js";
import type { DocAccess, ReadonlyDeep } from "./types.js";
export class State<D> implements DocAccess<D> {
  private value: D;
  private updating = false;
  private active = true;
  private listeners = new Set<() => void>();
  revision: string;
  seq: number;
  constructor(initial: D, private readonly validateState: (value: D) => void = () => {}, restored?: { revision: string; seq: number }) {
    this.validate(initial);
    this.value = structuredClone(initial);
    this.revision = restored?.revision ?? randomUUID(); this.seq = restored?.seq ?? 0;
  }
  assertActive(): void { if (!this.active) throw daemonChanged(); }
  deactivate(): void { this.active = false; }
  private validate(value: D): void {
    assertJson(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DuetError("InvalidDoc", "doc must be a JSON object");
    if (Object.hasOwn(value, "then")) throw new DuetError("NameCollision", "reserved state key: then");
    this.validateState(value);
  }
  get(): ReadonlyDeep<D> { this.assertActive(); return structuredClone(this.value) as ReadonlyDeep<D>; }
  update<R>(change: (draft: D) => R & (R extends PromiseLike<unknown> ? never : unknown)): void {
    this.assertActive();
    if (this.updating) throw new DuetError("NestedUpdate", "doc.update cannot be nested");
    this.updating = true;
    try {
      const draft = structuredClone(this.value);
      const result = change(draft);
      if (result && typeof (result as any).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new DuetError("AsyncUpdate", "doc.update must be synchronous");
      }
      this.validate(draft);
      if (!Number.isSafeInteger(this.seq + 1)) throw new Error("state sequence exhausted");
      this.value = structuredClone(draft); this.revision = randomUUID(); this.seq++;
      // Notify internally now; callbacks must only mark/wake, never execute app code.
      for (const listener of this.listeners) { try { listener(); } catch (error) { console.error(error); } }
    } finally { this.updating = false; }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
