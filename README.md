# duet-mcp

English | [日本語](doc/README.jp.md)

**Build apps where humans edit through a GUI and LLMs edit the same JSON document through MCP.**

Define each operation once and expose it through both HTTP and MCP. One daemon owns the document,
and callers can wait for changes since their last observation. Designed for discrete operations on
small to medium documents: game boards, task boards, diagrams, and slide outlines.

## Define an operation once

```ts
import { opFactory } from "duet-mcp";
import { z } from "zod";

type Doc = { text: string };
const op = opFactory<Doc>();

op({
  name: "set_text",
  description: "Replace the text.",
  input: { text: z.string() },
  handler: ({ doc, reject }, { text }) => {
    if (text.length > 100) return reject("Use no more than 100 characters.");
    doc.text = text;
  },
});
```

This defines the MCP tool `set_text({ text, baseRevision })` and the HTTP endpoint
`POST /api/op/set_text`. The GUI calls `snap.run("set_text", { text })` from a subscribed snapshot.

**An operation applies to the document revision the caller observed when forming its intent.**
If the document has changed, duet returns `conflict` and the latest document without running the
handler. Even unrelated changes conflict. Read the current document and reconsider the operation;
do not automatically resend the same arguments with a newer revision.

## Use the npm package

Requires Node.js 22 or later and ESM. The React adapter targets React 18.3; input schemas use Zod 3.
CI covers Node.js 22 / 24 on Ubuntu and macOS. Windows startup and build instructions are untested.

The package name is `duet-mcp`. Registry installation becomes available after the first release.
Before publication, use an absolute path to a tarball produced by `npm pack` in place of
`duet-mcp` in the installation command.

```bash
mkdir my-duet-app
cd my-duet-app
npm init -y
npm pkg set type=module
npm install duet-mcp react@^18.3.1 react-dom@^18.3.1 zod@^3.23.8
npm install -D typescript@^5.7.2 vite@^6.0.5 @vitejs/plugin-react@^4.3.4 tailwindcss@^4.3.3 @tailwindcss/vite@^4.3.3 @types/node@^22.10.2 @types/react@^18.3.17 @types/react-dom@^18.3.5
npx playwright install chromium
cp -R node_modules/duet-mcp/template ./template
```

On Linux, use `npx playwright install --with-deps chromium` if system libraries are also needed.
Browser downloads are explicit, not an installation hook. Run the command again after updating Playwright.

