import test from "node:test";
import assert from "node:assert/strict";
import { State } from "../duet/state.js";
import { ObserverStore } from "../duet/observers.js";
import { Engine } from "../duet/engine.js";
import { defineApp, createAction } from "../duet/op.js";
import { z } from "zod";
import { awaitChange, observerOps } from "../duet/assets.js";

const action = createAction<{n: number}>();

test("each synchronous update commits including equal values; references cannot mutate the state", () => {
  const state = new State({text:"a", nested:{n:1}}); const before=state.revision;
  state.update(()=>{}); assert.notEqual(state.revision,before); assert.equal(state.seq,1);
  let saved:any;
  state.update(draft=>{saved=draft;draft.text="b";}); saved.text="bad";
  const read=state.get() as any; read.nested.n=9;
  assert.deepEqual(state.get(),{text:"b",nested:{n:1}});
  const revision=state.revision;
  assert.throws(()=>state.update(draft=>{draft.text="bad";throw new Error("no");}),/no/);
  assert.throws(()=>state.update(draft=>{(draft as any).bad=undefined;}),/undefined/);
  assert.throws(()=>state.update(()=>state.update(()=>{})),/nested/);
  assert.throws(()=>state.update((async()=>{}) as any),/synchronous/);
  assert.equal(state.revision,revision);
  assert.throws(()=>new State({then:1}),/reserved/);
  const noRun=(value:object)=>{if(Object.hasOwn(value,"run"))throw new Error("conflict");};
  assert.throws(()=>new State({run:1},noRun),/conflict/);
  const dynamic=new State<Record<string,number>>({},noRun);
  assert.throws(()=>dynamic.update(s=>{s.run=1;}),/conflict/);
});

test("explicit observations, latched waits, disposal and cancellation",async()=>{
  const state=new State({n:0});let checkpoints=0;
  const observers=new ObserverStore(state,()=>{checkpoints++;});
  const id=observers.getObserverID();const other=observers.getObserverID();
  assert.notEqual(id,other); assert.equal(observers.isCurrent(id),false);
  assert.equal(await observers.waitChange(id),true);
  const rev=state.revision;observers.observe(id);assert.equal(state.revision,rev);
  assert.equal(observers.isCurrent(other),false);
  assert.equal(await observers.waitChange(id,0),false);
  const waiting=observers.waitChange(id,1000);
  state.update(()=>{});observers.observe(id);
  assert.equal(await waiting,true);assert.equal(observers.isCurrent(id),true);
  const copy=observers.export();assert.equal(copy.length,2);assert.equal(checkpoints,4);
  const aborted=new AbortController();const p=observers.waitChange(id,1000,{signal:aborted.signal});aborted.abort();
  await assert.rejects(p,{name:"AbortError"});
  const disposed=observers.waitChange(id);observers.dispose(id);await assert.rejects(disposed,{name:"ObserverNotFound"});
  assert.throws(()=>observers.observe(id),{name:"ObserverNotFound"});
  await assert.rejects(observers.waitChange("missing"),{name:"ObserverNotFound"});
  await assert.rejects(observers.waitChange(other,-1),{name:"InvalidTimeout"});
  observers.observe(other);assert.equal(await observers.waitChange(other,5),false);
  const stopped=observers.waitChange(other);observers.stop();await assert.rejects(stopped,{name:"DaemonChanged"});
});

test("async operations interleave; later errors do not roll back committed updates",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const app=defineApp({id:"async",version:"1",initialDoc:()=>({n:0}),actions: {
    slow:action({description:"",handler:async({doc})=>{doc.update(s=>{s.n++;});await gate;doc.update(s=>{s.n++;});throw new Error("after commits");}}),
    increment:action({description:"",input:z.number(),handler:({doc},n)=>{doc.update(s=>{s.n+=n;});return doc.get().n;}}),
    invalid_result:action({description:"",handler:({doc})=>{doc.update(s=>{s.n++;});return {bad:undefined};}}),
  }});
  const engine=await Engine.create(app,"http://localhost");
  const slow=engine.run("slow");assert.equal(await engine.run("increment",10),11);release();
  await assert.rejects(slow,/after commits/);assert.equal(engine.state.get().n,12);
  await assert.rejects(engine.run("invalid_result"),/invalid_result\/result\/bad/);assert.equal(engine.state.get().n,13);
  await engine.stop();assert.throws(()=>engine.state.update(()=>{}),{name:"DaemonChanged"});
});

test("wait asset observes both initial and timed-out snapshots; restore never initializes",async()=>{
  let init=0,setup=0,cleanup=0;
  const app=defineApp({id:"restore",version:"1",initialDoc:async()=>{init++;return {text:"hi"};},actions: {await_change:awaitChange(),...observerOps()},setup:()=>{setup++;return()=>{cleanup++;};}});
  const first=await Engine.create(app,"http://localhost");const id=first.observers.getObserverID();
  assert.deepEqual(await first.run("await_change",{oid:id}),{text:"hi"});assert.equal(first.observers.isCurrent(id),true);
  assert.deepEqual(await first.run("await_change",{oid:id,timeoutMs:0}),{text:"hi"});
  const checkpoint=first.checkpoint();await first.stop();
  const next=await Engine.create(app,"http://localhost",checkpoint);
  assert.equal(init,1);assert.equal(setup,2);assert.equal(cleanup,1);
  assert.equal(next.state.revision,checkpoint.revision);assert.notEqual(next.ownerId,checkpoint.ownerId);
  assert.equal(next.observers.isCurrent(id),true);next.state.update(()=>{});assert.notEqual(next.state.revision,checkpoint.revision);
  await next.stop();assert.equal(cleanup,2);
});

test("losing ownership during async setup revokes its context and cleans up once",async()=>{
  const owner=new AbortController();let release!:()=>void;let entered!:()=>void;let cleanup=0;
  const setupEntered=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
  let context:import("../duet/types.js").Context<{n:number}>;
  const app=defineApp({id:"setup-abort",version:"1",initialDoc:()=>({n:0}),actions: {},setup:async ctx=>{context=ctx;entered();await gate;return()=>{cleanup++;};}});
  const creating=Engine.create(app,"http://localhost",undefined,owner.signal);
  await setupEntered;owner.abort();
  assert.equal(context!.signal.aborted,true);
  assert.throws(()=>context!.doc.update(s=>{s.n++;}),{name:"DaemonChanged"});
  release();await assert.rejects(creating,{name:"DaemonChanged"});assert.equal(cleanup,1);
});

test("state-key collisions fail on initialization and later updates",async()=>{
  const app=defineApp({id:"keys",version:"1",initialDoc:():Record<string,number>=>({}),actions: {}});
  // Dynamic operations/state cannot always be checked statically.
  const dynamic={...app,actions:{run:{description:"",handler:()=>{}}}};
  await assert.rejects(Engine.create({...dynamic,initialDoc:()=>({run:1})},"http://localhost"),{name:"NameCollision"});
  const engine=await Engine.create(dynamic,"http://localhost");
  assert.throws(()=>engine.state.update(s=>{s.run=1;}),{name:"NameCollision"});
  assert.deepEqual(engine.state.get(),{});await engine.stop();
});
