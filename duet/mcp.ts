import { dataDirFor } from "./paths.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BlobStore } from "./blob.js";
import { inputShape } from "./op.js";
import type { AppDef } from "./types.js";
import { MAX_WAIT_MS, WAIT_MS } from "./wire.js";

/** daemon の HTTP を叩く。daemon 自身も自分を叩く。 */
export type Call = <T>(pathname: string, init?: RequestInit) => Promise<T>;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/**
 * conflict を扱えないと詰まるので、それを説明文で担保する。
 * 競合後に最新 doc で意図を見直すことを伝える。
 *
 * op ごとに付くので短く保つこと。activity の説明は await_change 側に 1 度だけ置く。
 */
const CONFLICT_NOTE =
  " baseRevision は意図を決めるために観測した revision（文字列）をそのまま渡す。" +
  "版が変わっていたら handler を実行せず conflict と最新 doc を返す。" +
  "最新 doc を見て意図を見直すこと。同じ引数を新しい版で自動再送しない。" +
  "通信エラーは適用結果が不明な場合がある。まず await_change で現在の状態を確認する。";

/** 基盤が生やすツール。op がこの名前を使うと登録が衝突する。 */
const RESERVED = ["gui_url", "await_change", "render_screenshot", "read_blob"];

export function registerTools<Doc>(server: McpServer, app: AppDef<Doc>, call: Call): void {
  const blobs = new BlobStore(app.id, dataDirFor(app));

  const clash = app.ops.filter((o) => RESERVED.includes(o.name)).map((o) => o.name);
  if (clash.length > 0) {
    throw new Error(`op の名前が基盤のツールと衝突している: ${clash.join(", ")}`);
  }

  const post = (pathname: string, body: unknown) =>
    call(pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // ---- アプリが定義した op をそのままツールにする ----
  for (const op of app.ops) {
    server.registerTool(
      op.name,
      {
        title: op.name,
        description: op.description + CONFLICT_NOTE,
        inputSchema: inputShape(op),
      },
      async (args) => json(await post(`/api/op/${encodeURIComponent(op.name)}`, args)),
    );
  }

  // ---- どこで開いているか ----
  // ポートは app.id から導出されるので、人は自力で知りようがない。
  // 「ブラウザで開きたい」と言われたら、これを呼んで URL を伝えること。
  server.registerTool(
    "gui_url",
    {
      title: "gui_url",
      description:
        "人が操作する GUI の URL を返す。ポートは app.id から導出されるので、" +
        "人に「どこで開いているか」を聞かれたらこれで答えること。",
      inputSchema: {},
    },
    async () => json(await call("/api/hello")),
  );

  // ---- 人間の操作を待つ ----
  server.registerTool(
    "await_change",
    {
      title: "await_change",
      description:
        "省略すると現在の doc と revision を即時取得する。sinceRevision は観測した文字列をそのまま渡す。" +
        "その版以後のコミットを待ち、既に変更があれば即返す。until は待つ op 名を絞る。" +
        "全応答に doc が載る。truncated は差分を説明できないという意味。doc を確認すること。" +
        "再起動や履歴の保持範囲外でも最新 doc を即返す。timedOut の場合も doc と revision を組で読む。" +
        "changes は対象 op の変更説明で、連続した同じ参加者の同じ op は count にまとまる。" +
        "activity は最終活動からの経過ミリ秒で、編集完了や優先権は保証しない。activity 自体では起床しない。",
      inputSchema: {
        sinceRevision: z
          .string()
          .optional()
          .describe("直前に観測した revision。省略すると待たずに今の doc を返す。"),
        until: z.array(z.string()).optional().describe("待つ op 名。省略すると任意の変更。"),
        timeoutMs: z.number().optional().describe(`既定 ${WAIT_MS}、上限 ${MAX_WAIT_MS}。`),
      },
    },
    async ({ sinceRevision, until, timeoutMs }) => {
      // sinceRevision は任意。省略すると http.ts の「待たずに今の doc を返す」経路に落ちる。
      // 初回にはまだ観測識別子を持っていない。
      const q = new URLSearchParams();
      if (sinceRevision !== undefined) q.set("since", String(sinceRevision));
      if (until?.length) q.set("until", until.join(","));
      if (timeoutMs !== undefined) q.set("timeout", String(Math.min(timeoutMs, MAX_WAIT_MS)));
      return json(await call(`/api/doc?${q}`));
    },
  );

  // ---- 描画結果を見る。人が見ている GUI をそのまま撮る ----
  server.registerTool(
    "render_screenshot",
    {
      title: "render_screenshot",
      description:
        "同じ文書を GUI の別セッションで描画した PNG を返す。人間の下書きやスクロール位置は共有しない。" +
        "path を渡すとその画面へ移動してから撮る（GUI が解釈する URL をそのまま書く）。",
      inputSchema: {
        path: z.string().optional().describe('既定 "/"。例: "/board/2?debug=1"'),
      },
    },
    async ({ path }) => {
      const r = await post("/api/shot", { path });
      const { data } = r as { data: string };
      return { content: [{ type: "image" as const, data, mimeType: "image/png" }] };
    },
  );

  // ---- blob（画像などの実体）。不変なので daemon を通さない ----
  server.registerTool(
    "read_blob",
    {
      title: "read_blob",
      description: "blob を読む。画像なら画像として返す。id は doc から得る。",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const found = blobs.get(id);
      if (!found) return json({ error: `blob not found: ${id}` });
      if (found.mime.startsWith("image/")) {
        return {
          content: [
            { type: "image" as const, data: found.bytes.toString("base64"), mimeType: found.mime },
          ],
        };
      }
      return json({ id, mime: found.mime, text: found.bytes.toString("utf8") });
    },
  );
}
