import { chromium } from "playwright";
import type { Context } from "./types.js";
import type { ScreenshotOptions } from "./assets.js";
export async function takeShot(ctx: Context<any>, options: ScreenshotOptions, at = "/"): Promise<string> {
  const origin = process.env.DUET_SHOT_ORIGIN ?? ctx.url;
  const url = new URL(at, origin);
  if (url.origin !== new URL(origin).origin) throw new Error("Screenshot path must stay on the GUI origin");
  const want = ctx.snapshot();
  const browser = await chromium.launch({ headless: true });
  const abort = () => { void browser.close(); }; ctx.signal.addEventListener("abort", abort, {once: true});
  try {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const viewport = options.viewport ? { width: options.viewport.w, height: options.viewport.h } : {width: 1024, height: 768};
    const page = await browser.newPage({viewport}); page.setDefaultTimeout(10_000);
    const response = await page.goto(url.href, {timeout: 10_000});
    if (!response?.ok()) throw new Error(`Screenshot navigation failed: ${response?.status()}`);
    await page.waitForFunction(target => document.documentElement.dataset.duetOwner === target.ownerId && Number(document.documentElement.dataset.duetSeq) >= target.seq, {ownerId: want.ownerId, seq: want.seq}, {timeout: 10_000});
    await page.waitForFunction(() => document.fonts.status === "loaded", undefined, {timeout: 10_000});
    const bytes = options.selector ? await page.locator(options.selector).screenshot() : await page.screenshot();
    if (await page.evaluate(() => document.documentElement.dataset.duetOwner) !== want.ownerId) throw new Error("Daemon changed during screenshot");
    return bytes.toString("base64");
  } finally { ctx.signal.removeEventListener("abort", abort); await browser.close(); }
}
