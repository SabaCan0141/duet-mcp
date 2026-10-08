import test from "node:test";
import assert from "node:assert/strict";
import { State } from "../duet/state.js";
import { Engine } from "../duet/engine.js";
import { defineApp } from "../duet/op.js";
import { historyOps } from "../duet/assets.js";
import { replicaSender, restoreReplica, type ReplicaDelta } from "../duet/replica.js";
import { validateCheckpoint } from "../duet/runtime.js";
import { createHttpApp } from "../duet/http.js";
import { ClientStore } from "../duet/client-store.js";

test("bounded history branches, evicts, reuses revisions, and isolates snapshots", () => {
  for (const maxLen of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => new State({}, undefined, undefined, maxLen), {name:"InvalidMaxLen"});
  const single = new State({n:0}); const initial = single.revision;
  single.update(s => {s.n=1;});
  assert.equal(single.at(initial), null); assert.equal(single.undo(), false); assert.equal(single.redo(), false);
  const state = new State({n:0}, undefined, undefined, 3); const r0 = state.revision;
  state.update(s => {s.n=1;}); const r1 = state.revision;
  state.update(s => {s.n=2;}); const r2 = state.revision;
  const copy = state.at(r1) as {n:number}; copy.n=99; assert.equal(state.at(r1)?.n,1);
  assert.equal(state.at("unknown"),null);
  assert.equal(state.undo(),true); assert.equal(state.revision,r1); assert.equal(state.get().n,1);
  assert.equal(state.redo(),true); assert.equal(state.revision,r2); assert.equal(state.seq,4);
  state.undo(); const seq = state.seq;
  assert.throws(() => state.update(() => { throw new Error("fail"); }));
  assert.equal(state.seq,seq); assert.equal(state.at(r2)?.n,2);
  state.update(s => {s.n=3;}); const r3 = state.revision;
  assert.notEqual(r3,r2); assert.equal(state.at(r2),null); assert.equal(state.redo(),false);
  state.update(s => {s.n=4;}); assert.equal(state.at(r0),null); assert.equal(state.at(r1)?.n,1);
  assert.throws(() => state.update(() => {state.undo();}), /nested/);
  state.undo(); state.undo(); const boundary = state.seq;
  assert.equal(state.undo(),false); assert.equal(state.seq,boundary);
});

test("history actions wake clients and observers; takeover keeps redo and observations", async () => {
  const app = defineApp({id:"history",version:"1",maxLen:4,initialDoc:()=>({n:0}),actions:historyOps()});
  const engine = await Engine.create(app,"http://localhost");
  const http = createHttpApp(app,{engine,url:engine.url,ready:true});
  const client = new ClientStore({url:engine.url, request:((url,init)=>http.request(String(url),init)) as typeof fetch});
  const unsubscribe = client.subscribe(()=>{});
  const wait = async (n:number) => { for(let i=0;i<100 && client.getSnapshot()?.n!==n;i++) await new Promise(r=>setTimeout(r,5)); assert.equal(client.getSnapshot()?.n,n); };
  try {
    await wait(0);
    const oid=engine.observers.getObserverID(); assert.equal(engine.observers.get(oid),null);
    engine.observers.observe(oid); const original=engine.observers.get(oid)!;
    engine.state.update(s=>{s.n=1;}); const newer=engine.state.revision;
    await wait(1); engine.observers.observe(oid);
    const waiting=engine.observers.waitChange(oid,1000);
    assert.equal(await client.getSnapshot().undo(),true); assert.equal(await waiting,true);
    await wait(0); assert.equal(engine.observers.get(oid),newer); assert.equal(engine.observers.isCurrent(oid),false);
    assert.equal(engine.state.revision,original);
    const checkpoint=engine.checkpoint(); await engine.stop();
    const next=await Engine.create(app,engine.url,checkpoint);
    try {
      assert.equal(next.state.at(newer)?.n,1); assert.equal(next.observers.get(oid),newer);
      assert.equal(await next.run("redo"),true); assert.equal(next.state.revision,newer);
      assert.equal(next.observers.isCurrent(oid),true);
      next.observers.dispose(oid); assert.throws(()=>next.observers.get(oid),{name:"ObserverNotFound"});
      assert.throws(()=>next.observers.get("missing"),{name:"ObserverNotFound"});
    } finally {await next.stop();}
  } finally {unsubscribe();await engine.stop();}
});

