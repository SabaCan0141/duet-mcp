import { fileURLToPath } from "node:url";
import { defineApp, createAction } from "duet-mcp";
import { appInfo, awaitChange, observerOps, renderScreenshot, blobOps, historyOps } from "duet-mcp/assets";
import { z } from "zod";

// The shared state. The GUI imports this type only, never the app itself.
export type Doc = { text: string; box: { x: number; y: number } };

const action = createAction<Doc>();

export const app = defineApp({
  id: "template",
  version: "0.8.0",
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
  webDist: "template/ui/dist",
  initialDoc: (): Doc => ({ text: "", box: { x: 40, y: 40 } }),
  maxLen: 100, // Keep the last 100 states so undo/redo can step through them.
  actions: {
    // Each action is defined once and callable from both the GUI and MCP.
    set_text: action({
      description: "Replace the shared text.",
      input: z.object({ text: z.string() }),
      handler: ({ doc }, { text }) => {
        doc.update(state => { state.text = text; });
        return { text };
      },
    }),
    move_box: action({
      description: "Move the box. The board is 400×240 and the box is 80×80, so x is 0–320 and y is 0–160.",
      input: z.object({ x: z.number().min(0).max(320), y: z.number().min(0).max(160) }),
      handler: ({ doc }, box) => {
        doc.update(state => { state.box = box; });
      },
    }),

    // Built-in actions for the LLM side.
    url: appInfo().url,
    version: { ...appInfo().version, mcp: false }, // GUI only: shown next to the title.
    await_change: awaitChange(),
    ...observerOps(),
    ...historyOps(), // undo / redo, shared by the GUI and the LLM.
    render_screenshot: renderScreenshot(),
    ...blobOps({ directory: fileURLToPath(new URL("../../data/", import.meta.url)), id: "template" }),
  },
});
