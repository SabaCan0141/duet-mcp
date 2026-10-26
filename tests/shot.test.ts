import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { takeShot } from "../duet/shot.js";
import type { Context } from "../duet/types.js";

const context = (signal = new AbortController().signal) => ({url:"http://localhost",signal,snapshot:()=>({ownerId:"owner",seq:1})}) as Context<any>;
test("screenshot selection skips only missing browsers and explicit channels never fall back", async t => {
  const seen: string[] = [];
  const failure = new Error("launched but failed");
  const launch = t.mock.method(chromium, "launch", async (options: any) => {
    seen.push(options.channel);
    if(options.channel === "chromium") throw failure;
    throw new Error(`browserType.launch: Chromium distribution '${options.channel}' is not found at /missing`);
  });
  await assert.rejects(takeShot(context(),{}), error=>error===failure);
  assert.deepEqual(seen,["chrome","msedge","chromium"]);
  seen.length=0;
  await assert.rejects(takeShot(context(),{channel:"chrome"}),/not found/);
  assert.deepEqual(seen,["chrome"]);
  launch.mock.mockImplementation(async()=>{throw new Error("permission denied");});
  await assert.rejects(takeShot(context(),{}),/permission denied/);
  launch.mock.mockImplementation(async(options:any)=>{throw new Error(options.channel === "chromium" ? "Executable doesn't exist at /missing" : `Chromium distribution '${options.channel}' is not found`);});
  await assert.rejects(takeShot(context(),{}),/npx playwright install chromium/);
});

test("screenshot applies timeouts, selects the first available browser and always closes it", async t => {
  let closed=0; const seen:string[]=[];const timeouts:number[]=[];let fail=false;
  const page={setDefaultTimeout:(n:number)=>timeouts.push(n),goto:async(_url:string,o:any)=>{timeouts.push(o.timeout);return {ok:()=>true};},waitForFunction:async(_fn:any,_arg:any,o:any)=>{timeouts.push(o.timeout);if(fail)throw new Error("render timeout");},screenshot:async()=>Buffer.from("png"),evaluate:async()=>"owner"};
  t.mock.method(chromium,"launch",async(options:any)=>{seen.push(options.channel);return {newPage:async()=>page,close:async()=>{closed++;}} as any;});
  assert.equal(await takeShot(context(),{timeoutMs:123}),Buffer.from("png").toString("base64"));
  assert.deepEqual(seen,["chrome"]);assert.deepEqual(timeouts,[123,123,123,123]);assert.equal(closed,1);
  fail=true;await assert.rejects(takeShot(context(),{channel:"msedge"}),/render timeout/);assert.equal(closed,2);
  fail=false;const controller=new AbortController();controller.abort(new Error("cancelled"));
  await assert.rejects(takeShot(context(controller.signal),{}),/cancelled/);assert.equal(seen.length,2);
  for(const timeoutMs of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(takeShot(context(),{timeoutMs}),/positive safe integer/);
  assert.equal(seen.length,2);
});

test("auto selection stops at Edge or Chromium when earlier candidates are absent",async t=>{
  let available="msedge";const seen:string[]=[];
  t.mock.method(chromium,"launch",async(options:any)=>{
    seen.push(options.channel);
    if(options.channel!==available)throw new Error(`Chromium distribution '${options.channel}' is not found`);
    return {newPage:async()=>{throw new Error("capture reached");},close:async()=>{}} as any;
  });
  await assert.rejects(takeShot(context(),{}),/capture reached/);
  assert.deepEqual(seen,["chrome","msedge"]);
  seen.length=0;available="chromium";
  await assert.rejects(takeShot(context(),{}),/capture reached/);
  assert.deepEqual(seen,["chrome","msedge","chromium"]);
});

test("cancelling an in-flight capture closes the browser",async t=>{
  const controller=new AbortController();let closed=0;let reject!: (error:Error)=>void;
  const waiting=new Promise<never>((_,no)=>reject=no);
  t.mock.method(chromium,"launch",async()=>({newPage:async()=>{queueMicrotask(()=>controller.abort());return waiting;},close:async()=>{closed++;reject(new Error("browser closed"));}} as any));
  await assert.rejects(takeShot(context(controller.signal),{}),/browser closed/);
  assert(closed>=1);
});
