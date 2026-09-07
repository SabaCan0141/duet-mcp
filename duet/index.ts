/** 操作定義と共有型。Node.js の実行処理は duet-mcp/server から読み込む。 */
export { defineApp, opFactory } from "./op.js";
export type { AppDef, Op, Ctx, Actor, Json, Revision, Snapshot, RunResult } from "./types.js";
