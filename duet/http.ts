import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Engine } from "./engine.js";
import type { AppDef } from "./types.js";
import { PROTOCOL } from "./protocol.js";
import { daemonChanged, DuetError, errorInfo } from "./errors.js";
import { eventResponse } from "./sse.js";
import { inputForm } from "./operations.js";
import { rootFor } from "./paths.js";
export type Host = { engine?: Engine; url: string; ready: boolean };
export function createHttpApp(app: AppDef, host: Host): Hono {
  const http = new Hono();
  http.onError((error, c) => {
    const info = errorInfo(error);
    const status = info.code === "InvalidInput" ? 400 : info.code === "UnknownOperation" ? 404 : info.code === "NotReady" ? 503 : info.code === "OperationError" ? 500 : 409;
    if (status === 500) console.error("[duet] operation failed", error);
    return c.json({ ok: false as const, error: info, ownerId: host.engine?.ownerId }, status);
  });
  http.use("*", async (c, next) => {
    if (c.req.header("x-duet-app-id") && c.req.header("x-duet-app-id") !== app.id) throw new DuetError("WrongApp");
    if (c.req.header("x-duet-protocol") && c.req.header("x-duet-protocol") !== String(PROTOCOL)) throw new DuetError("ProtocolMismatch");
    if (c.req.header("x-duet-version") && c.req.header("x-duet-version") !== app.version) throw new DuetError("VersionMismatch");
    await next();
  });
  http.get("/api/hello", c => c.json({ id: app.id, version: app.version, protocol: PROTOCOL, ownerId: host.engine?.ownerId ?? "", ready: host.ready, url: host.url }));
  const engine = () => { if (!host.ready || !host.engine) throw new DuetError("NotReady"); return host.engine; };
  http.use("/api/*", async (c, next) => {
    const current = engine(); const expected = c.req.header("x-duet-owner");
    if (expected && expected !== current.ownerId) throw daemonChanged();
    await next();
  });
  http.get("/api/manifest", c => c.json({ names: Object.keys(app.actions), inputs: Object.fromEntries(Object.entries(app.actions).map(([name, op]) => [name, inputForm(op)])), ownerId: engine().ownerId }));
  http.get("/api/doc", c => c.json(engine().snapshot()));
  http.get("/api/events", c => { const e = engine(); return eventResponse(wake => e.subscribe(wake), () => e.snapshot(), AbortSignal.any([c.req.raw.signal, e.controller.signal])); });
  http.get("/internal/replica", c => { const e = engine(); return eventResponse(wake => e.subscribe(wake), () => e.checkpoint(), AbortSignal.any([c.req.raw.signal, e.controller.signal])); });
  http.post("/api/op/:name", async c => {
    if (!c.req.header("x-duet-owner")) throw new DuetError("MissingOwner", "x-duet-owner from /api/hello is required");
    const e = engine(); const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DuetError("InvalidInput");
    const result = await e.run(c.req.param("name"), body.input, c.req.header("x-duet-actor") ?? "human", c.req.raw.signal);
    return c.json({ ok: true as const, ...(result === undefined ? {} : { result }), ownerId: e.ownerId });
  });
  http.post("/api/observers", c => {
    if (!c.req.header("x-duet-owner")) throw new DuetError("MissingOwner");
    const e = engine(); return c.json({ ok: true as const, result: e.observers.getObserverID(), ownerId: e.ownerId });
  });
  http.delete("/api/observers/:id", c => {
    if (!c.req.header("x-duet-owner")) throw new DuetError("MissingOwner");
    const e = engine(); e.observers.dispose(c.req.param("id")); return c.json({ ok: true as const, ownerId: e.ownerId });
  });
  http.all("/api/*", c => c.json({ ok: false as const, error: { code: "NotFound", message: "Unknown endpoint" } }, 404));
  http.get("/*", c => {
    if (!app.webDist) return c.text("No GUI configured", 404);
    const root = path.resolve(rootFor(app), app.webDist);
    const file = path.resolve(root, `.${new URL(c.req.url).pathname}`);
    if (path.relative(root, file).startsWith("..")) return c.text("Not found", 404);
    const actual = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, "index.html");
    if (!fs.existsSync(actual)) return c.text("GUI not built", 404);
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
    return new Response(fs.readFileSync(actual), { headers: { "content-type": mime[path.extname(actual)] ?? "application/octet-stream" } });
  });
  return http;
}
