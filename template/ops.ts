import { z } from "zod";
import { opFactory } from "duet-mcp";
import type { Op } from "duet-mcp";
import type { Doc } from "./doc.js";

const op = opFactory<Doc>();

// Each operation becomes both an MCP tool and a POST /api/op/:name endpoint.
// Define operations around intent. Keep typing and drag previews local until committed.
export const ops: Op<Doc>[] = [
  op({
    name: "set_text",
    description: "Replace the shared note text.",
    input: { text: z.string() },
    handler: ({ doc }, { text }) => {
      // The revision stays unchanged for a no-op; no comparison is needed here.
      doc.text = text;
      return { text };
    },
  }),
];

// Commit the form as one edit.
ops.push(op({
  name: "set_settings",
  description: "Set the canvas heading, notes, visibility, grid, style, color, and opacity.",
  input: {
    caption: z.string().max(80), notes: z.string().max(500), visible: z.boolean(), grid: z.boolean(),
    style: z.enum(["solid", "outline"]), color: z.enum(["violet", "blue", "coral"]),
    opacity: z.number().int().min(10).max(100),
  },
  handler: ({ doc }, settings) => { doc.settings = settings; },
}));
ops.push(op({
  name: "set_box",
  description: "Move or resize the box within a 720×480 canvas. The minimum size is 64×64.",
  input: { x: z.number().min(0), y: z.number().min(0), width: z.number().min(64), height: z.number().min(64) },
  handler: ({ doc, reject }, box) => {
    if (box.x + box.width > 720 || box.y + box.height > 480) return reject("Keep the box within the canvas bounds.");
    doc.box = box;
  },
}));
