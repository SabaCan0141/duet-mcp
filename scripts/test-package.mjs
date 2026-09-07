// Install the actual tarball: relative source imports cannot detect missing package files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'duet-package-'));
const consumer = path.join(scratch, 'consumer');
const otherCwd = path.join(scratch, 'unrelated');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let client;
let browser;
async function command(args, cwd = consumer) {
  console.log(`> npm ${args.join(' ')}`);
  try {
    return await exec(npm, args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    console.error(error.stdout, error.stderr);
    throw error;
  }
}
try {
  await fs.mkdir(consumer); await fs.mkdir(otherCwd);
  const metadata = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  const packed = await command(['pack', '--json', '--pack-destination', scratch], repo);
  const [manifest] = JSON.parse(packed.stdout);
  assert(manifest.files.some(f => f.path === 'lib/client.d.ts'));
  assert(manifest.files.some(f => f.path === 'doc/README.jp.md'));
  assert(manifest.files.some(f => f.path === 'template/ui/main.tsx'));
  assert(manifest.files.every(f => /^(lib\/|template\/|README.md$|doc\/README\.jp\.md$|LICENSE$|package.json$)/.test(f.path)), 'unexpected package contents');
  assert(manifest.files.every(f => !/(^|\/)(data|dist|node_modules)\//.test(f.path)), 'generated/private files in tarball');
  await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'duet-package-consumer', private: true, type: 'module',
    dependencies: { [metadata.name]: path.join(scratch, manifest.filename), react: '^18.3.1', 'react-dom': '^18.3.1', zod: '^3.23.8' },
    devDependencies: metadata.devDependencies,
    scripts: {
      typecheck: 'tsc --noEmit && tsc -p template/ui/tsconfig.json',
      build: 'tsc && vite build --config template/ui/vite.config.ts',
    },
  }, null, 2));
  await command(['install', '--no-audit', '--no-fund']);
  await command(['exec', '--', 'playwright', 'install', ...(process.env.CI ? ['--with-deps'] : []), 'chromium']);
  const installed = path.join(consumer, 'node_modules', metadata.name);
  await fs.cp(path.join(installed, 'template'), path.join(consumer, 'template'), { recursive: true });
  await fs.writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: '.', outDir: 'dist', strict: true, skipLibCheck: true },
    include: ['template/*.ts'],
  }, null, 2));
  await command(['run', 'typecheck']);
  await command(['run', 'build']);
  const portServer = net.createServer();
  await new Promise((resolve, reject) => { portServer.once('error', reject); portServer.listen(0, '127.0.0.1', resolve); });
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === 'string'));
  delete env.DUET_SHOT_ORIGIN;
  const start = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(consumer, 'dist/template/main.js')], cwd: otherCwd, env: { ...env, DUET_PORT: String(port) }, stderr: 'pipe' });
    client = new Client({ name: 'package-smoke', version: '1' });
    await client.connect(transport);
  };
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return result;
  };
  const json = async (name, args = {}) => JSON.parse((await invoke(name, args)).content[0].text);
  await start();
  const initial = await json('await_change');
  const changed = await json('set_text', { baseRevision: initial.revision, text: 'Installed package works' });
  assert(changed.ok); assert.equal(changed.doc.text, 'Installed package works');
  assert.equal((await json('set_text', { baseRevision: initial.revision, text: 'stale' })).conflict, true);
  const url = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator('#text').waitFor();
  assert.equal(await page.locator('#text').inputValue(), 'Installed package works');
  const region = page.getByRole('region', { name: 'Shared note' });
  await region.locator('#text').fill('Saved from installed React UI');
  await region.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#shot')?.textContent === 'Saved from installed React UI');
  assert.equal((await json('await_change')).doc.text, 'Saved from installed React UI');
  const uploaded = await fetch(`${url}/api/blob`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'shared blob' });
  assert.equal(uploaded.status, 200);
  const blob = await uploaded.json();
  assert.equal(await (await fetch(`${url}/blob/${blob.id}`)).text(), 'shared blob');
  const blobResult = await invoke('read_blob', { id: blob.id });
  assert(JSON.stringify(blobResult).includes('shared blob'));
  const shot = await invoke('render_screenshot');
  assert(shot.content.some(c => c.type === 'image'));
  assert.deepEqual(errors, []);
  const beforeRestart = await json('await_change');
  await browser.close(); browser = null;
  await client.close(); client = null;
  await start();
  const restored = await json('await_change');
  assert.equal(restored.doc.text, 'Saved from installed React UI');
  assert.notEqual(restored.revision, beforeRestart.revision);
  assert.equal((await json('set_text', { baseRevision: beforeRestart.revision, text: 'stale epoch' })).conflict, true);
  const disk = JSON.parse(await fs.readFile(path.join(consumer, 'data/template.json'), 'utf8'));
  assert.equal(disk.doc.text, restored.doc.text);
  assert.equal(await fs.readFile(path.join(consumer, 'data/template-blobs', blob.id), 'utf8'), 'shared blob');
  for (const dir of [path.join(installed, 'data'), path.join(otherCwd, 'data')]) {
    await assert.rejects(fs.access(dir), { code: 'ENOENT' });
  }
  console.log(`Package smoke test passed: ${manifest.filename} (${manifest.size} bytes).`);
} finally {
  await browser?.close();
  await client?.close();
  await fs.rm(scratch, { recursive: true, force: true });
}