Create `tsconfig.json` at the project root:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["template/*.ts"]
}
```

```bash
npx tsc
npx vite build --config template/ui/vite.config.ts
node dist/template/main.js
```

For GUI development, run `npx vite --config template/ui/vite.config.ts` in another terminal.
Register `node` and the absolute path to `<project>/dist/template/main.js` with your MCP client.
When renaming the app, update its directory name, `app.id`, `webDist`, build inputs, and startup path together.

The package exposes four entry points. Direct imports from `lib/` are not public API.

```ts
import { defineApp, opFactory, type AppDef, type Op } from "duet-mcp";
import { runApp } from "duet-mcp/server";
import { useDoc, useEdit, EditSession, refreshDoc } from "duet-mcp/react";
import { portFor, baseUrlFor } from "duet-mcp/wire";
```

`rootDir` is an absolute path to the application root. Documents and blobs are stored under its
`data/` directory. `webDist` is either relative to `rootDir` or an absolute path.
Without `rootDir`, duet uses the process working directory. MCP clients may launch from any directory,
so explicitly derive the root from `import.meta.url`, as the template does.
Keeping the same `rootDir` and `app.id` preserves the storage location across package updates.
When migrating from a copied repository, point `rootDir` at the previous project root.

Update the library with `npm install duet-mcp@<version>`. Your app owns the copied template files.

## Run from the repository

```bash
npm ci
npx playwright install chromium
npm run build
npm start
```

The GUI URL is printed to stderr. `template/` is a starter app built with React and Tailwind CSS.
It includes text fields, notes, checkboxes, radio buttons, a select, an opacity slider, and a real
canvas with a draggable box and four corner resize handles.

The form commits its settings together with **Apply**. Canvas gestures commit on pointer release;
position and size are also editable through number inputs. Escape or pointer cancellation aborts
an active drag. The canvas uses a 720×480 coordinate system with a minimum box size of 64×64.
The operation handler also validates its bounds.

MCP tools `set_settings`, `set_box`, and `set_text` edit the same document. Conflicts preserve the
draft and show the current values for explicit review. Drawing and gestures live in `ui/canvas.tsx`;
commit controls and conflict review live in `ui/edit-actions.tsx`. Edit `ui/style.css` and component
Tailwind classes to customize the appearance. Text-only snapshots from the earlier template display
default values for the additional fields.

```json
{
  "mcpServers": {
    "duet": {
      "command": "node",
      "args": ["<repo>/dist/template/main.js"]
    }
  }
}
```

Replace `<repo>` with an absolute path and adapt the configuration format to your MCP client.
After connecting, call `gui_url` for the GUI URL and `await_change` for the current document.

```bash
DUET_APP=myapp npm start
DUET_APP=myapp npm run dev:web
# Capture the development GUI:
DUET_SHOT_ORIGIN=http://127.0.0.1:5173 DUET_APP=myapp npm start
```

## Documents, operations, and observations

| Name | Contract |
|---|---|
| doc | Application-defined JSON, changed through operations |
| op | A name, description, Zod input schema, and synchronous handler defined once |
| ctx | `{ doc, actor, reject }`; doc is a writable copy |
| revision | An opaque string; pass it back without parsing or arithmetic |
| snapshot | An observation containing `{ doc, revision, actor, activity }` together |
| await_change | Read the current state or wait for commits since an observed revision |

Calling `reject` discards the working copy. An operation that leaves doc unchanged does not advance
the revision. **Query operations with stale revisions also conflict.** The handler is not executed
first to determine whether it is read-only.

Handlers must be short, synchronous functions returning `Json | void`. Promises are rejected by
both the types and runtime. External APIs, file writes, timers, and deferred draft mutations are
outside the handler contract: cloning a document cannot roll back external side effects.
When applying a result computed elsewhere, use the revision of the snapshot that computation used.

Documents and results must be JSON. Properties containing `undefined`, NaN, Map, Date, and cycles
are rejected. Use `delete` to remove properties and `null` for empty values. An `undefined` return
value means there is no result. Assigning `doc = next` only reassigns a local variable; modify the
copy's properties instead.

Invalid input and application rejections return explanations. Unexpected handler or infrastructure
exceptions and persistence failures propagate as transport errors. The MCP SDK validates input
schemas in addition to HTTP-side validation.

## GUI operations and drafts

```tsx
const snap = useDoc<Doc>(); // null before the first response
if (!snap) return <p>Connecting…</p>;

// run uses this snapshot's revision.
const result = await snap.run("move_card", { cardId, beforeCardId });
```

Multiple `useDoc` calls share one subscription. Documents and revisions are applied together;
late responses cannot rewind the state. A saved reference to an older `snap.run` still sends its
original revision.

Use `useEdit` for edits that span time, such as typing or dragging:

```tsx
const snap = useDoc<Doc>();
const edit = useEdit<string>();

// When editing first begins, after a snapshot is available:
edit.begin(snap, snap.doc.text);
edit.setValue(nextText);

