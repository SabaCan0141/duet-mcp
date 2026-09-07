import type { z } from "zod";
import type { Json } from "./diff.js";
export type { Revision, Snapshot, RunResult } from "./protocol.js";

export type { Json } from "./diff.js";

export type ZodRawShape = z.ZodRawShape;

/**
 * 誰が操作したか。ただの文字列。
 * ブラウザからは "human"、MCP からは env の DUET_ACTOR（既定 "llm"）。
 * MCP 設定に DUET_ACTOR=gpt と書けば別参加者になる。
 *
 * 「面」でも「役割」でもない。席の割り当てはアプリの doc に書くこと。
 */
export type Actor = string;

/**
 * op のハンドラが受け取るもの。これで全部。
 *
 * doc はそのまま書き換えてよい。これは複製なので、reject や例外で抜けた場合は
 * 途中まで書いた変更ごと捨てられる。commit / 永続化 / revision 採番は基盤が行う。
 */
export type Ctx<Doc> = {
  doc: Doc;
  actor: Actor;
  /**
   * この操作は適用しない、と宣言して中断する。revision は進まない。
   * 非合法な入力、状態的に許されない要求、手番違反はすべてこれ（例外ではなく正常な結果）。
   * `return reject(...)` の形で呼ぶこと。
   */
  reject: (reason: string) => never;
};

/**
 * 操作の唯一の定義。ここから MCP ツールと HTTP ルートの両方が生える。
 *
 * handler をメソッド構文で宣言しているのは、具体的な Shape を持つ Op を
 * Op<Doc, ZodRawShape>[] に代入できるようにするため（双変性）。
 */
export type Op<Doc, Shape extends ZodRawShape = ZodRawShape> = {
  name: string;
  description: string;
  /** baseRevision は基盤が必須項目として足す。 */
  input: Shape;
  /** 同期で doc と結果だけを計算する。外部副作用・Promise は扱わない。 */
  handler(ctx: Ctx<Doc>, args: z.infer<z.ZodObject<Shape>>): Json | void;
};

export type AppDef<Doc> = {
  /** ポートとデータファイル名の元になる。プロセス間の正体確認にも使う。 */
  id: string;
  version: string;
  initialDoc: () => Doc;
  ops: Op<Doc>[];
  /** アプリのルートの絶対パス。省略時は起動時の作業ディレクトリ。保存先はこの下の data/。 */
  rootDir?: string;
  /** GUI の出力先。rootDir からの相対パス、または絶対パス。 */
  webDist: string;
  /**
   * スクリーンショットの撮り方。省略するとビューポート全体を等倍で撮る。
   * 絵は GUI をそのまま撮るので、LLM 用に別途描画するものは無い。
   */
  shot?: {
    /** 撮る要素の CSS セレクタ。省略するとページ全体。 */
    selector?: string;
    viewport?: { w: number; h: number };
  };
};
