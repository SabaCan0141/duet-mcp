/**
 * doc の構造差分。
 *
 * 変更検知（差分が空か）と変更説明（どこを触ったか）を、この 1 箇所から得る。
 * 文字列比較をやめたので、キーの並びが変わっただけで revision が進むことがない。
 *
 * パスは JSON Pointer（RFC 6901）。root は ""、以下は "/cards/3/title"。
 * 標準の書式なので、そのまま LLM への応答に載せて読ませられる。
 */

/** doc に置ける値。開発者が明示したいときに使う（強制はしない）。 */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

const seg = (key: string | number): string =>
  `/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

const at = (path: string): string => path || "(root)";

/**
 * JSON で表せない値を、書かれた瞬間に見つける。
 *
 * structuredClone は Map / Set / Date を保つが JSON.stringify は保たない。
 * 検査しないと、Map を置いたアプリは「コミットしたのに何も起きない」あるいは
 * 「毎回 revision が進む」という、原因の分からない壊れ方をする。
 * 型で縛るより、実際に置かれた場所を名指しで言う方が短く終わる。
 */
export function assertJson(value: unknown, path = "", seen = new Set<object>()): void {
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) throw new Error(`JSON の ${at(path)} が循環参照。`);
    seen.add(value);
  }
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      // NaN / Infinity は JSON では null になる。黙って値が変わるので弾く。
      if (!Number.isFinite(value)) {
        throw new Error(`doc の ${at(path)} が ${String(value)}。JSON では null になるので置けない。`);
      }
      return;
    case "undefined":
      throw new Error(
        `doc の ${at(path)} が undefined。JSON では消えるので、` +
          `キーを消すなら delete、値を空にするなら null を使うこと。`,
      );
    default:
      break;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJson(value[i], path + seg(i), seen);
    seen.delete(value);
    return;
  }
  if (isPlain(value)) {
    for (const [k, v] of Object.entries(value)) assertJson(v, path + seg(k), seen);
    seen.delete(value);
    return;
  }
  const name = (value as object).constructor?.name ?? typeof value;
  throw new Error(
    `doc の ${at(path)} が ${name}。JSON で表せる値（object / array / string / number / boolean / null）だけ置けること。`,
  );
}

/** union。before の並びを保ったまま、after で増えたキーを後ろに足す。 */
function keysOf(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out = Object.keys(a);
  for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) out.push(k);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (a === b) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    // 長さが違えば要素の対応が付かない。配列ごと触ったことにする。
    // 変更説明では配列全体を指す。競合判定には使わない。
    if (a.length !== b.length) {
      out.push(path);
      return;
    }
    for (let i = 0; i < a.length; i += 1) walk(a[i], b[i], path + seg(i), out);
    return;
  }

  if (isPlain(a) && isPlain(b)) {
    for (const k of keysOf(a, b)) walk(a[k], b[k], path + seg(k), out);
    return;
  }

  // プリミティブ、型が変わった、片方が null。ここが葉になる。
  out.push(path);
}

/**
 * before から after で変わった場所。空なら何も変わっていない。
 * 深い方から葉のパスだけを返す（"/cards/3/title" は返るが "/cards" は返らない）。
 */
export function changes(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  walk(before, after, "", out);
  return out;
}

