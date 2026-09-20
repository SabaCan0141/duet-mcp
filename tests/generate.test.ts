import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { generate } from "../duet/generate.js";
const root = fileURLToPath(new URL("../../", import.meta.url));

test("generation uses type imports, follows definition changes, and never initializes state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "duet-generate-"));
  try {
    await fs.mkdir(path.join(directory, "node_modules"));
    await fs.symlink(root, path.join(directory, "node_modules/duet-mcp"), "dir");
    await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(directory, "duet.config.ts"), 'export default { app: "./app.ts" };');
    const app = (port: number, op: string) => `import {defineApp,createAction} from "duet-mcp";const action=createAction<{text:string}>();
export const app=defineApp({id:"generated",version:"1",port:${port},initialDoc:()=>{throw new Error("initialization must not run");return {text:""};},setup:()=>{throw new Error("setup must not run");},actions:{${op}:action({description:"hello",handler:()=>42})}});`;
    await fs.writeFile(path.join(directory, "app.ts"), app(8123, "hello"));
    const first = await generate(directory);
    const client = await fs.readFile(path.join(first.directory, "browser.ts"), "utf8");
    assert(client.includes('import type { app } from "../app.js"'));
    assert(!client.includes("hello:"));
    assert((await fs.readFile(path.join(first.directory, "connection.ts"), "utf8")).includes(":8123"));
    assert(first.inputs.includes(path.join(directory, "app.ts")));
    const node = await fs.readFile(path.join(first.directory, "node.ts"), "utf8");
    assert(node.includes('import type { app } from "../app.js"'));
    assert(node.includes('from "duet-mcp/server"'));
    // Upgrade removes old generated files, but preserves files written by users.
    await fs.writeFile(path.join(first.directory, "client.ts"), client);
    await fs.writeFile(path.join(first.directory, "server.ts"), "// handwritten\n");
    await fs.writeFile(path.join(directory, "app.ts"), app(8124, "renamed"));
    await generate(directory);
    await assert.rejects(fs.access(path.join(first.directory, "client.ts")), {code:"ENOENT"});
    assert.equal(await fs.readFile(path.join(first.directory, "server.ts"), "utf8"), "// handwritten\n");
    assert.equal(await fs.readFile(path.join(first.directory, "browser.ts"), "utf8"), client);
    assert((await fs.readFile(path.join(first.directory, "connection.ts"), "utf8")).includes(":8124"));
    await fs.writeFile(path.join(directory, "other.ts"), app(8125, "other"));
    await fs.writeFile(path.join(directory, "duet.config.ts"), 'export default { app: "./other.ts" };');
    await generate(directory);
    assert((await fs.readFile(path.join(first.directory, "browser.ts"), "utf8")).includes('"../other.js"'));
    await fs.writeFile(path.join(directory, "other.ts"), 'export const app = { id: "a", id: "b" };');
    await assert.rejects(generate(directory), /Duplicate key/);
  } finally { await fs.rm(directory, {recursive:true,force:true}); }
});
