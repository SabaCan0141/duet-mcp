import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startRuntime } from "./runtime.js";
import { Transport } from "./transport.js";
import { createMcpServer } from "./mcp.js";
import type { AppDef } from "./types.js";
export async function runApp(app: AppDef): Promise<void> {
  const runtime = await startRuntime(app);
  const mcp = createMcpServer(app, new Transport({ url: runtime.url, id: app.id, version: app.version, actor: process.env.DUET_ACTOR ?? "llm" }));
  try { await mcp.connect(new StdioServerTransport()); }
  catch (error) { await runtime.stop(); throw error; }
  const shutdown = () => { void runtime.stop().finally(() => process.exit(0)); };
  process.stdin.on("close", shutdown); process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}