test("hooks capture every commit and head move, run outside notifications, and never roll back",async(t)=>{
  const calls: Array<{kind:string;revision:string;n:number;signal:AbortSignal}> = [];
  const errors:unknown[]=[]; t.mock.method(console,"error",(error:unknown)=>errors.push(error));
  let resolve!:()=>void; const pending=new Promise<void>(r=>resolve=r);
  const app=defineApp({id:"hooks",version:"1",maxLen:5,initialDoc:()=>({n:0}),actions:historyOps(),
    onCommit: ({revision,doc},signal)=>{calls.push({kind:"commit",revision,n:doc.n,signal}); if(doc.n===2)throw new Error("sync"); return pending;},
    onChange: async ({revision,doc},signal)=>{calls.push({kind:"change",revision,n:doc.n,signal}); if(doc.n===1)throw new Error("async");},
  });
  const engine=await Engine.create(app,"http://localhost");
  assert.equal(calls.length,0);
  let notifications=0; engine.state.subscribe(()=>{notifications++; assert.equal(calls.length,0);});
  engine.state.update(s=>{s.n=1;}); const r1=engine.state.revision;
  engine.state.update(s=>{s.n=2;}); const r2=engine.state.revision;
  engine.state.undo(); engine.state.redo(); assert.equal(engine.state.redo(),false);
  assert.equal(notifications,4); assert.equal(calls.length,0);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls.map(c=>[c.kind,c.revision,c.n]),[["commit",r1,1],["change",r1,1],["commit",r2,2],["change",r2,2],["change",r1,1],["change",r2,2]]);
  assert.equal(errors.length,3); assert.equal(engine.state.get().n,2);
  const cp=engine.checkpoint(); await engine.stop(); assert(calls.every(c=>c.signal.aborted)); resolve();
  const next=await Engine.create(app,engine.url,cp); assert.equal(calls.length,6); await next.stop();
});

test("replica deltas preserve coalesced commits and redo without resending known snapshots",async()=>{
  const app=defineApp({id:"replica",version:"1",maxLen:3,initialDoc:()=>({n:0}),actions:{}});
  const engine=await Engine.create(app,"http://localhost");
  try {
    const send=replicaSender(()=>engine.checkpoint());
    let cp=restoreReplica(send()); validateCheckpoint(cp,app);
    const receive=()=>{const delta=send() as ReplicaDelta; cp=restoreReplica(delta,cp);validateCheckpoint(cp,app);assert.deepEqual(cp,engine.checkpoint());return delta;};
    engine.state.update(s=>{s.n=1;}); engine.state.update(s=>{s.n=2;});
    assert.equal(receive().entries.length,2);
    engine.state.undo(); assert.equal(receive().entries.length,0);
    engine.state.redo(); assert.equal(receive().entries.length,0);
    engine.observers.getObserverID(); assert.equal(receive().entries.length,0);
    engine.state.undo(); engine.state.update(s=>{s.n=3;}); assert.equal(receive().entries.length,1);
    for(let i=4;i<10;i++)engine.state.update(s=>{s.n=i;});
    const last=receive(); assert.equal(last.entries.length,3); assert.equal(last.revisions.length,3);
    assert.deepEqual(restoreReplica(replicaSender(()=>engine.checkpoint())()),cp);
    assert.throws(()=>restoreReplica(last),{name:"InvalidCheckpoint"});
    assert.throws(()=>restoreReplica({...last,revisions:["missing"]},cp),{name:"InvalidCheckpoint"});
    for(const history of [{...cp.history,head:9},{...cp.history,entries:[]},{entries:[cp.history.entries[0],cp.history.entries[0]],head:0}]) {
      assert.throws(()=>validateCheckpoint({...cp,history},app),{name:"InvalidCheckpoint"});
    }
  } finally {await engine.stop();}
});

test("SSE backpressure coalesces unsent history without losing required snapshots",async()=>{
  const app=defineApp({id:"backpressure",version:"1",maxLen:3,initialDoc:()=>({n:0}),actions:{}});
  const engine=await Engine.create(app,"http://localhost");
  const http=createHttpApp(app,{engine,url:engine.url,ready:true});
  const response=await http.request("/internal/replica"); const reader=response.body!.getReader();
  const read=async()=>{const {value,done}=await reader.read();assert.equal(done,false);return JSON.parse(new TextDecoder().decode(value).slice(6).trim());};
  try {
    engine.state.update(s=>{s.n=1;}); engine.state.update(s=>{s.n=2;}); await Promise.resolve();
    let cp=restoreReplica(await read()); // the queued initial checkpoint
    assert.equal(cp.doc.n,0);
    await Promise.resolve(); // the first delta is now queued
    for(let n=3;n<=6;n++)engine.state.update(s=>{s.n=n;});
    await Promise.resolve();
    cp=restoreReplica(await read(),cp); assert.equal(cp.doc.n,2);
    cp=restoreReplica(await read(),cp); validateCheckpoint(cp,app);
    assert.deepEqual(cp,engine.checkpoint());
    engine.state.undo(); engine.state.redo(); engine.state.undo(); await Promise.resolve();
    const delta=await read(); assert.equal(delta.entries.length,0);
    cp=restoreReplica(delta,cp); assert.deepEqual(cp,engine.checkpoint());
  } finally {await reader.cancel();await engine.stop();}
});
