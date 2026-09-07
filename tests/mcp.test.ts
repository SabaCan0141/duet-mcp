import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../duet/mcp.js";
import { DocStore } from "../duet/doc.js";
import { createHttpApp } from "../duet/http.js";
import { app } from "../template/app.js";

test("MCP exposes string revisions and uses the same HTTP operation and snapshot", async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"duet-mcp-test-"));
  const store=new DocStore(app,dir);
  const http=createHttpApp(app,()=>store);
  const server=new McpServer({name:"test",version:"1"});
  registerTools(server,app,async <T>(pathname:string,init?:RequestInit):Promise<T>=>{
    const headers=new Headers(init?.headers);headers.set("x-duet-actor","llm");
    return (await http.request(pathname,{...init,headers})).json() as Promise<T>;
  });
  const client=new Client({name:"test",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  await server.connect(a);await client.connect(b);
  const tools=await client.listTools();
  const shape=tools.tools.find(t=>t.name==="set_text")!.inputSchema.properties!;
  assert.equal((shape.baseRevision as {type:string}).type,"string");
  const invoke=async(name:string,args:Record<string,unknown>={})=>{
    const result=await client.callTool({name,arguments:args});
    const content=result.content as {type:string;text:string}[];
    return {result,payload:JSON.parse(content[0]!.text)};
  };
  const initial=(await invoke("await_change")).payload;
  assert.equal(initial.actor,"llm");
  const applied=(await invoke("set_text",{baseRevision:initial.revision,text:"new"})).payload;
  assert.equal(applied.ok,true);assert.equal(applied.doc.text,"new");
  const stale=(await invoke("set_text",{baseRevision:initial.revision,text:"old"})).payload;
  assert.equal(stale.conflict,true);assert.equal(stale.doc.text,"new");
  const old=await client.callTool({name:"set_text",arguments:{baseRevision:0,text:"invalid"}});
  assert.equal(old.isError,true);
  assert.equal(store.snapshot("human").doc.text,"new");
});
