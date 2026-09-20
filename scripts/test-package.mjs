// Exercise the actual tarball in an independent project, including generated clients.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
const exec=promisify(execFile);
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'duet-package-'));
const consumer=path.join(scratch,'consumer');const otherCwd=path.join(scratch,'unrelated');
const npm=process.platform==='win32'?'npm.cmd':'npm';
let client,browser;
async function command(args,cwd=consumer) {
  console.log(`> npm ${args.join(' ')}`);
  try{return await exec(npm,args,{cwd,timeout:180_000,maxBuffer:4*1024*1024});}
  catch(error){console.error(error.stdout,error.stderr);throw error;}
}
try {
  await fs.mkdir(consumer);await fs.mkdir(otherCwd);
  const [manifest]=JSON.parse((await command(['pack','--json','--pack-destination',scratch],repo)).stdout);
  assert(manifest.files.some(f=>f.path==='lib/cli.js'));
  assert(manifest.files.some(f=>f.path==='lib/client.d.ts'));
  assert(manifest.files.every(f=>/^(lib\/|template\/|README.md$|doc\/(README\.jp|SEMANTICS(?:\.jp)?)\.md$|LICENSE$|package.json$|duet.config.ts$)/.test(f.path)));
  assert(manifest.files.every(f=>!/(^|\/)(data|dist|node_modules|\.duet)\//.test(f.path)));
  assert(!manifest.files.some(f=>f.path==='lib/doc.js'||f.path==='lib/diff.js'));
  assert(manifest.files.some(f=>f.path==='doc/SEMANTICS.md'));
  const bootstrap=path.join(scratch,'cli');await fs.mkdir(bootstrap);
  const tarball=path.join(scratch,manifest.filename);
  await fs.writeFile(path.join(bootstrap,'package.json'),JSON.stringify({private:true,dependencies:{'duet-mcp':tarball}}));
  const installArgs=['install',...(process.env.DUET_TEST_OFFLINE?['--offline']:[]),'--no-audit','--no-fund'];
  await command(installArgs,bootstrap);
  console.log('> duet init consumer (installed CLI)');
  await exec(process.execPath,[path.join(bootstrap,'node_modules/duet-mcp/lib/cli.js'),'init',consumer],{cwd:otherCwd});
  // Test the unpublished tarball in place of the generated release dependency.
  const pkgFile=path.join(consumer,'package.json');
  const pkg=JSON.parse(await fs.readFile(pkgFile,'utf8'));pkg.dependencies['duet-mcp']=tarball;
  await fs.writeFile(pkgFile,JSON.stringify(pkg,null,2));
  await command(installArgs);
  const installed=path.join(consumer,'node_modules','duet-mcp');
  // The consumer resolves its own playwright version, whose browser build may differ from this repository's.
  const cli=[path.join(consumer,'node_modules/playwright/cli.js'),path.join(installed,'node_modules/playwright/cli.js')]
    .find(file=>fsSync.existsSync(file));
  assert(cli,'playwright was not installed in the consumer project');
  console.log('> playwright install chromium (consumer)');
  await exec(process.execPath,[cli,'install','chromium'],{cwd:consumer,timeout:300_000});
  // Generation precedes compilation even on a clean project.
  await command(['run','build']);await command(['run','typecheck']);
  const generated=await fs.readFile(path.join(consumer,'template/duet/browser.ts'),'utf8');assert(generated.includes('import type { app }'));
  const bundleDir=path.join(consumer,'template/ui/dist/assets');
  for(const file of await fs.readdir(bundleDir)){if(file.endsWith('.js')){const text=await fs.readFile(path.join(bundleDir,file),'utf8');assert(!text.includes('node:crypto'));assert(!text.includes('Keep the box within the canvas bounds.'));}}
  const reserve=net.createServer();await new Promise((r,j)=>{reserve.once('error',j);reserve.listen(0,'127.0.0.1',r);});const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));delete env.DUET_SHOT_ORIGIN;
  const start=async()=>{client=new Client({name:'smoke',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(consumer,'dist/template/main.js')],cwd:otherCwd,env:{...env,DUET_PORT:String(port)},stderr:'pipe'}));};
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert(!result.isError,JSON.stringify(result));return result;};
  const json=async(name,args={})=>JSON.parse((await call(name,args)).content[0].text);
  await start();const oid=await json('get_observer_id');
  assert.equal((await json('await_change',{oid})).text,'');
  assert.deepEqual(await json('set_text',{text:'Installed package works'}),{text:'Installed package works'});
  assert.equal((await json('await_change',{oid})).text,'Installed package works');
  const url=`http://127.0.0.1:${port}`;assert.equal((await json('gui_url')).url,url);
  browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('#text').waitFor();assert.equal(await page.locator('#text').inputValue(),'Installed package works');
  const region=page.getByRole('region',{name:'Shared note'});await region.locator('#text').fill('From installed React UI');await region.getByRole('button',{name:'Apply',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#shot')?.textContent==='From installed React UI');assert.equal((await json('await_change',{oid})).text,'From installed React UI');
  const blob=await json('put_blob',{data:Buffer.from('shared blob').toString('base64'),mime:'text/plain'});
  assert.equal(Buffer.from((await json('read_blob',{id:blob.id})).data,'base64').toString(),'shared blob');
  assert((await call('render_screenshot')).content.some(c=>c.type==='image'));assert.deepEqual(errors,[]);
  // No core snapshot file is written; a complete shutdown returns to app initialization.
  await browser.close();browser=null;await client.close();client=null;await start();
  const oid2=await json('get_observer_id');assert.equal((await json('await_change',{oid:oid2})).text,'');
  assert((await client.callTool({name:'await_change',arguments:{oid}})).isError);
  await assert.rejects(fs.access(path.join(consumer,`data/${pkg.name}.json`)),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(consumer,`data/${pkg.name}-blobs`,blob.id),'utf8'),'shared blob');
  for(const dir of [path.join(installed,'data'),path.join(otherCwd,'data')])await assert.rejects(fs.access(dir),{code:'ENOENT'});
  console.log(`Package smoke passed: ${manifest.filename} (${manifest.size} bytes)`);
} finally {await browser?.close();await client?.close();await fs.rm(scratch,{recursive:true,force:true});}
