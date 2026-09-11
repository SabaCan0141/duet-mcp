import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

// Exercise the actual port election with custom HTTP and MCP adapters, including
// promotion. A client must never initialize its own store or execute handlers.
test("runApp adapters share the elected daemon and recover through the same call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "duet-boot-"));
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const fixture = path.join(root, "fixture.mjs");
  await writeFile(fixture, `
    import { runApp } from ${JSON.stringify(new URL("../duet/boot.js", import.meta.url).href)};
    import { createInterface } from "node:readline";
    const app = { id: "adapter-test", version: "1", rootDir: ${JSON.stringify(root)}, webDist: "none",
      initialDoc: () => ({ count: 0 }),
      ops: [{ name: "increment", description: "increment", input: {}, handler: ({doc}) => { doc.count++; } }] };
    await runApp(app, {
      http(http, store) {
        http.get("/custom", c => c.json({ pid: process.pid, ...store().snapshot("test") }));
        http.post("/custom", c => c.json(store().run("increment", { baseRevision: store().revision }, "test")));
      },
      async mcp(call) {
        createInterface({ input: process.stdin }).on("line", async line => {
          const { id, method } = JSON.parse(line);
          try { console.log(JSON.stringify({ id, result: await call("/custom", { method }) })); }
          catch (e) { console.log(JSON.stringify({ id, error: e.message })); }
        });
        console.log(JSON.stringify({ ready: true }));
      },
    });
  `);
  const children: ChildProcessWithoutNullStreams[] = [];
  async function start() {
    const child = spawn(process.execPath, [fixture], { env: { ...process.env, DUET_PORT: String(port) } });
    children.push(child);
    let buffer = "", seq = 0;
    const pending = new Map<number, (value: any) => void>();
    let ready!: () => void;
    const started = new Promise<void>(resolve => ready = resolve);
    child.stdout.on("data", b => {
      buffer += b;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.ready) ready();
        else { pending.get(message.id)?.(message); pending.delete(message.id); }
      }
    });
    child.stderr.on("data", () => {});
    await started;
    return { child, request(method: string) {
      return new Promise<any>(resolve => {
        const id = ++seq;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ id, method }) + "\n");
      });
    } };
  }
  try {
    const a = await start(), b = await start();
    assert.equal((await a.request("GET")).result.pid, a.child.pid);
    assert.equal((await b.request("GET")).result.pid, a.child.pid);
    assert.equal((await b.request("POST")).result.doc.count, 1);
    assert.equal((await a.request("GET")).result.doc.count, 1);
    const wrong = await fetch(`http://127.0.0.1:${port}/custom`, { headers: { "x-duet-app-id": "other" } });
    assert.equal(wrong.status, 409);
    a.child.kill();
    await once(a.child, "exit");
    const promoted = (await b.request("GET")).result;
    assert.equal(promoted.pid, b.child.pid);
    assert.equal(promoted.doc.count, 1);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    }
    await rm(root, { recursive: true, force: true });
  }
});
