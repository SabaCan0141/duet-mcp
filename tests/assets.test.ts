import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Engine } from "../duet/engine.js";
import { defineApp, createAction, mergeActions } from "../duet/index.js";
import { blobOps, waitChange, guiUrl } from "../duet/assets.js";

test("optional assets preserve binary bytes and MIME without updating the doc",async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"duet-assets-"));
  const app=defineApp({id:"assets",version:"1",initialDoc:()=>({n:0}),actions: {...blobOps({directory}),wait:waitChange(),url:guiUrl()}});
  const engine=await Engine.create(app,"http://127.0.0.1:8888");
  try {
    const rev=engine.state.revision;
    const bytes=Buffer.from([0,128,255,42]);const stored=await engine.run("put_blob",{data:bytes.toString("base64"),mime:"application/x-duet-test"}) as {id:string};
    const loaded=await engine.run("read_blob",{id:stored.id}) as {data:string;mime:string};
    assert.deepEqual(Buffer.from(loaded.data,"base64"),bytes);assert.equal(loaded.mime,"application/x-duet-test");
    assert.equal(engine.state.revision,rev);
    assert.deepEqual(await engine.run("url"),{url:engine.url});
    const oid=engine.observers.getObserverID();assert.equal(await engine.run("wait",{oid}),true);assert.equal(engine.observers.isCurrent(oid),false);
  } finally {await engine.stop();await fs.rm(directory,{recursive:true,force:true});}
});

test("action maps combine custom and built-in actions and reject duplicate names", async () => {
  const action = createAction<{n: number}>();
  const custom = { increment: action({description: "", handler: ({doc}) => {
    doc.update(draft => { draft.n++; });
    return doc.get().n;
  }}) };
  const builtIn = { url: guiUrl() };
  assert.throws(() => mergeActions(custom, custom), /duplicate action: increment/);
  assert.throws(() => mergeActions(builtIn, {url: custom.increment}), /duplicate action: url/);
  assert.throws(() => mergeActions({then: guiUrl()}), /reserved name: then/);
  const app = defineApp({id:"combined",version:"1",initialDoc:()=>({n:0}),actions:mergeActions(custom,builtIn)});
  const engine = await Engine.create(app,"http://localhost");
  try {
    assert.equal(await engine.run("increment"), 1);
    assert.deepEqual(await engine.run("url"), {url: engine.url});
  } finally { await engine.stop(); }
});
