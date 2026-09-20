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
  await page.locator("#text").fill("human draft");
  await store.run("set_text",{text:"llm update"},"llm");
  await page.waitForFunction(()=>document.querySelector("#shot")?.textContent==="llm update");
  assert.equal(await page.locator("#text").inputValue(),"human draft");
  await page.getByRole("region",{name:"Shared note"}).getByRole("button",{name:"Apply",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#shot")?.textContent==="human draft");
  assert.equal(store.snapshot().doc.text,"human draft");
  assert.equal(await page.locator("html").getAttribute("data-duet-revision"),store.state.revision);
  // Verify both DOM capture and the screenshot endpoint.
  const shot=await page.locator("#shot").screenshot();assert.ok(shot.byteLength>100);
  const previous=process.env.DUET_SHOT_ORIGIN;
  process.env.DUET_SHOT_ORIGIN=`http://127.0.0.1:${port}`;
  t.after(async()=>{
    if(previous===undefined)delete process.env.DUET_SHOT_ORIGIN;else process.env.DUET_SHOT_ORIGIN=previous;
    const holder=globalThis as unknown as {__duetShot?:{browser:{close():Promise<void>}}};
    await holder.__duetShot?.browser.close();
  });
  const image=await store.run("render_screenshot",{path:"/"}) as {data:string};
  assert.equal(Buffer.from(image.data,"base64").subarray(1,4).toString(),"PNG");
  const controls=page.getByRole("region",{name:"Design settings"});
  await controls.getByLabel("Heading",{exact:true}).fill("Shared canvas");
  await controls.getByLabel("Outline",{exact:true}).check();
  await controls.getByLabel("Accent color").selectOption("blue");
  await controls.getByLabel("Dot grid",{exact:true}).uncheck();
  await controls.getByRole("button",{name:"Apply",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Design settings"] [role="status"]')?.textContent==="Saved");
  assert.equal(store.snapshot().doc.settings.caption,"Shared canvas");
  assert.equal(store.snapshot().doc.settings.style,"outline");
  assert.equal(store.snapshot().doc.settings.grid,false);
  const canvas=page.getByLabel("Canvas: move and resize the box");
  const drag=async(x:number,y:number,dx:number,dy:number,external=false)=>{
    const r=(await canvas.boundingBox())!;
    const px=r.x+x*r.width/720,py=r.y+y*r.height/480;
    await page.mouse.move(px,py);await page.mouse.down();
    await page.mouse.move(px+dx*r.width/720,py+dy*r.height/480,{steps:4});
    assert.equal(await canvas.locator("..").getByRole("button",{name:"Apply",exact:true}).count(),0);
    assert.equal(await canvas.locator("..").getByRole("button",{name:"Cancel",exact:true}).count(),0);
    if(external)await store.run("set_text",{text:"during drag"},"llm");
    await page.mouse.up();
  };
  await drag(300,200,40,20);
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.value==="200");
  await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.disabled);
  assert.equal(store.snapshot().doc.box.x,200);
  for(const corner of ["se","nw","ne","sw"]) {
    const b=store.snapshot().doc.box;
    await drag(corner.includes("w")?b.x:b.x+b.width,corner.includes("n")?b.y:b.y+b.height,corner.includes("w")?-10:10,corner.includes("n")?-10:10);
    await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.disabled);
    assert.equal(store.snapshot().doc.box.width,b.width+10);
    assert.equal(store.snapshot().doc.box.height,b.height+10);
  }
  // No assertion or deliberate pause between press, move, and release.
  for (let i=0;i<20;i++) {
    const b=store.snapshot().doc.box;
    const r=(await canvas.boundingBox())!;
    const dx=i%2===0?15:-15;
    await page.mouse.move(r.x+(b.x+30)*r.width/720,r.y+(b.y+30)*r.height/480);
    await page.mouse.down();
    await page.mouse.move(r.x+(b.x+30+dx)*r.width/720,r.y+(b.y+30)*r.height/480);
    await page.mouse.up();
    await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.disabled);
    assert.equal(store.snapshot().doc.box.x,b.x+dx,`quick drag ${i}`);
  }
  for (const cancellation of ["escape","pointercancel"]) {
    const original=store.snapshot();
    await canvas.evaluate((element,{b,cancellation})=>{
      const r=element.getBoundingClientRect();
      const dispatch=(type:string,dx:number)=>element.dispatchEvent(new PointerEvent(type,{
        bubbles:true,pointerId:1,pointerType:"mouse",button:0,buttons:1,
        clientX:r.left+(b.x+30+dx)*r.width/720,clientY:r.top+(b.y+30)*r.height/480,
      }));
      dispatch("pointerdown",0);dispatch("pointermove",10);
      if(cancellation==="escape")element.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:"Escape"}));
      else dispatch("pointercancel",10);
      dispatch("lostpointercapture",10);dispatch("pointerup",10);
    },{b:original.doc.box,cancellation});
    await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.disabled);
    assert.equal(await page.getByLabel("Box x",{exact:true}).inputValue(),String(original.doc.box.x));
    assert.equal(store.state.revision,original.revision);
  }
  // Capture loss on release must not discard the last drag position.
  const captureBefore=store.snapshot().doc.box;
  await canvas.evaluate((element,b)=>{
    const r=element.getBoundingClientRect();
    for(const [type,dx] of [["pointerdown",0],["pointermove",12],["lostpointercapture",12],["pointerup",12]] as const) {
      element.dispatchEvent(new PointerEvent(type,{
        bubbles:true,pointerId:1,pointerType:"mouse",button:0,
        buttons:type==="pointerdown"||type==="pointermove"?1:0,
        clientX:r.left+(b.x+30+dx)*r.width/720,clientY:r.top+(b.y+30)*r.height/480,
      }));
    }
  },captureBefore);
  await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.disabled);
  assert.equal(store.snapshot().doc.box.x,captureBefore.x+12,"capture loss must commit, not roll back");
  // A quick release can arrive at a new position without a final pointermove.
  const quickBefore=store.snapshot().doc.box;
  await canvas.evaluate((element, b) => {
    const r=element.getBoundingClientRect();
    const event=(type:string,dx:number,dy:number)=>element.dispatchEvent(new PointerEvent(type,{
      bubbles:true,pointerId:1,pointerType:"mouse",button:0,buttons:type==="pointerup"?0:1,
      clientX:r.left+(b.x+30+dx)*r.width/720,clientY:r.top+(b.y+30+dy)*r.height/480,
    }));
    event("pointerdown",0,0);
    event("pointerup",15,10);
  },quickBefore);
  await page.waitForFunction(x=>document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.value===String(x),quickBefore.x+15);
  await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.disabled);
  assert.equal(store.snapshot().doc.box.x,quickBefore.x+15);
  assert.equal(store.snapshot().doc.box.y,quickBefore.y+10);
  const before=store.snapshot().doc.box;
  await drag(before.x+30,before.y+30,20,20,true);
  await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('[aria-label="Box x"]')?.disabled);
  assert.equal(store.snapshot().doc.box.x,before.x+20);
  const waitForCanvasSize = () => page.waitForFunction(() => {
    const canvas = document.querySelector("canvas")!;
    return Math.abs(canvas.width - (canvas.getBoundingClientRect().width - 2) * devicePixelRatio) < 2;
  });
  await page.setViewportSize({width:1440,height:1150});
  await waitForCanvasSize();
  const artifactDir = process.env.DUET_TEST_ARTIFACT_DIR;
  if (artifactDir) fs.mkdirSync(artifactDir, {recursive:true});
  await page.screenshot({...(artifactDir ? {path:path.join(artifactDir,"duet-studio-desktop.png")} : {}),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await waitForCanvasSize();
  await page.screenshot({...(artifactDir ? {path:path.join(artifactDir,"duet-studio-mobile.png")} : {}),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
});
