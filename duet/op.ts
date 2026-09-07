import { z } from "zod";
import type { AppDef, Op, ZodRawShape } from "./types.js";

/**
 * Doc を固定した op 定義ヘルパ。
 * `const op = opFactory<MyDoc>()` としてから op({...}) と書くと、
 * handler の ctx.doc と args に型が付く。
 */
export function opFactory<Doc>() {
  return <Shape extends ZodRawShape>(op: Op<Doc, Shape>): Op<Doc, Shape> => op;
}

export function defineApp<Doc>(app: AppDef<Doc>): AppDef<Doc> {
  return app;
}

/** 両方の入口に同じ観測識別子を要求する。 */
export function inputShape<Doc>(op: Op<Doc>): ZodRawShape {
  return {
    ...op.input,
    baseRevision: z.string().min(1).describe(
      "意図を決めるために観測した revision をそのまま渡す。数値の旧形式は使えない。版が変われば実行前に conflict。",
    ),
  };
}
