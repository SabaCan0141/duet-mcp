import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DocStore } from "../duet/doc.js";
import { createHttpApp } from "../duet/http.js";
import type { AppDef } from "../duet/types.js";

test("HTTP returns paired full snapshots and rejects old clients / wrong app identity", async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"duet-http-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const app:AppDef<{text:string}>={id:"http-test",version:"1",webDist:dir,initialDoc:()=>({text:""}),ops:[{
    name:"set",description:"",input:{text:z.string()},handler:({doc},{text})=>{doc.text=text;},
  }]};
  const store=new DocStore(app,dir);const http=createHttpApp(app,()=>store);
  const initial=await (await http.request("/api/doc")).json();
  assert.equal(typeof initial.revision,"string");
  const post=(args:unknown,headers:Record<string,string>={})=>http.request("/api/op/set",{
    method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(args),
  });
  const applied=await(await post({text:"new",baseRevision:initial.revision})).json();
  assert.equal(applied.ok,true);assert.equal(applied.doc.text,"new");
  const conflict=await(await post({text:"old",baseRevision:initial.revision})).json();
  assert.equal(conflict.conflict,true);assert.equal(conflict.doc.text,"new");
  const numeric=await(await post({text:"bad",baseRevision:0})).json();
  assert.match(numeric.rejected,/baseRevision/);
  const wrong=await post({text:"bad",baseRevision:applied.revision},{"x-duet-app-id":"another"});
  assert.equal(wrong.status,409);assert.equal(store.snapshot("human").doc.text,"new");
  const malformed=await(await post(null)).json();assert.ok(malformed.rejected);
  const old=await(await http.request('/api/doc?since=0')).json();assert.equal(old.truncated,true);
});
