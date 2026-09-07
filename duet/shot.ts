import { chromium, type Browser, type Page } from "playwright";
import { parseRevision, type Revision } from "./protocol.js";
import type { AppDef } from "./types.js";
import { baseUrlFor } from "./wire.js";

const READY_TIMEOUT_MS = 10_000;
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

/**
 * 撮影先。既定は daemon 自身（= 人が見ているのと同じ vite ビルド成果物）。
 *
 * 開発時だけ差し替える。`dev:web` 中は人間が :5173 の最新を見ているのに、
 * daemon は古い（あるいは未ビルドの）dist を配るので、既定のままだと
 * ビルド成果物の食い違いを避けるため、開発中はここを :5173 に向ける。
 *
 *   DUET_SHOT_ORIGIN=http://127.0.0.1:5173
 *
 * vite の dev server は /api と /blob を daemon にプロキシするので、
 * data-duet-revision の契約はそのまま成立する。
 */
const shotOrigin = (id: string): string =>
  process.env.DUET_SHOT_ORIGIN?.replace(/\/+$/, "") ?? baseUrlFor(id);

type Holder = {
  __duetShot?: { browser: Browser; page: Page; at: string };
  /** 撮影の直列化。ページを 1 枚しか持たないので、同時に来ると取り合いになる。 */
  __duetShotQueue?: Promise<unknown>;
};
const holder = globalThis as unknown as Holder;

/**
 * 同じ GUI を別セッションで描く。人間の下書きやスクロール位置は共有しない。
 *
 * ページは開いたままにする。GUI は useDoc でロングポーリングしているので、
 * 常に最新を映している。撮影ごとの navigate も再読み込みも要らない。
 */
async function getPage<Doc>(app: AppDef<Doc>, at: string): Promise<Page> {
  const url = `${shotOrigin(app.id)}${at}`;
  const live = holder.__duetShot;

  if (live && live.browser.isConnected() && !live.page.isClosed()) {
    if (live.at !== at) {
      await live.page.goto(url);
      live.at = at;
    }
    return live.page;
  }

  // 死んだ browser を掴んだままにすると、以後の撮影が永久に失敗する。
  holder.__duetShot = undefined;
  const reusable = live?.browser.isConnected() === true ? live.browser : null;
  if (reusable) await live!.page.close().catch(() => {});
  const browser = reusable ?? (await chromium.launch({ headless: true }));

  const v = app.shot?.viewport;
  const page = await browser.newPage({
    viewport: v ? { width: Math.ceil(v.w), height: Math.ceil(v.h) } : DEFAULT_VIEWPORT,
  });
  await page.goto(url);
  holder.__duetShot = { browser, page, at };
  return page;
}

/**
 * 同じ daemon の要求時点以降の DOM 反映を待つ。
 * 非同期画像などのアプリ固有の描画完了は、この属性だけでは判定できない。
 * 基盤と GUI の間の contract はこの属性 1 つだけ。
 */
export function takeShot<Doc>(app: AppDef<Doc>, revision: Revision, at = "/"): Promise<string> {
  // 参加者は複数居てよい設計なので、render_screenshot が同時に来ることはある。
  // 並べないと、片方が撮っている間にもう片方が goto して別の画面が写る。
  const prev = holder.__duetShotQueue ?? Promise.resolve();
  const next = prev.then(() => capture(app, revision, at));
  holder.__duetShotQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function capture<Doc>(app: AppDef<Doc>, revision: Revision, at: string): Promise<string> {
  const page = await getPage(app, at);
  const want = parseRevision(revision);
  if (!want) throw new Error("invalid revision");
  await page.waitForFunction(
    (target) => {
      const raw = document.documentElement.dataset.duetRevision;
      const parts = raw?.split(":");
      return parts?.[0] === target.epoch && Number(parts[1]) >= target.seq;
    },
    want,
    { timeout: READY_TIMEOUT_MS },
  );
  await page.evaluate(() => document.fonts.ready.then(() => true));

  const epoch = await page.evaluate(() => document.documentElement.dataset.duetRevision?.split(":")[0]);
  if (epoch !== want.epoch) throw new Error("撮影中に daemon が交代した。最新状態を取得して撮り直すこと。");
  const selector = app.shot?.selector;
  const buf = selector
    ? await page.locator(selector).screenshot({ type: "png" })
    : await page.screenshot({ type: "png" });
  const after = await page.evaluate(() => document.documentElement.dataset.duetRevision?.split(":")[0]);
  if (after !== want.epoch) throw new Error("撮影中に daemon が交代した。最新状態を取得して撮り直すこと。");
  return buf.toString("base64");
}
