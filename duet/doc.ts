import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertJson, changes } from "./diff.js";
import { inputShape } from "./op.js";
import { dataDirFor } from "./paths.js";
import { parseRevision, type Revision, type Snapshot, type RunResult, type WaitResult, type Diff, type Change } from "./protocol.js";
import type { Actor, AppDef } from "./types.js";
export type { RunResult, WaitResult, Diff, Change } from "./protocol.js";

const LOG_LIMIT = 1000;
const CHANGE_LIMIT = 100;
const CHANGE_BYTES = 32 * 1024;
const LOG_FILE_MAX = 4 * 1024 * 1024;
type Event = { seq: number; revision: Revision; op: string; actor: Actor; args: unknown; touched: string[] };
class Rejection extends Error {}

/** snapshot が確定状態。ログは説明用であり、操作の可否に使わない。 */
export class DocStore<Doc> {
  readonly file: string;
  readonly logFile: string;
  private readonly epoch = randomUUID();
  private seq = 0;
  private oldest = 0;
  private state: Doc;
  private readonly schemas = new Map<string, z.AnyZodObject>();
  private readonly waiters = new Set<() => void>();
  private readonly seen = new Map<Actor, number>();
  private log: Event[] = [];

  constructor(private readonly app: AppDef<Doc>, private readonly dataDir = dataDirFor(app)) {
    this.file = path.join(dataDir, `${app.id}.json`);
    this.logFile = path.join(dataDir, `${app.id}.log`);
    this.state = app.initialDoc();
    assertJson(this.state);
    this.load();
    this.oldest = this.seq;
    for (const op of app.ops) {
      if (this.schemas.has(op.name)) throw new Error(`duplicate op: ${op.name}`);
      this.schemas.set(op.name, z.object(inputShape(op)));
    }
  }

