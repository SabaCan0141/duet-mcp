# duet-mcp

English | [日本語](doc/README.jp.md)

**One shared state for humans through a GUI and LLMs through MCP. Define each operation once.**

[![npm](https://img.shields.io/npm/v/duet-mcp)](https://www.npmjs.com/package/duet-mcp)
[![CI](https://github.com/SabaCan0141/duet-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SabaCan0141/duet-mcp/actions/workflows/ci.yml)

## Start a project

Requires Node.js 22+.

```sh
npx --package=duet-mcp duet init my-app
cd my-app && npm install
npm run dev
```

Open the URL printed by Vite. Edit text or drag the box; the shared state updates for connected clients. `duet init` creates the template, build configuration, dependencies, and scripts in an empty directory.

Read **`template/app.ts`** for shared state and operations, then **`template/ui/main.tsx`** for the screen. Add an action in app.ts and call it from the GUI. Keep the template's rootDir/webDist settings when editing it.

## Define an action once

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

The handler's document, input, and result are typed. Custom actions and built-in actions share the same `actions` object.

In the GUI, import `useDoc` from `../duet/browser`, call `const doc = useDoc()`, and handle the initial `null`. Then call **`await doc.set_text({ text: "hello" })`**. A Node caller imports `getDoc` from `./duet/node` and calls `await getDoc()` first. MCP takes the same `{ text: "hello" }` input.

For local drafts, import `useEdit` from `duet-mcp/react`: begin an edit with `edit.begin(doc.text)`, then submit with `edit.submit(text => doc.set_text({ text }))`. The callback receives the current draft.

## Connect an MCP client

Run `npm run build`, then configure your MCP client to launch `node` with the absolute path to `dist/template/main.js`. The template provides GUI URL, observation, screenshot, and blob actions. For screenshots, install Chromium with `npx playwright install chromium`.

Use `npm run typecheck` to check your app. Generated `template/duet/browser.ts`, `node.ts`, and `connection.ts` need no manual editing.

State lives in memory; your application owns persistence. For update behavior, observation and guarded edits, assets, and takeover, see **[doc/SEMANTICS.md](doc/SEMANTICS.md)**.
