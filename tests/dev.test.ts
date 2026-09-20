import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
const root = fileURLToPath(new URL("../../", import.meta.url));

test("duet dev reloads definition and config changes without restarting for unrelated UI edits",{timeout:20_000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"duet-dev-"));
  const reserve=createServer();reserve.listen(0,"127.0.0.1");await once(reserve,"listening");const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()));
  await fs.mkdir(path.join(directory,"node_modules"));
  for(const [name,target] of [["duet-mcp",root],["typescript",path.join(root,"node_modules/typescript")]])await fs.symlink(target,path.join(directory,"node_modules",name),"dir");
  await fs.writeFile(path.join(directory,"package.json"),'{"type":"module"}');
  await fs.writeFile(path.join(directory,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",strict:true,skipLibCheck:true,noEmit:true},include:["app*.ts"]}));
  await fs.writeFile(path.join(directory,"duet.config.ts"),'export default { app: "./app.ts" };');
  const source=(name:string)=>`import {defineApp,createAction} from "duet-mcp";const action=createAction<{n:number}>();export const app=defineApp({id:"dev-test",version:"1",port:${port},initialDoc:()=>({n:0}),actions:{${name}:action({description:"test",handler:()=>42})}});`;
  await fs.writeFile(path.join(directory,"app.ts"),source("first"));
  const child=spawn(process.execPath,[path.join(root,"lib/cli.js"),"dev"],{cwd:directory,stdio:"pipe"});let log="";
  child.stdout.on("data",b=>{log+=b;});child.stderr.on("data",b=>{log+=b;});
  const read=async(name:string)=>{
    const until=Date.now()+7000;
    while(Date.now()<until){try{const res=await fetch(`http://127.0.0.1:${port}/api/manifest`);const value=await res.json() as {names:string[];ownerId:string};if(value.names?.includes(name))return value;}catch{}await new Promise(r=>setTimeout(r,30));}
    throw new Error(`No ${name} operation. ${log}`);
  };
  try {
    const initial=await read("first");
    await fs.writeFile(path.join(directory,"unrelated.tsx"),'export const greeting = "UI-only";');
    await new Promise(r=>setTimeout(r,250));assert.equal((await read("first")).ownerId,initial.ownerId);
    await fs.writeFile(path.join(directory,"app.ts"),source("second"));
    const second=await read("second");assert.notEqual(second.ownerId,initial.ownerId);
    await fs.writeFile(path.join(directory,"app-next.ts"),source("third"));
    await fs.writeFile(path.join(directory,"duet.config.ts"),'export default { app: "./app-next.ts" };');
    const third=await read("third");assert.notEqual(third.ownerId,second.ownerId);
    assert((await fs.readFile(path.join(directory,"duet/browser.ts"),"utf8")).includes('"../app-next.js"'));
  } finally {
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}
    await fs.rm(directory,{recursive:true,force:true});
  }
});
