import { chromium } from "playwright";
import type { Context } from "./types.js";
import type { ScreenshotOptions } from "./assets.js";
// Playwright exposes no error code for missing browsers. Keep message matching narrow;
// unknown launch errors must surface rather than silently selecting another browser.
function missingBrowser(error: unknown, channel: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(`Chromium distribution '${channel}' is not found`) ||
    (channel === "chromium" && error.message.includes("Executable doesn't exist at"));
}
async function launchBrowser(channel: NonNullable<ScreenshotOptions["channel"]>) {
  if (channel !== "auto") return chromium.launch({ channel, headless: true });
  for (const candidate of ["chrome", "msedge", "chromium"] as const) {
    try { return await chromium.launch({ channel: candidate, headless: true }); }
    catch (error) { if (!missingBrowser(error, candidate)) throw error; }
  }
  throw new Error('No screenshot browser found. Install Chrome or Edge, or run `npx playwright install chromium`. Select explicitly with renderScreenshot({ channel: "chromium" }).');
}
export async function takeShot(ctx: Context<any>, options: ScreenshotOptions, at = "/"): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Screenshot timeoutMs must be a positive safe integer");
  const channel = options.channel ?? "auto";
  if (!["auto", "chrome", "msedge", "chromium"].includes(channel)) throw new Error("Invalid screenshot channel");
  if (ctx.signal.aborted) throw ctx.signal.reason;
  const origin = process.env.DUET_SHOT_ORIGIN ?? ctx.url;
  const url = new URL(at, origin);
  if (url.origin !== new URL(origin).origin) throw new Error("Screenshot path must stay on the GUI origin");
  const want = ctx.snapshot();
  const browser = await launchBrowser(channel);
  const abort = () => { void browser.close().catch(() => {}); }; ctx.signal.addEventListener("abort", abort, {once: true});
  try {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const viewport = options.viewport ? { width: options.viewport.w, height: options.viewport.h } : {width: 1024, height: 768};
    const page = await browser.newPage({viewport}); page.setDefaultTimeout(timeoutMs);
    const response = await page.goto(url.href, {timeout: timeoutMs});
    if (!response?.ok()) throw new Error(`Screenshot navigation failed: ${response?.status()}`);
    await page.waitForFunction(target => document.documentElement.dataset.duetOwner === target.ownerId && Number(document.documentElement.dataset.duetSeq) >= target.seq, {ownerId: want.ownerId, seq: want.seq}, {timeout: timeoutMs});
    await page.waitForFunction(() => document.fonts.status === "loaded", undefined, {timeout: timeoutMs});
    const bytes = options.selector ? await page.locator(options.selector).screenshot() : await page.screenshot();
    if (await page.evaluate(() => document.documentElement.dataset.duetOwner) !== want.ownerId) throw new Error("Daemon changed during screenshot");
    return bytes.toString("base64");
  } finally { ctx.signal.removeEventListener("abort", abort); await browser.close(); }
}