// Commit against the revision captured by begin.
const result = await edit.run("set_text", { text: edit.value });
```

- `active`, `value`, `pending`, `result`, and `error` describe the edit state.
- `begin` rejects an already active edit. Subscription updates do not change the draft or its base revision.
- Duplicate `run` calls while pending share one Promise. Disable inputs while `pending`.
- Success ends the edit. Conflicts, rejections, and network failures preserve the draft.
- `cancel()` discards the draft.
- `restart(latestSnapshot, revisedValue)` explicitly replaces the base and reviewed draft.
- `refreshDoc()` requests a refresh and resolves once the subscription confirms the current state.

The template displays the draft and current values with cancel and review controls. A network
failure can leave the outcome unknown; refresh the document before deciding whether to apply again.
Drafts stored only inside a list row can disappear when another participant moves or deletes that row.

The [movable list example](template/ui/card-editing.tsx) keeps an `EditSession` per card ID in a Map
outside the columns. Rows subscribe with `useSyncExternalStore`, so drafts survive remounting after
a move between columns. This example is intended for card-based apps and is not rendered in the
studio template. `EditSession` is the state management class used by `useEdit`.

## Responses and waiting

Operations return one of three normal responses. Each includes the document and revision:

```jsonc
{ "revision": "epoch-a:12", "actor": "llm", "doc": { "text": "hello" },
  "activity": {}, "ok": true }
{ "revision": "epoch-a:12", "actor": "llm", "doc": { "text": "hello" },
  "activity": {}, "rejected": "Use no more than 100 characters." }
{ "revision": "epoch-a:14", "actor": "llm", "doc": { "text": "new" },
  "activity": {}, "conflict": true, "changes": [], "truncated": true }
```

The revision format above is illustrative, not a public contract. A daemon restart changes the
revision even if the document is unchanged. Old operations conflict; waits using old revisions
immediately return the latest document with `truncated: true`.

- `await_change()` immediately reads the current document and revision.
- `await_change({ sinceRevision })` waits for commits after that revision, or returns immediately if they already exist.
- `until: ["move_card"]` filters the operation names to wait for and describe. The returned document is still the full current state.
- `timeoutMs` defaults to 25 seconds, with a minimum of 1 second and maximum of 120 seconds.
- A timeout may still include changes outside the filter. Adopt the returned document and revision together.

`changes` describes operations, actors, counts, and touched JSON Pointers. Consecutive commits by the
same participant using the same operation are grouped. These descriptions do not determine whether
a write is allowed and are not instructions to retry. Descriptions exceeding 100 entries or 32 KiB,
and unavailable history, return an empty array with `truncated: true`. Memory retains 1,000 commits
from the current daemon. The document itself has a separate size cost; refer to large assets by blob ID.

`activity` reports milliseconds since each participant's last activity. `useDoc` batches reports
from pointerdown and keydown events and updates the elapsed time shown by the GUI. `touch()` reports
activity explicitly. This is advisory information: it does not indicate edit completion or guarantee
priority or fairness. Activity does not advance the revision or wake waiters.

## Application structure

Copy `template/` to `<app>/`, keeping the directory name consistent with `app.id`.
The repository's build and typecheck scripts cover all apps. The npm setup example only builds
`template/`; update its configuration when adding apps.

```text
<app>/
  doc.ts      JSON types, initial values, and shared pure functions
  ops.ts      Operation definitions
  app.ts      defineApp({ id, version, rootDir?, initialDoc, ops, webDist, shot? })
  start.ts    runApp(app)
  main.ts     Protect stdout, then start the app
  ui/         index.html / main.tsx / vite.config.ts / tsconfig.json
  rules.ts    Optional domain logic
