import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { startRuntime } from "../duet/runtime.js";
import { defineApp } from "../duet/op.js";
async function freePort() { const s=createServer();s.listen(0,"127.0.0.1");await once(s,"listening");const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port; }
async function until<T>(read:()=>Promise<T>,accept:(v:T)=>boolean):Promise<T> { const end=Date.now()+8000;let last:T;do {last=await read();if(accept(last))return last;await new Promise(r=>setTimeout(r,20));}while(Date.now()<end);throw new Error(`Timeout: ${JSON.stringify(last)}`); }

test("processes proactively take over a coherent checkpoint without rerunning initialization or in-flight ops",{timeout:30_000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"duet-handoff-"));const port=await freePort();const fixture=path.join(dir,"app.mjs");
  await writeFile(fixture,`
import { startRuntime } from ${JSON.stringify(new URL("../duet/runtime.js",import.meta.url).href)};
import { defineApp, createAction } from ${JSON.stringify(new URL("../duet/op.js",import.meta.url).href)};
import { Transport } from ${JSON.stringify(new URL("../duet/transport.js",import.meta.url).href)};
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const action=createAction();
const app=defineApp({id:"handoff",version:"1",port:${port},initialDoc:()=>{appendFileSync(${JSON.stringify(path.join(dir,"init"))},"init\\n");return {n:0};},
  setup:()=>{appendFileSync(${JSON.stringify(path.join(dir,"setup"))},"setup\\n");},
  actions:{increment:action({description:"",handler:({doc})=>{doc.update(s=>{s.n++;});return doc.get().n;}}),
  observe:action({description:"",handler:({observers})=>{const oid=observers.getObserverID();observers.observe(oid);return oid;}}),
  wait:action({description:"",handler:async({observers,signal})=>{const oid=observers.getObserverID();observers.observe(oid);await observers.waitChange(oid,20000,{signal});return true;}})}});
const runtime=await startRuntime(app);const client=new Transport({url:runtime.url,id:app.id,version:app.version});
createInterface({input:process.stdin}).on("line",async line=>{const {id,command}=JSON.parse(line);try {let result;
if(command==="checkpoint")result=runtime.host.engine?.checkpoint()??runtime.checkpoint;
else if(command==="snapshot")result=await client.call("/api/doc");
else result=await client.op(command);
console.log(JSON.stringify({id,result}));}catch(error){console.log(JSON.stringify({id,error:{name:error.name,message:error.message}}));}});
console.log(JSON.stringify({ready:true}));
process.once("SIGTERM",()=>{void runtime.stop().finally(()=>process.exit());});
`);
  const children:ChildProcessWithoutNullStreams[]=[];
  const start=async()=>{
    const child=spawn(process.execPath,[fixture]);children.push(child);let buffer="",logs="",seq=0;
    const pending=new Map<number,(value:any)=>void>();let ready!:()=>void,reject!:(e:Error)=>void;
    const started=new Promise<void>((yes,no)=>{ready=yes;reject=no;});
    child.stderr.on("data",b=>{logs+=b;});child.once("exit",()=>reject(new Error(logs)));
    child.stdout.on("data",b=>{buffer+=b;let i;while((i=buffer.indexOf("\n"))>=0){const msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(msg.ready)ready();else{pending.get(msg.id)?.(msg);pending.delete(msg.id);}}});
    await started;return{child,request:(command:string)=>new Promise<any>(resolve=>{const id=++seq;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,command})+"\n");})};
  };
  try {
    const a=await start(),b=await start(),c=await start();
    const first=(await a.request("snapshot")).result;
    assert.equal((await b.request("snapshot")).result.ownerId,first.ownerId);
    assert.equal((await b.request("increment")).result,1);
    const oid=(await a.request("observe")).result;
    const wait=b.request("wait");
    const cp=await until(async()=> (await b.request("checkpoint")).result,v=>v.doc.n===1&&v.observers.length===2);
    await until(async()=>(await c.request("checkpoint")).result,v=>v.checkpointSeq===cp.checkpointSeq);
    const death=once(a.child,"exit");a.child.kill("SIGKILL");await death;
    // No call into the MCP/HTTP client is needed to promote a survivor.
    const promoted=await until(async()=>{try{return await (await fetch(`http://127.0.0.1:${port}/api/hello`)).json();}catch{return null;}},v=>v?.ready&&v.ownerId!==first.ownerId);
    const result=await wait;assert(["DaemonChanged","OutcomeUnknown"].includes(result.error?.name));
    const next=(await b.request("snapshot")).result;assert.equal(next.ownerId,promoted.ownerId);assert.equal(next.doc.n,1);assert.equal(next.revision,cp.revision);
    const copy=(await b.request("checkpoint")).result;assert.equal(copy.observers.find((o:any)=>o.id===oid).revision,cp.revision);
    assert.equal((await readFile(path.join(dir,"init"),"utf8")).trim().split("\n").length,1);
    assert.equal((await readFile(path.join(dir,"setup"),"utf8")).trim().split("\n").length,2);
    assert.equal((await b.request("increment")).result,2);
    assert.notEqual((await b.request("snapshot")).result.revision,cp.revision);
    for(const child of [b.child,c.child]){const exited=once(child,"exit");child.kill();await exited;}
    const fresh=await start();assert.equal((await fresh.request("snapshot")).result.doc.n,0);
    assert.equal((await readFile(path.join(dir,"init"),"utf8")).trim().split("\n").length,2);
  } finally {
    for(const child of children) if(child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill("SIGKILL");await exited;}
    await rm(dir,{recursive:true,force:true});
  }
});

test("occupied ports and incompatible versions are errors; app.port is honored",{timeout:10_000},async()=>{
  const port=await freePort();
  const app=defineApp({id:"ports",version:"1",port,initialDoc:()=>({}),actions: {}});
  const owner=await startRuntime(app);
  try {
    await assert.rejects(startRuntime({...app,id:"other"}),{name:"WrongApp"});
    await assert.rejects(startRuntime({...app,version:"2"}),{name:"VersionMismatch"});
    assert.equal(owner.url,`http://127.0.0.1:${port}`);
  } finally {await owner.stop();}
});

test("a joining process cannot promote before receiving its first checkpoint",{timeout:10_000},async()=>{
  const { createServer } = await import("node:http");
  const port=await freePort();let connected!:()=>void;
  const connection=new Promise<void>(r=>connected=r);
  const server=createServer((req,res)=>{
    if(req.url==="/api/hello") {res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"empty-replica",version:"1",protocol:7,ready:true,ownerId:"old"}));}
    else {res.writeHead(200,{"content-type":"text/event-stream"});res.write(": no checkpoint yet\n\n");connected();}
  });
  server.listen(port,"127.0.0.1");await once(server,"listening");
  let initialized=false;
  const app=defineApp({id:"empty-replica",version:"1",port,initialDoc:()=>{initialized=true;return{};},actions: {}});
  const starting=startRuntime(app);const rejected=assert.rejects(starting,{name:"HandoffUnavailable"});
  try {await connection;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rejected;assert.equal(initialized,false);}
  finally {server.closeAllConnections();server.close();}
});

test("initialization failure releases the bound port and never substitutes empty state",{timeout:10_000},async()=>{
  const port=await freePort();
  const failed=defineApp({id:"bad-init",version:"1",port,initialDoc:async()=>{throw new Error("database unavailable");return{};},actions: {}});
  await assert.rejects(startRuntime(failed),/database unavailable/);
  const recovered=await startRuntime({...failed,initialDoc:()=>({restored:true})});
  assert.deepEqual(recovered.host.engine?.state.get(),{restored:true});await recovered.stop();
});
