import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import { Engine } from "../duet/engine.js";
import { createHttpApp } from "../duet/http.js";
import { app } from "../template/app.js";

test("browser preserves local drafts, applies typed operations, and publishes render metadata", async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"duet-browser-"));
  const store=await Engine.create(app,"http://127.0.0.1");
  const server=serve({fetch:createHttpApp(app,{engine:store,url:store.url,ready:true}).fetch,port:0,hostname:"127.0.0.1"}) as Server;
  t.after(async()=>{await store.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});});
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();});
  if (!server.listening) await new Promise<void>(r=>server.once("listening",r));
  const port=(server.address() as {port:number}).port;
  const page=await browser.newPage();
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const note=page.getByRole("region",{name:"Text"});
  await page.locator("#text").fill("human draft");
  await store.run("set_text",{text:"llm update"},"llm");
  await page.waitForFunction(()=>document.querySelector("#shot")?.textContent==="llm update");
  assert.equal(await page.locator("#text").inputValue(),"human draft");
  await note.getByRole("button",{name:"Apply",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#shot")?.textContent==="human draft");
  assert.equal(store.snapshot().doc.text,"human draft");
  assert.equal(await page.locator("html").getAttribute("data-duet-revision"),store.state.revision);
  // Failed sends retain the local draft while external updates continue.
  await page.locator("#text").fill("retry draft");
  await page.route("**/api/op/set_text",route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({ok:false,error:{code:"OperationError",message:"test failure"}})}),{times:1});
  await note.getByRole("button",{name:"Apply",exact:true}).click();
  await note.getByRole("alert").waitFor();
  assert.equal(await page.locator("#text").inputValue(),"retry draft");
  await store.run("set_text",{text:"external while failed"});
  await page.waitForFunction(()=>document.querySelector("#shot")?.textContent==="external while failed");
  assert.equal(await page.locator("#text").inputValue(),"retry draft");
  let sends=0, release!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(r=>release=r), intercepted=new Promise<void>(r=>entered=r);
  await page.route("**/api/op/set_text",async route=>{sends++;entered();await gate;await route.continue();});
  // Both clicks happen before React renders the disabled state.
  await note.getByRole("button",{name:"Apply",exact:true}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  await intercepted; assert.equal(sends,1);
  assert.equal(await page.locator("#text").isDisabled(),true);
  release();
  await page.waitForFunction(()=>document.querySelector("#shot")?.textContent==="retry draft");
  assert.equal(sends,1); await page.unroute("**/api/op/set_text");
  await page.locator("#text").fill("discard me");
  await note.getByRole("button",{name:"Cancel",exact:true}).click();
  assert.equal(await page.locator("#text").inputValue(),"retry draft");
  // Verify both DOM capture and the screenshot endpoint.
  const shot=await page.locator("#app").screenshot();assert.ok(shot.byteLength>100);
  const previous=process.env.DUET_SHOT_ORIGIN;
  process.env.DUET_SHOT_ORIGIN=`http://127.0.0.1:${port}`;
  t.after(async()=>{
    if(previous===undefined)delete process.env.DUET_SHOT_ORIGIN;else process.env.DUET_SHOT_ORIGIN=previous;
    const holder=globalThis as unknown as {__duetShot?:{browser:{close():Promise<void>}}};
    await holder.__duetShot?.browser.close();
  });
  const image=await store.run("render_screenshot",{path:"/"}) as {data:string};
  assert.equal(Buffer.from(image.data,"base64").subarray(1,4).toString(),"PNG");

  // The box: a drag previews locally and sends once, on release.
  const box=page.getByLabel("Draggable box");
  const board=box.locator("..");
  const scale=async()=>(await board.boundingBox())!.width/400;
  // Waits until both the screen and the shared state show the expected position.
  const settle=async(expected:{x:number;y:number})=>{
    await page.waitForFunction(e=>document.querySelector('[aria-label="Box"] output')?.textContent===`(${e.x}, ${e.y})`,expected);
    for (let i=0;i<100;i++) {
      const b=store.snapshot().doc.box;
      if(b.x===expected.x&&b.y===expected.y)return;
      await new Promise(r=>setTimeout(r,20));
    }
  };
  const drag=async(dx:number,dy:number,external=false)=>{
    const r=(await box.boundingBox())!, s=await scale();
    const seq=store.state.seq;
    await page.mouse.move(r.x+10,r.y+10);await page.mouse.down();
    await page.mouse.move(r.x+10+dx*s,r.y+10+dy*s,{steps:4});
    assert.equal(store.state.seq,seq,"no send before release");
    if(external)await store.run("set_text",{text:"during drag"},"llm");
    await page.mouse.up();
  };
  await drag(40,20);
  await settle({x:80,y:60});
  assert.deepEqual(store.snapshot().doc.box,{x:80,y:60});
  // Until the doc shows the move, the box stays where it was released (no jump back).
  let releaseMove!:()=>void;const moveGate=new Promise<void>(r=>releaseMove=r);
  await page.route("**/api/op/move_box",async route=>{await moveGate;await route.continue();},{times:1});
  await drag(40,0);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('[aria-label="Box"] output').textContent(),"(120, 60)");
  assert.deepEqual(store.snapshot().doc.box,{x:80,y:60});
  releaseMove();
  await settle({x:120,y:60});
  // Positions are clamped to the board.
  await drag(1000,1000);
  await settle({x:320,y:160});
  assert.deepEqual(store.snapshot().doc.box,{x:320,y:160});
  await drag(-1000,-1000);
  await settle({x:0,y:0});
  // No assertion or deliberate pause between press, move, and release.
  for (let i=0;i<20;i++) {
    const b=store.snapshot().doc.box;
    const r=(await box.boundingBox())!, s=await scale();
    const dx=i%2===0?15:-15;
    await page.mouse.move(r.x+10,r.y+10);
    await page.mouse.down();
    await page.mouse.move(r.x+10+dx*s,r.y+10);
    await page.mouse.up();
    await settle({x:b.x+dx,y:b.y});
    assert.equal(store.snapshot().doc.box.x,b.x+dx,`quick drag ${i}`);
  }
  // pointercancel discards the drag without sending.
  const original=store.snapshot();
  await box.evaluate(element=>{
    const r=element.getBoundingClientRect();
    const dispatch=(type:string,dx:number)=>element.dispatchEvent(new PointerEvent(type,{
      bubbles:true,pointerId:1,pointerType:"mouse",button:0,buttons:1,clientX:r.left+10+dx,clientY:r.top+10,
    }));
    dispatch("pointerdown",0);dispatch("pointermove",10);dispatch("pointercancel",10);dispatch("pointerup",10);
  });
  await settle(original.doc.box);
  assert.equal(store.state.revision,original.revision);
  // A quick release can arrive at a new position without a final pointermove.
  const quickBefore=store.snapshot().doc.box;
  const s=await scale();
  await box.evaluate((element,{dx,dy})=>{
    const r=element.getBoundingClientRect();
    const event=(type:string,x:number,y:number)=>element.dispatchEvent(new PointerEvent(type,{
      bubbles:true,pointerId:1,pointerType:"mouse",button:0,buttons:type==="pointerup"?0:1,clientX:r.left+10+x,clientY:r.top+10+y,
    }));
    event("pointerdown",0,0);
    event("pointerup",dx,dy);
  },{dx:15*s,dy:10*s});
  await settle({x:quickBefore.x+15,y:quickBefore.y+10});
  assert.deepEqual(store.snapshot().doc.box,{x:quickBefore.x+15,y:quickBefore.y+10});
  // An external update during a drag does not disturb it.
  const before=store.snapshot().doc.box;
  await drag(20,20,true);
  await settle({x:before.x+20,y:before.y+20});
  assert.deepEqual(store.snapshot().doc.box,{x:before.x+20,y:before.y+20});

  await page.setViewportSize({width:1440,height:1150});
  const artifactDir = process.env.DUET_TEST_ARTIFACT_DIR;
  if (artifactDir) fs.mkdirSync(artifactDir, {recursive:true});
  await page.screenshot({...(artifactDir ? {path:path.join(artifactDir,"duet-template-desktop.png")} : {}),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({...(artifactDir ? {path:path.join(artifactDir,"duet-template-mobile.png")} : {}),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
});