```

Use `.js` extensions for relative imports loaded by the server. UI-only files use bundler resolution.
Keep server dependencies out of files shared with the UI so they are not pulled into the browser.
Derived values do not need to be stored in doc: for example, share a pure board-to-FEN function
between the UI and a query operation.

## Participants and turns

Set `env: { "DUET_ACTOR": "gpt" }` in the MCP configuration to change the participant name.
Defaults are `llm` for MCP and `human` for the browser. Subagents sharing an MCP connection also
share an actor. Authentication and multi-user account management are not provided.

Store seats and turns in doc, with a shared validation function for the UI and handlers.
Apps with seats should provide operations such as `sit` for additional participants. Rejections
should explain enough to reconsider the request, such as whose seat it is and who is calling.

## Screenshots and blobs

`render_screenshot({ path? })` renders the same GUI in a separate headless Chromium session.
Human drafts, hover state, selection, and scroll positions are not shared. The page is opened on
first use and reused afterward.

```ts
shot: { selector: "#board", viewport: { w: 1024, h: 768 } }
```

`useDoc` updates `data-duet-revision` after the DOM commit. Capture waits for the requested revision
or a later revision from the same daemon; the image is not guaranteed to represent the exact snapshot
at request time. The attribute alone does not guarantee that asynchronous images or app-specific
rendering have finished. Set `DUET_SHOT_ORIGIN` to the development server when needed; otherwise,
capture uses the built GUI served from `webDist`.

`uploadBlob(file)` stores an asset. Put its returned ID in doc through an operation. The GUI uses
`blobUrl(id)` and the LLM uses `read_blob({ id })`. Immutable blobs are read directly by each MCP process.

The built-in tool names `gui_url`, `await_change`, `render_screenshot`, and `read_blob` are reserved.

## Persistence and reconnection

```text
data/<id>.json       Document, app version, and internal commit sequence
data/<id>.log        Auxiliary diagnostic log; not a complete audit or recovery log
data/<id>-blobs/     Immutable assets
```

A snapshot commits when its temporary file is successfully renamed. A subsequent log write failure
does not undo the operation. Logs do not determine conflicts or restore change history after restart.
Full durability against power loss is not guaranteed. Unreadable snapshots are moved aside; app version
mismatches produce a uniquely named backup and a warning. Document schema validation and migrations
remain application responsibilities.

Ports are derived from `app.id` in the range 8000–8999. Override collisions with `DUET_PORT`, using
the same value for the daemon and Vite. Delegation checks the destination app ID and rejects other
apps; version mismatches generate warnings. The process owning the port owns the state, and other
MCP processes delegate through HTTP.

If the owner exits, a surviving MCP process attempts to reconnect or become the owner on its next
call. The GUI alone cannot start a daemon; keep the app process running to continue using the GUI.
**Operation POSTs are never automatically resent.** If a response is lost after persistence, refresh
the document and decide what to do. Exactly-once execution, locking, and human priority are not guaranteed.

## Compatibility and limits

The old API using numeric revisions, standalone `runOp`, or async handlers is incompatible.
Update the daemon, MCP process, and GUI together. Old snapshot integer revisions can be imported
as internal commit sequence numbers.

Whole-document revision checks mean unrelated changes can conflict. The library is not suitable for
character-by-character simultaneous editing or guaranteed LLM progress while humans keep committing
changes. Each operation clones, saves, and sends the full document. Undo/redo, CRDT/OT, and
transactions for external side effects are not provided.

## Development and validation

```bash
npm run typecheck
npm test
npm run test:package
```

Tests use temporary directories rather than modifying saved app documents. Browser tests require
localhost and Chromium. `test:package` installs a real tarball into a temporary project and checks
types, the GUI, stdio MCP, persistence, blobs, screenshots, and restart behavior. It also downloads
dependencies and Chromium and removes the temporary project when finished.

GitHub Actions runs installation, typechecking, builds, the test suite, and the installed-package test
on pushes and pull requests, using Ubuntu / macOS and Node.js 22 / 24. Use `npm ci` to install the
versions recorded in the shared `package-lock.json`.

## License

[MIT License](LICENSE) — Copyright (c) 2026 Taniguchi Ryoga (SabaCan0141).

### Custom HTTP and MCP adapters

`runApp(app, { http, mcp })` optionally accepts adapters. `http(hono, getStore)` registers routes before the standard routes; call `getStore()` inside a request to access the daemon's document store. Registration also runs in client processes, so initialize timers and other owner-only resources lazily when handling a request. Custom routes retain app-ID checks; application authentication and response filtering remain the app's responsibility.

`mcp(call)` connects an application-specific MCP server instead of the standard tools. Its `call(path, init)` uses the same daemon election and recovery as the default MCP adapter, without replaying failed POST requests. Omitting either option keeps its default behavior. `RunOptions` and `DocStore` are exported from `duet-mcp/server`; constructing a store directly does not elect an owner.
