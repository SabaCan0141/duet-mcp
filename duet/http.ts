import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { BlobStore } from "./blob.js";
import type { DocStore } from "./doc.js";
import { rootFor, dataDirFor } from "./paths.js";
import { takeShot } from "./shot.js";
import type { Actor, AppDef } from "./types.js";
import { baseUrlFor, MAX_WAIT_MS, MIN_WAIT_MS, portFor, WAIT_MS } from "./wire.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function serveFile(root: string, filePath: string): Response | null {
  const rel = path.relative(root, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const type = MIME[path.extname(filePath)] ?? "application/octet-stream";
  return new Response(new Uint8Array(fs.readFileSync(filePath)), {
    headers: { "content-type": type },
  });
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const list = (v: string | undefined): string[] | undefined =>
  v === undefined || v === "" ? undefined : v.split(",").filter(Boolean);

// 下限を切らないと、timeoutMs: 0 が「即 timedOut で返り続ける」空回りになる。
const clampTimeout = (v: number | undefined): number =>
  Math.min(Math.max(v ?? WAIT_MS, MIN_WAIT_MS), MAX_WAIT_MS);

/**
 * 呼び出し元の名前。ヘッダが無ければブラウザなので "human"。
 * MCP プロセスは env の DUET_ACTOR を送ってくる。
 */
const actorOf = (c: Context): Actor => c.req.header("x-duet-actor") || "human";

/**
 * DocStore に触れる唯一の実装。
 * ブラウザも、daemon 自身の MCP 層も、別プロセスの MCP 層も、全部ここを通る。
 * 経路が 1 本なので「daemon かどうかで挙動が変わらない」を維持する必要が無い。
 */
export function createHttpApp<Doc>(app: AppDef<Doc>, getStore: () => DocStore<Doc>): Hono {
  const http = new Hono();
  // verify と実リクエストの間に別アプリへ入れ替わっても操作を渡さない。
  http.use("/api/*", async (c, next) => {
    const expected = c.req.header("x-duet-app-id");
    if (expected !== undefined && expected !== app.id) return c.json({ error: "接続先は別の duet アプリ。" }, 409);
    await next();
  });
  const blobs = new BlobStore(app.id, dataDirFor(app));

  /** DocStore は最初のリクエストまで作られない（生成の遅延は boot.ts 側にある）。 */
  const store = getStore;

  // ---- 正体確認と居場所 ----
  // ポートは app.id から導出されるので、人にも LLM にも見えない。
  // 「どこで開いているか」を答えられる口を基盤が既定で持つ。
  http.get("/api/hello", (c) =>
    c.json({
      id: app.id,
      version: app.version,
      port: portFor(app.id),
      url: baseUrlFor(app.id),
    }),
  );

  // ---- ドキュメント取得 / 待機 ----
  // since を付けると変化があるまで返さない（ロングポーリング）。
  // ブラウザの購読も MCP の await_change もこれ 1 本。
  http.get("/api/doc", async (c) => {
    const since = c.req.query("since");
    return c.json(await store().wait(
      since, list(c.req.query("until")), clampTimeout(num(c.req.query("timeout"))),
      actorOf(c), c.req.raw.signal,
    ));
  });

  // snapshot と操作結果を DocStore が同時に確定する。
  http.post("/api/op/:name", async (c) => {
    const name = c.req.param("name");
    if (!app.ops.some((o) => o.name === name)) return c.json({ error: `unknown op: ${name}` }, 404);
    const args: unknown = await c.req.json().catch(() => ({}));
    return c.json(store().run(name, args, actorOf(c)));
  });

  // ---- 活動の申告 ----
  // 「今この人が触っている」だけを記録する。revision も doc も動かさない。
  // 打鍵ごとに来るので、応答に doc を載せない（載せると 1 打鍵ごとに全状態が往復する）。
  http.post("/api/touch", (c) => {
    store().touch(actorOf(c));
    return c.json({ ok: true });
  });

  // ---- スクリーンショット（GUI をそのまま撮る）----
  http.post("/api/shot", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    try {
      return c.json({ data: await takeShot(app, store().revision, body.path || "/") });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ---- blob（画像などの実体）----
  http.post("/api/blob", async (c) => {
    const mime = c.req.header("content-type") ?? "application/octet-stream";
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: "empty body" }, 400);
    return c.json(blobs.put(bytes, mime));
  });

  http.get("/api/blob", (c) => c.json(blobs.list()));

  http.get("/blob/:id", (c) => {
    const found = blobs.get(c.req.param("id"));
    if (!found) return c.text("not found", 404);
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        "content-type": found.mime,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  // ---- GUI（vite ビルド成果物）。実ファイルが無ければ index.html を返す ----
  // /api の打ち間違いが GUI の HTML で返ると原因が分からなくなるので、先に落とす。
  http.all("/api/*", (c) => c.json({ error: `unknown endpoint: ${c.req.path}` }, 404));

  const webDist = path.resolve(rootFor(app), app.webDist);
  http.get("/*", (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
    } catch {
      return c.text("bad path", 400);
    }
    const asFile = serveFile(webDist, path.resolve(webDist, rel));
    if (asFile) return asFile;
    const index = serveFile(webDist, path.join(webDist, "index.html"));
    if (index) return index;
    return c.text(`${app.webDist} not built. run: npm run build:web`, 404);
  });

  return http;
}
