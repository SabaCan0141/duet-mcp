import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../duet/engine.js";
import { createHttpApp } from "../duet/http.js";
import { defineApp, createAction } from "../duet/op.js";
import { z } from "zod";
import { PROTOCOL } from "../duet/protocol.js";

const action = createAction<{n: number}>();

test("HTTP results carry only the application result; owner mismatch never executes",async()=>{
  const app=defineApp({id:"http",version:"1",initialDoc:()=>({n:0}),actions: {
    add:action({description:"",input:z.number(),handler:({doc},n)=>{doc.update(s=>{s.n+=n;});return {ok:false,n:doc.get().n};}}),
    read:action({description:"",handler:({doc})=>doc.get().n}),
  }});
  const engine=await Engine.create(app,"http://localhost");const host={engine,url:engine.url,ready:true};const http=createHttpApp(app,host);
  const req=(name:string,body:unknown,owner:string=engine.ownerId)=>http.request(`/api/op/${name}`,{method:"POST",headers:{"content-type":"application/json","x-duet-owner":owner},body:JSON.stringify(body)});
  assert.equal((await (await http.request("/api/hello")).json()).protocol,PROTOCOL);
  const id=engine.observers.getObserverID();engine.observers.observe(id);
  const result=await (await req("add",{input:2})).json();assert.deepEqual(result,{ok:true,result:{ok:false,n:2},ownerId:engine.ownerId});
  assert.equal(engine.observers.isCurrent(id),false);
  assert.equal((await req("add",{input:9},"old-owner")).status,409);assert.equal(engine.state.get().n,2);
  assert.equal((await req("add",{input:"wrong"})).status,400);
  const read=await (await req("read",{})).json();assert.equal(read.result,2);assert.equal(engine.observers.isCurrent(id),false);
  assert.equal((await http.request("/api/doc",{headers:{"x-duet-app-id":"other"}})).status,409);
  assert.equal((await http.request("/api/doc",{headers:{"x-duet-protocol":"6"}})).status,409);
  assert.equal((await http.request("/api/shot",{method:"POST"})).status,404);
  await engine.stop();
});
