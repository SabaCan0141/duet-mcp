import { parseRevision, type Snapshot, type RunResult } from "./protocol.js";
import { WAIT_MS } from "./wire.js";
export type Observed<Doc> = Snapshot<Doc> & {
  run(name: string, args?: Record<string, unknown>): Promise<RunResult<Doc>>;
};

function snapshot(value: unknown): Snapshot<unknown> {
  const s = value as Snapshot<unknown> | null;
  if (!s || !parseRevision(s.revision) || !("doc" in s) || typeof s.actor !== "string" ||
      !s.activity || typeof s.activity !== "object") throw new Error("snapshot の形ではない。GUI と daemon を同時に更新すること。");
  return s;
}

/** ブラウザで一つ共有する購読。React に依存せず応答の順序を管理する。 */
export class ClientStore {
  private current: Observed<unknown> | null = null;
  private listeners = new Set<() => void>();
  private running = false;
  private ctrl: AbortController | null = null;
  private polling: Promise<void> | null = null;
  private generation = 0;
  private pollVersion = 0;
  private force = false;
  private received = 0;
  private refreshWaiters: (() => void)[] = [];
  constructor(private readonly request: typeof fetch = (...args) => fetch(...args)) {}

  getSnapshot = (): Observed<unknown> | null => this.current;
  get receivedAt(): number { return this.received; }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.running = true;
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.running = false;
        this.pollVersion++;
        this.ctrl?.abort();
      }
    };
  };
  refresh = (): Promise<void> => {
    const done = new Promise<void>((resolve) => this.refreshWaiters.push(resolve));
    this.force = true;
    this.pollVersion++;
    this.ctrl?.abort();
    this.start();
    return done;
  };
  private emit(): void { for (const listener of this.listeners) listener(); }
  private start(): void {
    if (!this.running || this.polling) return;
    this.polling = this.loop().finally(() => {
      this.polling = null;
      if (this.running) this.start();
    });
  }

  private accept(s: Snapshot<unknown>, authoritative: boolean): void {
    const incoming = parseRevision(s.revision)!;
    const old = this.current && parseRevision(this.current.revision)!;
    if (old && incoming.epoch !== old.epoch) {
      if (!authoritative) { this.refresh(); return; }
      this.generation++;
    } else if (old && incoming.seq < old.seq) {
      // この取得より新しい完全な snapshot を既に受信している。
      if (authoritative) for (const resolve of this.refreshWaiters.splice(0)) resolve();
      return;
    }
    this.received = Date.now();
    const generation = this.generation;
    this.current = {
      ...s,
      // 固定した snapshot の版を送る。送信時の current は使わない。
      run: (name, args = {}) => this.run(s.revision, generation, name, args),
    };
    this.emit();
    if (authoritative) for (const resolve of this.refreshWaiters.splice(0)) resolve();
  }

  private async run(revision: string, generation: number, name: string, args: Record<string, unknown>): Promise<RunResult<unknown>> {
    let result: RunResult<unknown>;
    try {
      const res = await this.request(`/api/op/${encodeURIComponent(name)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...args, baseRevision: revision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      const s = snapshot(raw);
      if (!("ok" in s) && !("rejected" in s) && !("conflict" in s)) throw new Error("操作応答の形ではない");
      result = s as RunResult<unknown>;
    } catch {
      this.refresh();
      throw new Error("操作の結果を確認できない。自動再送していない。現在値を再取得して確認すること。");
    }
    if (generation !== this.generation) {
      throw new Error("応答を待つ間に daemon が交代した。現在値を確認すること。");
    }
    this.accept(result, false);
    return result;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.ctrl = new AbortController();
      const version = this.pollVersion;
      const since = this.force ? undefined : this.current?.revision;
      this.force = false;
      try {
        const q = since === undefined ? "" : `?since=${encodeURIComponent(since)}&timeout=${WAIT_MS}`;
        const res = await this.request(`/api/doc${q}`, { signal: this.ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = snapshot(await res.json());
        if (!this.running || version !== this.pollVersion) continue;
        this.accept(s, true);
      } catch {
        if (!this.running) break;
        if (version !== this.pollVersion) continue;
        // 再接続待ちも abort できるようにする。
        const signal = this.ctrl.signal;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 500);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  }
}
