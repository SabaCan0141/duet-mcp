# duet-mcp

[English](../README.md) | 日本語

**人は GUI、LLM は MCP。同じ状態を共有し、操作は一度だけ定義します。**

[![npm](https://img.shields.io/npm/v/duet-mcp)](https://www.npmjs.com/package/duet-mcp)
[![CI](https://github.com/SabaCan0141/duet-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SabaCan0141/duet-mcp/actions/workflows/ci.yml)

## プロジェクトを始める

Node.js 22+ が必要です。

```sh
npx --package=duet-mcp duet init my-app
cd my-app && npm install
npm run dev
```

Vite が表示する URL を開き、テキスト編集やボックスのドラッグを試してください。共有状態が接続先にも反映されます。`duet init` は空のディレクトリにテンプレート・設定・依存関係・scripts を作ります。

まず **`template/app.ts`** で状態と操作、**`template/ui/main.tsx`** で画面を読みます。app.ts に操作を追加し、GUI から呼び出してください。テンプレートの rootDir / webDist 設定は残します。

## 操作を一度定義する

```ts
import { defineApp, createAction } from "duet-mcp";
import { guiUrl, awaitChange, observerOps } from "duet-mcp/assets";
import { z } from "zod";

type Doc = { text: string };
const action = createAction<Doc>();

export const app = defineApp({
  id: "notes",
  version: "1.0.0",
  initialDoc: (): Doc => ({ text: "" }),
  actions: {
    set_text: action({
      description: "Replace the shared text.",
      input: z.object({ text: z.string() }),
      handler: ({ doc }, { text }) => {
        doc.update(state => { state.text = text; });
        return { text };
      },
    }),
    gui_url: guiUrl(),
    await_change: awaitChange(),
    ...observerOps(),
  },
});
```

handler の文書・入力・戻り値に型が付きます。自作操作と付属操作は同じ `actions` に並べます。

GUI は `../duet/browser` から `useDoc` を import し、`const doc = useDoc()` の初期値 `null` を処理したら、**`await doc.set_text({ text: "hello" })`** で呼び出せます。Node は `./duet/node` の `getDoc` を import し、先に `await getDoc()` します。MCP も同じ `{ text: "hello" }` を渡します。

下書きには `duet-mcp/react` の `useEdit` を使います。`edit.begin(doc.text)` で開始し、`edit.submit(text => doc.set_text({ text }))` で送信すると、callback に現在の下書きが渡ります。

## MCP client と接続する

`npm run build` 後、MCP client に起動コマンド `node` と `dist/template/main.js` の絶対パスを登録します。テンプレートには GUI URL・観測・撮影・blob の操作が含まれます。撮影する場合は `npx playwright install chromium` で Chromium を入れてください。

`npm run typecheck` で型検査できます。生成される `template/duet/browser.ts`・`node.ts`・`connection.ts` は編集不要です。

状態はメモリ上にあり、保存はアプリが担当します。更新・観測と guarded update・付属操作・引き継ぎは **[保証と境界](SEMANTICS.jp.md)**（[English](SEMANTICS.md)）を参照してください。
