import { PROTOCOL } from "../duet/protocol.js";
import test from "node:test";
import assert from "node:assert/strict";
import { ClientStore } from "../duet/client-store.js";
import { Engine } from "../duet/engine.js";
import { defineApp, createAction } from "../duet/op.js";
import { createHttpApp } from "../duet/http.js";
import { Transport } from "../duet/transport.js";
import { z } from "zod";
const tick=()=>new Promise(r=>setTimeout(r,10));
const action = createAction<{n: number}>();

test("client combines state and methods without advancing observers; subscription reconnects",async()=>{
  const app=defineApp({id:"client",version:"1",initialDoc:()=>({n:0}),actions: {set:action({description:"",input:z.number(),handler:({doc},n)=>{doc.update(s=>{s.n=n;});return n;}})}});
  const first=await Engine.create(app,"http://localhost");const host={engine:first,url:first.url,ready:true};const http=createHttpApp(app,host);
  const store=new ClientStore({url:first.url,request:((url,init)=>http.request(String(url),init)) as typeof fetch});
  assert.equal(store.getSnapshot(),null);const unsubscribe=store.subscribe(()=>{});
  try {
    for(let n=0;!store.getSnapshot()&&n<100;n++)await tick();
    const doc=store.getSnapshot();assert.equal(doc.n,0);const method=doc.set;
    const oid=await store.getObserverID();assert.equal(first.observers.isCurrent(oid),false);
    await doc.set(2);for(let n=0;store.getSnapshot().n!==2&&n<100;n++)await tick();
    assert.equal(store.getSnapshot().set,method);assert.equal(doc.n,0);
    const once=await store.getDoc();await doc.set(3);assert.equal(once.n,2);
    assert.equal(first.observers.isCurrent(oid),false);
    const cp=first.checkpoint();await first.stop();
    assert.equal(store.getSnapshot().n,3);
    host.engine=await Engine.create(app,first.url,cp);host.engine.state.update(s=>{s.n=4;});
    for(let n=0;store.getSnapshot().n!==4&&n<200;n++)await tick();
    assert.equal(store.getSnapshot().n,4);assert.equal(store.getSnapshot().set,method);
    await store.disposeObserver(oid);assert.throws(()=>host.engine.observers.observe(oid));
  } finally {unsubscribe();await host.engine.stop();}
});
test("transport diagnoses owner changes and does not replay a POST",async()=>{
  let count=0,owner="a";
  const request=(async(url:unknown)=>{
    if(String(url).endsWith("hello"))return Response.json({id:"x",version:"1",protocol:PROTOCOL,ready:true,ownerId:owner});
    count++;owner="b";throw new TypeError("disconnected");
  }) as typeof fetch;
  const transport=new Transport({request});await assert.rejects(transport.op("run"),{name:"DaemonChanged"});assert.equal(count,1);
});
