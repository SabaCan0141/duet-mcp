import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Hono } from "hono";
import { DocStore } from "./doc.js";
import { createHttpApp } from "./http.js";
import { registerTools, type Call } from "./mcp.js";
import type { AppDef } from "./types.js";
import { Reached, requestWithRecovery } from "./transport.js";
import { baseUrlFor, portFor } from "./wire.js";

function listen(http: Hono, port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    try {
      // 127.0.0.1 に閉じる。LAN から doc を読み書きされないため。
      const server = serve({ fetch: http.fetch, port, hostname: "127.0.0.1" }) as unknown as Server;
      server.once("error", () => {
        // close() にコールバックを渡さないと、listen していないサーバの close が
        // リスナの居ない 'error' を投げて無関係なスタックトレースが出る。
        server.close(() => {});
        resolve(null);
      });
      server.once("listening", () => resolve(server));
    } catch {
      resolve(null);
    }
  });
}

export async function runApp<Doc>(app: AppDef<Doc>): Promise<void> {
  const port = portFor(app.id);
  const base = baseUrlFor(app.id);
  const actor = process.env.DUET_ACTOR ?? "llm";

  let owned: Server | null = null;
  let wrongApp: string | null = null;
  // ポートを握れなければリクエストは来ないので、DocStore は結局作られない。
  // client プロセスがデータファイルに触らないのはこのため。
  let store: DocStore<Doc> | null = null;
  const getStore = (): DocStore<Doc> => (store ??= new DocStore(app));

  /**
   * ポートを握れたプロセスが状態の所有者になる。
   * 決めるのは「所有者は誰か」だけで、呼び出し経路は分岐しない。
   * だから daemon が死んだ後の昇格が、この関数を呼び直すだけで済む。
   */
  const bind = async (): Promise<boolean> => {
    if (owned) return false;
    const bound = await listen(createHttpApp(app, getStore), port);
    if (!bound) return false;
    owned = bound;
    wrongApp = null;
    console.error(`[duet] daemon: ${base} (${app.id} ${app.version})`);
    return true;
  };

  /** 相手が本当に同じアプリの daemon かを確かめる。 */
  const verify = async (): Promise<void> => {
    // 相手は入れ替わりうるので、毎回まっさらから判定し直す。
    wrongApp = null;
    const hello = (await fetch(`${base}/api/hello`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as { id?: string; version?: string } | null;

    if (!hello) {
      wrongApp = `${base} は duet の daemon ではない。別のプロセスがこのポートを使っている。`;
    } else if (hello.id !== app.id) {
      wrongApp = `${base} の daemon は別のアプリ (${hello.id})。${app.id} の状態はそこに無い。`;
    } else if (hello.version !== app.version) {
      console.error(`[duet] daemon の version が違う: ${hello.version} / 自分は ${app.version}`);
    }
    if (wrongApp) console.error(`[duet] ${wrongApp}`);
  };

  if (!(await bind())) {
    console.error(`[duet] client: ${base} の daemon に委譲する（状態は持たない）`);
    await verify();
  }

  const request = async <T>(pathname: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    headers.set("x-duet-actor", actor);
    headers.set("x-duet-app-id", app.id);
    const res = await fetch(`${base}${pathname}`, { ...init, headers });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // 応答が返っている以上 daemon は生きている。昇格の対象ではない。
      throw new Reached(body?.error ?? `${init?.method ?? "GET"} ${pathname} -> ${res.status}`);
    }
    return (await res.json()) as T;
  };

  /**
   * 経路は常に HTTP。daemon 自身も自分を叩く。
   * 接続が切れたら所有者を再確立する。読み取りだけ再試行し、POST は再送しない。
   */
  const call: Call = async <T>(pathname: string, init?: RequestInit): Promise<T> => {
    // 相手が別物だったときも、そいつが消えていれば握り直して自分が所有者になる。
    if (wrongApp) {
      if (!(await bind())) await verify();
      if (wrongApp) throw new Error(wrongApp);
    }
    // client は接続先の交代を見落とさないよう、各呼び出し前にも確認する。
    if (!owned) {
      await verify();
      if (wrongApp) {
        if (!(await bind())) throw new Error(wrongApp);
      }
    }
    return requestWithRecovery(
      () => request<T>(pathname, init),
      async () => {
        if (!(await bind())) {
          await verify();
          if (wrongApp) throw new Error(wrongApp);
        }
      },
      init?.method,
    );
  };

  const mcp = new McpServer({ name: app.id, version: app.version });
  registerTools(mcp, app, call);
  await mcp.connect(new StdioServerTransport());
  console.error(`[duet] mcp connected over stdio as "${actor}"`);

  // 登録はここで行う。**これより前に移動させないこと。**
  //
  // 冒頭で登録すると、op 名の衝突のような起動時の失敗が stderr に 1 行出るだけになる。
  // bind() は既に成功しているのでイベントループは生き続け、GUI は動くのに
  // mcp.connect() には到達しない。「アプリは動いているのに LLM だけ何も見えない」は
  // 一番原因を疑いにくい壊れ方である。接続前に落ちれば MCP クライアントは
  // 起動失敗として扱うので、そちらの方が短く終わる。
  //
  // 握る目的は、稼働中のプロセスを例外で落として "Server disconnected" にしないこと。
  process.on("uncaughtException", (err) => console.error("[uncaught]", err));
  process.on("unhandledRejection", (err) => console.error("[unhandled]", err));

  // プロセスが終了したら daemon も終わる。それだけ。
  // GUI を長く使いたいときは、自分のプロセスを 1 つ立てればそれが daemon になる。
  process.stdin.on("close", () => process.exit(0));
}
