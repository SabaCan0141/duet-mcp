import type { Observed } from "./client-store.js";
import type { RunResult } from "./protocol.js";

export type EditState<Value> = {
  active: boolean;
  value: Value | undefined;
  pending: boolean;
  result: RunResult<unknown> | null;
  error: string | null;
};
/** 下書きと観測時の呼び口を一緒に保持する。行の外に置けば移動しても残る。 */
export class EditSession<Value> {
  private base: Observed<unknown> | null = null;
  private inflight: Promise<RunResult<unknown>> | null = null;
  private listeners = new Set<() => void>();
  private state: EditState<Value> = { active: false, value: undefined, pending: false, result: null, error: null };
  getSnapshot = (): EditState<Value> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(state: EditState<Value>): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private editable(): void { if (this.inflight) throw new Error("送信中は編集を変更できない。"); }
  begin = (base: Observed<unknown>, value: Value): void => {
    if (this.state.active) throw new Error("既に編集中。見直す場合は restart を使うこと。");
    this.restart(base, value);
  };
  restart = (base: Observed<unknown>, value: Value): void => {
    this.editable();
    this.base = base;
    this.update({ active: true, value, pending: false, result: null, error: null });
  };
  setValue = (value: Value): void => {
    this.editable();
    if (!this.base) throw new Error("編集を begin していない。");
    this.update({ ...this.state, value });
  };
  cancel = (): void => {
    this.editable();
    this.base = null;
    this.update({ active: false, value: undefined, pending: false, result: null, error: null });
  };
  run = (name: string, args?: Record<string, unknown>): Promise<RunResult<unknown>> => {
    if (this.inflight) return this.inflight;
    const base = this.base;
    if (!base) throw new Error("編集を begin していない。");
    // microtask で開始し、同期の二重呼び出しでも同じ Promise を返す。
    const promise = Promise.resolve().then(() => base.run(name, args)).then((result) => {
      if ("ok" in result) {
        this.base = null;
        this.update({ active: false, value: undefined, pending: false, result, error: null });
      } else this.update({ ...this.state, pending: false, result, error: null });
      return result;
    }, (err: unknown) => {
      this.update({ ...this.state, pending: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }).finally(() => { this.inflight = null; });
    this.inflight = promise;
    this.update({ ...this.state, pending: true, error: null });
    return promise;
  };
}
