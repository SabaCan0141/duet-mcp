import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../duet/mcp.js";
import { Transport } from "../duet/transport.js";
import { createHttpApp } from "../duet/http.js";
import { Engine } from "../duet/engine.js";
import { defineApp, createAction } from "../duet/op.js";
import { observerOps, awaitChange } from "../duet/assets.js";
import { z } from "zod";

const action = createAction<{n: number}>();

test("MCP exposes only defined tools and translates scalar/transform input once",async()=>{
  let transforms=0;
  const app=defineApp({id:"mcp",version:"1",initialDoc:()=>({n:0}),actions: {
    length:action({description:"",input:z.string().transform(s=>{transforms++;return s.length;}),handler:({doc},n)=>{doc.update(s=>{s.n=n;});return n;}}),
    business:action({description:"",input:z.object({value:z.string()}),handler:(_ctx,arg)=>({ok:false,value:arg.value})}),
   ...observerOps(),await_change:awaitChange()}});
  const engine=await Engine.create(app,"http://localhost");const http=createHttpApp(app,{engine,url:engine.url,ready:true});
  const transport=new Transport({url:engine.url,request:((url,init)=>http.request(String(url),init)) as typeof fetch});
  const server=createMcpServer(app,transport);const client=new Client({name:"test",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  try {
    const listed=await client.listTools();assert(!listed.tools.some(t=>t.name==="gui_url"));
    const length=listed.tools.find(t=>t.name==="length")!;assert.equal((length.inputSchema.properties!.value as any).type,"string");assert(!("baseRevision" in length.inputSchema.properties!));
    const call=async(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
    const result=await call("length",{value:"hello"});assert.equal((result.content as any)[0].text,"5");assert.equal(transforms,1);
    assert.equal((await call("length",{value:3})).isError,true);
    assert.equal((await call("business",{value:"x"})).isError,undefined);
    const id=JSON.parse(((await call("get_observer_id")).content as any)[0].text as string);
    assert.deepEqual(JSON.parse(((await call("await_change",{oid:id})).content as any)[0].text as string),{n:5});
  } finally {await client.close();await server.close();await engine.stop();}
});