  get revision(): Revision { return `${this.epoch}:${this.seq}`; }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    let raw: { revision: number; doc: Doc; version?: string };
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !("doc" in raw)) {
        throw new Error("snapshot の形ではない");
      }
      assertJson(raw.doc);
    } catch (err) {
      const stamp = Date.now();
      // 退避できなければ起動を止める。元ファイルを初期値で潰さない。
      fs.renameSync(this.file, `${this.file}.corrupt.${stamp}`);
      if (fs.existsSync(this.logFile)) fs.renameSync(this.logFile, `${this.logFile}.corrupt.${stamp}`);
      console.error("[duet] snapshot を退避した", err);
      return;
    }
    if (raw.version !== undefined && raw.version !== this.app.version) {
      const backup = `${this.file}.version.${Date.now()}.${randomUUID()}.bak`;
      fs.copyFileSync(this.file, backup);
      console.error(`[duet] version ${raw.version} → ${this.app.version}。移行が必要なら ${backup} を使う。`);
    }
    this.seq = raw.revision;
    this.state = raw.doc;
  }

  private persist(seq: number, doc: Doc): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ revision: seq, version: this.app.version, doc }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 保存前の失敗。元ファイルは残す。 */ }
      throw err;
    }
  }

  private appendLog(event: Event): void {
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > LOG_FILE_MAX) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
      fs.appendFileSync(this.logFile, `${JSON.stringify(event)}\n`);
    } catch (err) {
      // snapshot は確定済み。ログの失敗を操作の失敗に変えない。
      console.error("[duet] 操作は保存済み。補助ログを書けなかった。", err);
    }
  }

  touch(actor: Actor): void { this.seen.set(actor, Date.now()); }
  snapshot(actor: Actor): Snapshot<Doc> {
    const now = Date.now();
    return {
      revision: this.revision, actor, doc: structuredClone(this.state),
      activity: Object.fromEntries([...this.seen].map(([who, time]) => [who, now - time])),
    };
  }

  run(name: string, args: unknown, actor: Actor): RunResult<Doc> {
    const op = this.app.ops.find((o) => o.name === name);
    if (!op) throw new Error(`unknown op: ${name}`);
    const parsed = this.schemas.get(name)!.safeParse(args ?? {});
    if (!parsed.success) return {
      ...this.snapshot(actor), rejected: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
    };
    const { baseRevision, ...rest } = parsed.data;
    if (baseRevision !== this.revision) return {
      ...this.snapshot(actor), conflict: true, ...this.diff(baseRevision),
    };
    this.touch(actor);
    const draft = structuredClone(this.state);
    let result;
    try {
      result = op.handler({ doc: draft, actor, reject: (reason): never => { throw new Rejection(reason); } }, rest);
      if (result !== null && (typeof result === "object" || typeof result === "function") &&
          typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error(`op ${name}: handler は同期処理に限定する。Promise は返せない。`);
      }
    } catch (err) {
      if (err instanceof Rejection) return { ...this.snapshot(actor), rejected: err.message };
      throw err;
    }
    assertJson(draft);
    if (result !== undefined) assertJson(result, "/result");
    const touched = changes(this.state, draft);
    if (touched.length) {
      const seq = this.seq + 1;
      if (!Number.isSafeInteger(seq)) throw new Error("revision の連番が上限に達した。");
      // ハンドラが参照を保持しても、後から確定状態を変更できない。
      const committed = structuredClone(draft);
      this.persist(seq, committed);
      this.state = committed;
      this.seq = seq;
      const event = { seq, revision: this.revision, op: name, actor, args: rest, touched };
      this.log.push(event);
      if (this.log.length > LOG_LIMIT) {
        this.log.shift();
        this.oldest = this.log[0]!.seq - 1;
      }
      for (const wake of [...this.waiters]) wake();
      this.appendLog(event);
    }
    return { ...this.snapshot(actor), ok: true, ...(result === undefined ? {} : { result: structuredClone(result) }) };
  }

  private position(since: Revision): number | null {
    const parsed = parseRevision(since);
    return parsed?.epoch === this.epoch && parsed.seq >= this.oldest && parsed.seq <= this.seq ? parsed.seq : null;
  }
  private collect(since: number, until?: string[]): Event[] {
    return this.log.filter((e) => e.seq > since && (!until?.length || until.includes(e.op)));
  }
  private diff(since: Revision, until?: string[]): Diff {
    const pos = this.position(since);
    if (pos === null) return { changes: [], truncated: true };
    const out: Change[] = [];
    for (const e of this.collect(pos, until)) {
      const last = out.at(-1);
      if (last?.op === e.op && last.actor === e.actor) {
        last.revision = e.revision;
        last.count++;
        last.touched = [...new Set([...last.touched, ...e.touched])];
      } else out.push({ revision: e.revision, op: e.op, actor: e.actor, count: 1, touched: [...e.touched] });
      if (out.length > CHANGE_LIMIT || Buffer.byteLength(JSON.stringify(out)) > CHANGE_BYTES) {
        return { changes: [], truncated: true };
      }
    }
    return { changes: out, truncated: false };
  }

  wait(since: Revision | undefined, until: string[] | undefined, timeoutMs: number, actor: Actor,
       signal?: AbortSignal): Promise<WaitResult<Doc>> {
    const result = (timedOut: boolean): WaitResult<Doc> => ({
      ...this.snapshot(actor), ...(since === undefined ? { changes: [], truncated: false } : this.diff(since, until)), timedOut,
    });
    const ready = () => {
      if (since === undefined) return true;
      const pos = this.position(since);
      return pos === null || this.collect(pos, until).length > 0;
    };
    if (ready() || signal?.aborted) return Promise.resolve(result(!!signal?.aborted));
    return new Promise((resolve) => {
      let done = false;
      const finish = (timedOut: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve(result(timedOut));
      };
      const wake = () => { if (ready()) finish(false); };
      const abort = () => finish(true);
      const timer = setTimeout(() => finish(true), timeoutMs);
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
