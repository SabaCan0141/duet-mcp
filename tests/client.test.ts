import test from "node:test";
import assert from "node:assert/strict";
import { ClientStore, type Observed } from "../duet/client-store.js";
import { EditSession } from "../duet/edit.js";
import { requestWithRecovery, OutcomeUnknown, Reached } from "../duet/transport.js";
import type { RunResult } from "../duet/protocol.js";
const tick = () => new Promise<void>(r => setImmediate(r));
const snap=(revision:string,x=0)=>({revision,actor:"human",doc:{x},activity:{llm:0}});
function network() {
  const calls: {url:string; init?:RequestInit; resolve:(v:Response)=>void; reject:(e:unknown)=>void}[]=[];
  const fetcher=((url:unknown,init?:RequestInit)=>new Promise<Response>((resolve,reject)=>{
    calls.push({url:String(url),init,resolve,reject});
    init?.signal?.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
  })) as typeof fetch;
  const respond=(i:number,value:unknown)=>calls[i]!.resolve(new Response(JSON.stringify(value)));
  return {calls,fetcher,respond};
}
test("one subscription; captured run uses original revision; late responses cannot rewind",async()=>{
  const net=network();const store=new ClientStore(net.fetcher);
  const off=store.subscribe(()=>{});const off2=store.subscribe(()=>{});
  assert.equal(net.calls.length,1);
  net.respond(0,snap("a:0"));await tick();
  const original=store.getSnapshot()!;
  const run=original.run("set",{x:1});
  assert.equal(JSON.parse(net.calls[2]!.init!.body as string).baseRevision,"a:0");
  net.respond(2,{...snap("a:2",2),ok:true});await run;
  net.respond(1,snap("a:1",1));await tick();
  assert.equal(store.getSnapshot()!.doc && (store.getSnapshot()!.doc as any).x,2);
  assert.equal(store.getSnapshot()!.revision,"a:2");
  const second=original.run("set",{});
  assert.equal(JSON.parse(net.calls.at(-1)!.init!.body as string).baseRevision,"a:0");
  net.respond(net.calls.length-1,{...snap("a:2",2),conflict:true,changes:[],truncated:false});await second;
  off();off2();await tick();
});
test("unknown op epoch triggers authoritative refresh; retired responses are invalidated",async()=>{
  const net=network();const store=new ClientStore(net.fetcher);const off=store.subscribe(()=>{});
  net.respond(0,snap("a:9"));await tick();
  const first=store.getSnapshot()!.run("one"); // index 2
  const late=store.getSnapshot()!.run("two"); // index 3
  const rejected=assert.rejects(late,/交代/);
  net.respond(2,{...snap("b:0"),conflict:true,changes:[],truncated:true});await first;await tick();
  assert.equal(store.getSnapshot()!.revision,"a:9");
  assert.equal(net.calls[4]!.url,"/api/doc");
  net.respond(4,snap("b:0"));await tick();
  net.respond(3,{...snap("a:10",10),ok:true});await rejected;
  assert.equal(store.getSnapshot()!.revision,"b:0");
  off();await tick();
});
test("network failure sends an op only once",async()=>{
  const net=network();const store=new ClientStore(net.fetcher);const off=store.subscribe(()=>{});
  net.respond(0,snap("a:0"));await tick();
  const run=store.getSnapshot()!.run("set");const rejected=assert.rejects(run,/自動再送していない/);
  net.calls[2]!.reject(new Error("connection lost"));await rejected;await tick();
  assert.equal(net.calls.filter(c=>c.init?.method==="POST").length,1);
  off();await tick();
});
test("edit keeps original basis and draft through conflict, deduplicates pending sends",async()=>{
  let resolve!:(r:RunResult<unknown>)=>void;let calls=0;
  const base:Observed<unknown>={...snap("a:0"),run:()=>{calls++;return new Promise(r=>{resolve=r;});}};
  const edit=new EditSession<string>();edit.begin(base,"draft");
  assert.throws(()=>edit.begin({...base,revision:"a:1"},"new"),/既に/);
  const first=edit.run("set");assert.equal(edit.run("set"),first);await tick();
  assert.equal(calls,1);assert.throws(()=>edit.setValue("other"),/送信中/);
  resolve({...snap("a:1"),conflict:true,changes:[],truncated:false});await first;
  assert.equal(edit.getSnapshot().value,"draft");assert.equal(edit.getSnapshot().active,true);
  edit.restart({...base,revision:"a:1",run:async()=>({...snap("a:2"),ok:true})},"reviewed");
  await edit.run("set");assert.equal(edit.getSnapshot().active,false);
});
test("edit preserves draft on rejected or unknown outcome",async()=>{
  const edit=new EditSession<string>();
  edit.begin({...snap("a:0"),run:async()=>({...snap("a:0"),rejected:"no"})},"draft");
  await edit.run("set");assert.equal(edit.getSnapshot().value,"draft");
  edit.restart({...snap("a:0"),run:async()=>{throw new Error("unknown");}},"draft");
  await assert.rejects(edit.run("set"));assert.equal(edit.getSnapshot().value,"draft");
  edit.cancel();assert.equal(edit.getSnapshot().active,false);
});
test("transport recovers GET, never replays POST, and respects reached failures",async()=>{
  let requests=0,recoveries=0;
  await assert.rejects(requestWithRecovery(async()=>{requests++;throw new Error("lost");},async()=>{recoveries++;},"POST"),OutcomeUnknown);
  assert.equal(requests,1);assert.equal(recoveries,1);
  requests=0;
  assert.equal(await requestWithRecovery(async()=>{if(++requests===1)throw new Error("lost");return 42;},async()=>{recoveries++;}),42);
  requests=0;
  await assert.rejects(requestWithRecovery(async()=>{requests++;throw new Reached("bad");},async()=>{throw new Error("should not recover");} ),Reached);
  assert.equal(requests,1);
});
