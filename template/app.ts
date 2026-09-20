import { fileURLToPath } from "node:url";
import { defineApp, createAction } from "duet-mcp";
import { guiUrl, awaitChange, observerOps, renderScreenshot, blobOps } from "duet-mcp/assets";
import { z } from "zod";

// Shared state and its operations live together. The GUI imports these types only.
export type Box = { x: number; y: number; width: number; height: number };
export type Settings = {
  caption: string;
  notes: string;
  visible: boolean;
  grid: boolean;
  style: "solid" | "outline";
  color: "violet" | "blue" | "coral";
  opacity: number;
};
type Doc = { text: string; settings: Settings; box: Box };

const action = createAction<Doc>();

export const app = defineApp({
  id: "template",
  version: "0.7.0",
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
  webDist: "template/ui/dist",
  initialDoc: (): Doc => ({
    text: "",
    settings: {
      caption: "Make room for ideas.",
      notes: "One idea, shaped together by you and AI.",
      visible: true,
      grid: true,
      style: "solid",
      color: "violet",
      opacity: 100,
    },
    box: { x: 160, y: 120, width: 360, height: 220 },
  }),
  actions: {
    set_text: action({
      description: "Replace the shared note text.",
      input: z.object({ text: z.string() }),
      handler: ({ doc }, { text }) => {
        doc.update(state => { state.text = text; });
        return { text };
      },
    }),
    set_settings: action({
      description: "Set the canvas heading, notes, visibility, grid, style, color and opacity.",
      input: z.object({
        caption: z.string().max(80),
        notes: z.string().max(500),
        visible: z.boolean(),
        grid: z.boolean(),
        style: z.enum(["solid", "outline"]),
        color: z.enum(["violet", "blue", "coral"]),
        opacity: z.number().int().min(10).max(100),
      }),
      handler: ({ doc }, settings) => {
        doc.update(state => { state.settings = settings; });
      },
    }),
    set_box: action({
      description: "Move or resize the box within the canvas.",
      input: z.object({
        x: z.number().min(0),
        y: z.number().min(0),
        width: z.number().min(64),
        height: z.number().min(64),
      }),
      handler: ({ doc }, box) => {
        if (box.x + box.width > 720 || box.y + box.height > 480) {
          throw new Error("Keep the box within the canvas bounds.");
        }
        doc.update(state => { state.box = box; });
      },
    }),

    gui_url: guiUrl(),
    await_change: awaitChange(),
    ...observerOps(),
    render_screenshot: renderScreenshot({
      selector: "#studio",
      viewport: { w: 1440, h: 1150 },
    }),
    ...blobOps({
      directory: fileURLToPath(new URL("../../data/", import.meta.url)),
      id: "template",
    }),
  },
});
