import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { inputForm, toolSchema } from "./operations.js";
import { errorInfo } from "./errors.js";
import type { AppDef } from "./types.js";
import type { Transport } from "./transport.js";
export function createMcpServer(app: AppDef, transport: Transport): Server {
  const server = new Server({ name: app.id, version: app.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(app.actions).map(([name, op]) => ({ name, description: op.description, inputSchema: toolSchema(op) as any })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const name = request.params.name;
      const op = Object.hasOwn(app.actions, name) ? app.actions[name] : undefined;
      if (!op) throw new Error(`unknown op: ${name}`);
      const args = request.params.arguments ?? {};
      const form = inputForm(op);
      const result = await transport.op(name, form === "none" ? undefined : form === "object" ? args : args.value);
      return { content: op.content ? op.content(result) : result === undefined ? [] : [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify(errorInfo(error)) }] }; }
  });
  return server;
}
