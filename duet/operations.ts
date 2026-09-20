import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { assertJson } from "./json.js";
import { DuetError } from "./errors.js";
import type { AppDef, Context, Action } from "./types.js";
export function inputForm(op: Action): "none" | "object" | "value" {
  return !op.input ? "none" : op.input instanceof z.ZodObject ? "object" : "value";
}
export function toolSchema(op: Action): Record<string, unknown> {
  const schema = !op.input ? z.object({}).strict() : inputForm(op) === "object" ? op.input : z.object({ value: op.input });
  return zodToJsonSchema(schema, { target: "jsonSchema7", effectStrategy: "input", $refStrategy: "none" }) as Record<string, unknown>;
}
function checkSchema(schema: z.ZodTypeAny, name: string): void {
  const def = schema._def;
  if (["ZodAny", "ZodUnknown", "ZodString", "ZodNumber", "ZodBoolean", "ZodNull", "ZodLiteral", "ZodEnum", "ZodNativeEnum", "ZodNever"].includes(def.typeName)) return;
  if (def.typeName === "ZodObject") { for (const v of Object.values(def.shape())) checkSchema(v as z.ZodTypeAny, name); if (def.catchall) checkSchema(def.catchall, name); return; }
  if (def.typeName === "ZodArray") return checkSchema(def.type, name);
  if (["ZodOptional", "ZodNullable", "ZodDefault", "ZodCatch", "ZodReadonly"].includes(def.typeName)) return checkSchema(def.innerType, name);
  if (def.typeName === "ZodEffects") { if (def.effect.type === "preprocess") throw new Error(`op ${name}: preprocess has no describable input schema`); return checkSchema(def.schema, name); }
  if (def.typeName === "ZodUnion" || def.typeName === "ZodDiscriminatedUnion") { for (const v of def.options) checkSchema(v, name); return; }
  if (def.typeName === "ZodTuple") { for (const v of def.items) checkSchema(v, name); if (def.rest) checkSchema(def.rest, name); return; }
  if (def.typeName === "ZodRecord") { checkSchema(def.keyType, name); checkSchema(def.valueType, name); return; }
  if (def.typeName === "ZodIntersection") { checkSchema(def.left, name); checkSchema(def.right, name); return; }
  if (def.typeName === "ZodPipeline") return checkSchema(def.in, name);
  throw new Error(`op ${name}: unsupported MCP input schema ${def.typeName}`);
}
export function validateOps(app: AppDef): void {
  if (typeof app.id !== "string" || !app.id || typeof app.version !== "string" || !app.version) throw new Error("app.id and app.version must be non-empty strings");
  for (const [name, op] of Object.entries(app.actions)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || name === "then") throw new Error(`invalid op name: ${name}`);
    if (op.input) checkSchema(op.input, name);
    toolSchema(op);
  }
}
export async function dispatch(app: AppDef, ctx: Context<any>, name: string, input: unknown): Promise<unknown> {
  const op = Object.hasOwn(app.actions, name) ? app.actions[name] : undefined;
  if (!op) throw new DuetError("UnknownOperation", `unknown op: ${name}`);
  if (input !== undefined) assertJson(input, `/op/${name}/input`);
  try {
    const parsed = op.input ? await op.input.parseAsync(input) : undefined;
    if (!op.input && input !== undefined) throw new DuetError("InvalidInput", `op ${name} takes no input`);
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const result = await op.handler(ctx, parsed);
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (result !== undefined) assertJson(result, `/op/${name}/result`);
    return result === undefined ? undefined : structuredClone(result);
  } catch (error) {
    if (error instanceof DuetError) throw error;
    throw new DuetError(error instanceof z.ZodError ? "InvalidInput" : "OperationError", `op ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
