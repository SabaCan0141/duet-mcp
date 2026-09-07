import type { Json } from "./diff.js";

/** 不透明な観測識別子。受け取った値をそのまま返す。 */
export type Revision = string;
export type Snapshot<Doc> = {
  revision: Revision;
  actor: string;
  doc: Readonly<Doc>;
  activity: Record<string, number>;
};
export type Change = {
  revision: Revision;
  op: string;
  actor: string;
  count: number;
  touched: string[];
};
export type Diff = { changes: Change[]; truncated: boolean };
export type RunResult<Doc> = Snapshot<Doc> & (
  | { ok: true; result?: Json }
  | { rejected: string }
  | ({ conflict: true } & Diff)
);
export type WaitResult<Doc> = Snapshot<Doc> & Diff & { timedOut: boolean };

/** 基盤内部だけで使う。アプリは revision を解析しない。 */
export function parseRevision(value: unknown): { epoch: string; seq: number } | null {
  if (typeof value !== "string") return null;
  const match = /^([^:]+):(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? { epoch: match[1]!, seq } : null;
}
