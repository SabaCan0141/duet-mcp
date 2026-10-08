import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Action, Context } from "./types.js";
const waiting = z.object({ oid: z.string(), timeoutMs: z.number().int().min(0).max(2_147_483_647).optional() });
// lib/ (published) and dist/duet/ (repository build) sit at different depths, so walk up to duet-mcp's own package.json.
let duetVersion: Promise<string> | undefined;
async function findDuetVersion(): Promise<string> {
  for (let dir = new URL("./", import.meta.url); ; dir = new URL("../", dir)) {
    const meta = await readFile(new URL("package.json", dir), "utf8").then(JSON.parse, () => null);
    if (meta?.name === "duet-mcp") return meta.version;
    if (new URL("../", dir).href === dir.href) throw new Error("duet-mcp package.json not found");
  }
}
export function appInfo() {
  return {
    id: { description: "Return the app ID.", handler: (ctx: Context<any>) => ctx.app.id } as Action<any, undefined, string>,
    version: { description: "Return the app version.", handler: (ctx: Context<any>) => ctx.app.version } as Action<any, undefined, string>,
    duet: { description: "Return the duet-mcp version this app runs on.", handler: () => duetVersion ??= findDuetVersion() } as Action<any, undefined, Promise<string>>,
    url: { description: "Return the GUI URL.", handler: (ctx: Context<any>) => ctx.url } as Action<any, undefined, string>,
  };
}
export function awaitChange() {
  return {
    returnsDoc: true as const, description: "Wait for a change and return the entire doc, then advance this observer. An unobserved ID returns immediately. Timeouts also return and observe the latest doc. First create an observer ID.", input: waiting,
    handler: async (ctx: Context<any>, input: z.output<typeof waiting>) => {
      await ctx.observers.waitChange(input.oid, input.timeoutMs, { signal: ctx.signal });
      const doc = ctx.doc.get(); ctx.observers.observe(input.oid); return doc;
    },
  };
}
export const waitChange = (): Action<any, typeof waiting, Promise<boolean>> => ({
  description: "Wait for a doc update. Return true on change, false on timeout. Does not read the doc or advance observation.", input: waiting,
  handler: (ctx, input) => ctx.observers.waitChange(input.oid, input.timeoutMs, { signal: ctx.signal }),
});
export function observerOps() {
  return {
    get_observer_id: { description: "Create a new unobserved observer ID. Keep it and pass it explicitly to operations that need it.", handler: (ctx: Context<any>) => ctx.observers.getObserverID() } as Action<any, undefined, string>,
    dispose_observer: { description: "Dispose an observer ID and terminate its waits.", input: z.object({ oid: z.string() }), handler: (ctx: Context<any>, {oid}: {oid: string}) => ctx.observers.dispose(oid) },
  };
}
export function historyOps() {
  return {
    undo: { description: "Move the doc back one revision. Returns false if there is nothing to undo.", handler: (ctx: Context<any>) => ctx.doc.undo() } as Action<any, undefined, boolean>,
    redo: { description: "Move the doc forward one revision. Returns false if there is nothing to redo.", handler: (ctx: Context<any>) => ctx.doc.redo() } as Action<any, undefined, boolean>,
  };
}
export type ScreenshotOptions = { selector?: string; viewport?: { w: number; h: number } };
export function renderScreenshot(options: ScreenshotOptions = {}) {
  return {
    description: "Capture the shared GUI in a separate browser session. Does not show a person's local draft or viewport.",
    input: z.object({ path: z.string().default("/") }),
    handler: async (ctx: Context<any>, input: {path: string}) => {
      const { takeShot } = await import("./shot.js");
      return { data: await takeShot(ctx, options, input.path), mime: "image/png" };
    },
    content: (result: {data: string; mime: string}) => [{ type: "image", data: result.data, mimeType: result.mime }],
  };
}
export function blobOps(options: { directory: string; id?: string }) {
  const getStore = async () => { const { BlobStore } = await import("./blob.js"); return new BlobStore(options.id ?? "duet", options.directory); };
  return {
    put_blob: { description: "Store base64 encoded bytes in the configured blob directory.", input: z.object({ data: z.string(), mime: z.string() }), handler: async (_ctx: Context<any>, input: {data: string; mime: string}) => (await getStore()).put(Buffer.from(input.data, "base64"), input.mime) },
    read_blob: { description: "Read a blob from the configured directory.", input: z.object({ id: z.string() }), handler: async (_ctx: Context<any>, input: {id: string}) => { const found = (await getStore()).get(input.id); if (!found) throw new Error("Blob not found"); return { data: found.bytes.toString("base64"), mime: found.mime }; }, content: (result: {data: string; mime: string}) => result.mime.startsWith("image/") ? [{type: "image", data: result.data, mimeType: result.mime}] : [{type: "text", text: JSON.stringify(result)}] },
  };
}
