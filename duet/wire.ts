/**
 * サーバ・ブラウザ・vite の設定が共有する定数。
 * どこから読まれてもよいように、node の API に依存させないこと。
 */

/**
 * 逃げ道。導出したポートが他のプロセスと衝突したときだけ使う。
 *
 * 既定を設定項目にはしない（分け忘れによる別アプリへの誤接続を防ぐため）。
 * ただし 8000-8999 の 1000 枠なので、衝突したときにアプリ名を変えるしか
 * 手が無いのは行き過ぎだった。
 *
 * 注意: daemon と vite の両方のプロセスに同じ値を渡すこと。片方だけだと
 * dev server のプロキシ先が daemon と食い違う。
 */
function override(): number | undefined {
  // ここはブラウザにもバンドルされる。process の存在を確かめてから読む。
  const raw = typeof process === "undefined" ? undefined : process.env?.DUET_PORT;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

/**
 * ポートは app.id から導出する（FNV-1a）。
 * 設定項目を持たないので、分け忘れによる別アプリへの誤接続が起きない。
 */
export function portFor(appId: string): number {
  const forced = override();
  if (forced !== undefined) return forced;

  let h = 2166136261;
  for (let i = 0; i < appId.length; i += 1) {
    h ^= appId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 8000 + ((h >>> 0) % 1000);
}

export const baseUrlFor = (appId: string): string => `http://127.0.0.1:${portFor(appId)}`;

/** ロングポーリングの長さ。サーバもブラウザも vite もここだけを読む。 */
export const WAIT_MS = 25_000;
export const MAX_WAIT_MS = 120_000;
export const MIN_WAIT_MS = 1_000;
