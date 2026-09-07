import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DocStore } from "../duet/doc.js";
import { assertJson } from "../duet/diff.js";
import { parseRevision } from "../duet/protocol.js";
import type { AppDef, Op } from "../duet/types.js";

const ops: Op<any>[] = [
  { name: "set", description: "", input: { key: z.string(), value: z.any() }, handler: ({doc}, {key, value}) => { doc[key] = value; } },
  { name: "reject", description: "", input: {}, handler: ({doc, reject}) => { doc.x = 99; return reject("no"); } },
];
function fixture(t: { after(fn: () => void): void }, extra: Op<any>[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app: AppDef<any> = { id: "test", version: "1", initialDoc: () => ({ x: 0, source: "old", summary: "", cards: [{id:"A",title:"same"},{id:"B",title:"same"}] }), ops: [...ops, ...extra], webDist: "" };
  const store = new DocStore(app, dir);
  const set = (key: string, value: unknown) => store.run("set", {baseRevision: store.revision, key, value}, "human");
  return { dir, app, store, set };
}

test("stale intentions and array positions are rejected before the handler", (t) => {
  let runs = 0;
  const {store, set} = fixture(t, [{name:"summarize",description:"",input:{},handler:({doc})=>{runs++;doc.summary="old summary";}},
    {name:"rename_first",description:"",input:{},handler:({doc})=>{runs++;doc.cards[0].title="for A";}}]);
  const base = store.revision;
  set("source", "new");
  assert.equal("conflict" in store.run("summarize",{baseRevision:base},"llm"), true);
  const base2 = store.revision;
  set("cards", [{id:"B",title:"same"},{id:"A",title:"same"}]);
  assert.equal("conflict" in store.run("rename_first",{baseRevision:base2},"llm"),true);
  assert.equal(runs,0);
});
test("no-op and reject preserve revision; old numeric wire input is explained", (t) => {
  const {store,set} = fixture(t);
  const base = store.revision;
  assert.equal("ok" in set("x",0),true);
  assert.equal(store.revision,base);
  const result = store.run("reject",{baseRevision:base},"human");
  assert.equal("rejected" in result,true);
  assert.equal(result.doc.x,0);
  assert.equal(store.revision,base);
  assert.match((store.run("set",{baseRevision:0,key:"x",value:1},"llm") as {rejected:string}).rejected,/baseRevision/);
});
test("result and snapshot stay paired and cannot mutate committed state", (t) => {
  const {store,set} = fixture(t);
  const first = set("x",1);
  set("x",2);
  assert.equal(first.doc.x,1);
  assert.notEqual(first.revision,store.revision);
  (first.doc as any).x = 123;
  assert.equal(store.snapshot("human").doc.x,2);
});
test("restart uses a new epoch and never trusts a missing disk log", async (t) => {
  const {store,set,app,dir} = fixture(t);
  const initial = store.revision;
  set("x",1);
  const old = store.revision;
  fs.writeFileSync(store.logFile,"broken\n");
  const next = new DocStore(app,dir);
  assert.equal(parseRevision(next.revision)!.seq,1);
  assert.notEqual(next.revision,old);
  assert.equal("conflict" in next.run("set",{baseRevision:old,key:"x",value:2},"llm"),true);
  const result = await next.wait(initial,undefined,10000,"llm");
  assert.equal(result.truncated,true);
  assert.equal(result.doc.x,1);
  assert.equal(result.timedOut,false);
});
test("snapshot save failure leaves state unchanged; auxiliary log failure still succeeds", (t) => {
  const {store,set,dir} = fixture(t);
  fs.mkdirSync(store.file);
  const base = store.revision;
  assert.throws(()=>set("x",1));
  assert.equal(store.revision,base);
  assert.equal(store.snapshot("human").doc.x,0);
  fs.rmdirSync(store.file);
  fs.mkdirSync(store.logFile);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  assert.equal("ok" in set("x",2),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"test.json"),"utf8")).doc.x,2);
  assert.equal(errors.length, 1);
});
test("Promise and invalid JSON fail before commit, even through an unsafe cast", async (t) => {
  const {store} = fixture(t,[{name:"async",description:"",input:{},handler:(async ({doc}: any)=>{doc.x=8;throw new Error("later");}) as any},
    {name:"bad_result",description:"",input:{},handler:({doc})=>{doc.x=8;return new Date() as any;}}]);
  const base=store.revision;
  assert.throws(()=>store.run("async",{baseRevision:base},"llm"),/同期/);
  assert.throws(()=>store.run("bad_result",{baseRevision:base},"llm"),/JSON/);
  await new Promise(r=>setImmediate(r));
  assert.equal(store.revision,base);
  assert.equal(store.snapshot("human").doc.x,0);
  assert.throws(()=>assertJson(Array(2)),/undefined/);
  const cycle:any={};cycle.self=cycle;
  assert.throws(()=>assertJson(cycle),/循環/);
});
test("wait includes changes between calls and captures its own snapshot", async (t) => {
  const {store,set}=fixture(t);
  const base=store.revision;
  set("x",1);
  const immediate=store.wait(base,undefined,10000,"llm");
  set("x",2);
  assert.equal((await immediate).doc.x,1);
  const waiting=store.wait(store.revision,["set"],10000,"llm");
  set("x",3);
  set("x",4);
  assert.equal((await waiting).doc.x,3);
});
test("filtered waiter wakes when retained history expires; explanations have a byte bound", async (t) => {
  const {store,set}=fixture(t);
  const pending=store.wait(store.revision,["never"],10000,"llm");
  for(let i=1;i<=1001;i++)set("x",i);
  const result=await pending;
  assert.equal(result.truncated,true);
  assert.equal(result.timedOut,false);
  const base=store.revision;
  set("a".repeat(33000),true);
  const huge=await store.wait(base,undefined,10000,"llm");
  assert.equal(huge.truncated,true);
  assert.deepEqual(huge.changes,[]);
});
test("aborted and timed-out waits return full snapshots", async(t)=>{
  const {store,set}=fixture(t);
  const ctrl=new AbortController(); ctrl.abort();
  assert.equal((await store.wait(store.revision,undefined,10000,"llm",ctrl.signal)).timedOut,true);
  const pending=store.wait(store.revision,["never"],5,"llm");
  set("x",4);
  const result=await pending;
  assert.equal(result.timedOut,true);assert.equal(result.doc.x,4);
});
