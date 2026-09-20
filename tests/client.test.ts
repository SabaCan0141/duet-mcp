import test from "node:test";
import assert from "node:assert/strict";
import { ClientStore } from "../duet/client-store.js";
import { EditSession } from "../duet/edit.js";
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
    if(String(url).endsWith("hello"))return Response.json({id:"x",version:"1",protocol:7,ready:true,ownerId:owner});
    count++;owner="b";throw new TypeError("disconnected");
  }) as typeof fetch;
  const transport=new Transport({request});await assert.rejects(transport.op("run"),{name:"DaemonChanged"});assert.equal(count,1);
});
test("edit helper preserves failed drafts and accepts typed callback results",async()=>{
  const edit=new EditSession<string>();edit.begin("draft");
  await assert.rejects(edit.submit(async()=>{throw new Error("failed");}),/failed/);
  assert.equal(edit.getSnapshot().value,"draft");assert.equal(edit.getSnapshot().active,true);
  assert.equal(await edit.submit(async()=>42),42);assert.equal(edit.getSnapshot().active,false);
});

test("submit reads the current draft and rejects inactive or concurrent submissions",async()=>{
  const edit = new EditSession<string>();
  let calls = 0;
  await assert.rejects(edit.submit(() => { calls++; }), /No active edit/);
  assert.equal(calls, 0);
  edit.begin("old");
  const submit = edit.submit; // Same function captured by a previous React render.
  edit.setValue("latest");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sending = submit(async value => { assert.equal(value, "latest"); await gate; return value.length; });
  await assert.rejects(submit(() => { calls++; }), /being submitted/);
  assert.throws(() => edit.setValue("too late"), /being submitted/);
  release();
  assert.equal(await sending, 6);
  assert.equal(calls, 0);
  await assert.rejects(submit(() => { calls++; }), /No active edit/);
  edit.begin("cancelled");edit.cancel();
  await assert.rejects(submit(() => { calls++; }), /No active edit/);
  const optional = new EditSession<string | undefined>();
  optional.begin(undefined);
  assert.equal(await optional.submit(value => value), undefined);
});
