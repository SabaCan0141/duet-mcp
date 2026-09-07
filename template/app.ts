import { fileURLToPath } from "node:url";
import { defineApp } from "duet-mcp";
import { initialDoc, type Doc } from "./doc.js";
import { ops } from "./ops.js";

export const app = defineApp<Doc>({
  id: "template",
  // Resolve the app root from dist/template/app.js, independently of the MCP client cwd.
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
  version: "0.1.0",
  initialDoc,
  ops,
  // The port is derived from the app id. A GUI is required.
  webDist: "template/ui/dist",
  // Capture the same GUI for the LLM; only the capture region needs configuration.
  shot: { selector: "#studio", viewport: { w: 1440, h: 1150 } },
});
