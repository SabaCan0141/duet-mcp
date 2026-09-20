# duet-mcp semantics

[Quickstart](../README.md) | [日本語](SEMANTICS.jp.md)

## Action types

Create `action` once with `createAction<Doc>()` to type the handler’s document. Inputs come from Zod; results come from the handler. Use the same `Doc` for `initialDoc`; incompatible action document types are rejected. Custom actions and built-in actions share one `actions` object. Definitions can be split into ordinary objects; use `mergeActions(...)` to reject duplicate keys when combining them.

State keys and operation names cannot overlap. `then` is reserved because a returned document must not be mistaken for a Promise. Initial state and every committed update are checked. Inputs and results must be JSON-compatible; top-level `undefined` means no input/result. Other non-JSON values are errors, not silently dropped fields.

## GUI and backend

`duet generate`, `duet build`, and `duet dev` create thin modules beside the app. They import the app **only as a type**; server handlers and dependencies stay out of the browser bundle.

```tsx
import { useDoc } from "./duet/browser";

function Editor() {
  const doc = useDoc();
  if (!doc) return <p>Loading...</p>;
  return <button onClick={() => doc.set_text({ text: "hello" })}>{doc.text}</button>;
}
```

```ts
import { getDoc, getObserverID } from "./duet/node";

const doc = await getDoc();
console.log(doc.text);
await doc.set_text({ text: "hello" });
const oid = await getObserverID(); // a new, initially unobserved ID
```

`useDoc()` subscribes to the entire state. It returns `null` until the first snapshot and keeps the last snapshot while reconnecting. `getDoc()` fetches once; fetch again for newer state. Both return readonly state fields and typed operation methods on the same object. Operations return their own result, not a state envelope. React may receive the corresponding subscription update after an operation resolves.

An old snapshot's methods still call the current daemon. They do not automatically check the revision of that snapshot. Neither reads nor successful operations implicitly advance an observer.

`useEdit<Value>()` and `EditSession<Value>` from `duet-mcp/react` keep local drafts:

```ts
edit.begin("draft");
edit.setValue("revised draft");
await edit.submit(text => doc.set_text({ text }));
```

`submit(value => ...)` passes the session’s current draft, including a synchronous `setValue()` immediately before submission. Submitting without an active edit, or while another submission is pending, throws. `begin` and `setValue` activate an edit; cancel and successful submission end it. A thrown error leaves the draft available. Business-level rejection returned as a value is up to your callback to interpret. Editing helpers do not manage observer IDs.

## State, async work, and persistence

Handlers and `setup` receive `doc.get()` and `doc.update(...)`.

- `get()` returns a detached readonly snapshot.
- `update()` runs a short synchronous callback on a draft, validates it, and commits a detached copy.
- Every successful update advances revision and wakes waiters, even if the value is unchanged.
- A thrown callback, invalid JSON, nested update, or Promise-returning callback does not commit that update.
- Each update commits independently. A later operation error or invalid return value does not undo earlier updates or external effects.

Async handlers can await databases or external work between synchronous updates. Other operations continue while they wait. Do not keep an update draft across an `await`.

`initialDoc` may be async. It runs for the first owner, not for followers or during takeover. Put timers, process-local connections, and subscriptions in optional `setup({ doc, observers, signal })`, which runs for each owner. It may asynchronously return a cleanup function. The daemon accepts operations after setup completes. Ownership loss aborts the signal and revokes the old context's updates; forced termination cannot guarantee cleanup.

**duet does not save or load the doc automatically.** Load application data in `initialDoc`, and implement save operations against your chosen storage. A JSON-file app can write a temporary file and rename it after success. Serialize overlapping saves if their order matters. Reopening after all Node runtimes exit runs initialization again.

Keep UI-only drafts local. Shared state is a JSON object, not a database schema or a file format managed by duet.

## Explicit observations

Within a handler or setup, `observers` provides:

| Function | Meaning |
|---|---|
| `getObserverID()` | Create a new unobserved ID, synchronously inside the daemon |
| `dispose(oid)` | Delete the ID and fail its pending waits |
| `observe(oid)` | Record the current revision for this ID |
| `isCurrent(oid)` | True when its observed revision matches the current revision |
| `waitChange(oid, timeoutMs = 10_000, { signal } = {})` | True after an update or if already unobserved/stale; false on timeout |

IDs have no expiry. Unknown or disposed IDs throw `ObserverNotFound`. Cancellation throws `AbortError`; daemon loss throws `DaemonChanged` when identified. Millisecond timeouts must be integers from 0 through 2,147,483,647. Zero is an immediate check.

Reads, results, checks, and waits do not advance observations. ID changes do not change the doc revision. The application decides the lifetime of each ID and passes it only to operations that need it. Client-side creation/deletion is asynchronous: `await getObserverID()` / `await disposeObserver(oid)`.

For a read operation, compute the returned information and call `observe(oid)` in the same synchronous part of the handler. For a guarded update:

```ts
set_text_if_current: action({
  description: "Replace text and observe the resulting state. If changed is false, read the latest state with await_change and reconsider your edit before retrying.",
  input: z.object({ oid: z.string(), text: z.string() }),
  handler: ({ doc, observers }, { oid, text }) => {
    if (!observers.isCurrent(oid)) return { changed: false };
    doc.update(state => { state.text = text; });
    observers.observe(oid);
    return { changed: true };
  },
})
```

This example treats the resulting state as observed by the caller, allowing consecutive edits with the same ID unless another update intervenes. The application explicitly chooses four things: add `oid` to the input; check and update without an intervening `await`; observe after the update; describe the stale result and recovery steps for the LLM. This boilerplate remains to keep the condition and observation policy visible in the handler. It is not a mandatory policy for every action.

An `await` between the check and update permits intervening changes; check again if needed. An `observe` after asynchronous work records the revision at that later moment. Sharing an ID means sharing one observation record, not retaining a separate basis per request. Once a wait is registered, another call observing the same ID does not hide an intervening update from that wait.

## Optional assets and MCP

No tools are registered by default. Add built-in actions under the keys you want in `actions`, alongside your custom actions:

| Factory from `duet-mcp/assets` | Operation behavior |
|---|---|
| `guiUrl()` | Return `{ url }` using the selected port |
| `awaitChange()` | Input `{ oid, timeoutMs? }`; wait, read the **entire doc**, advance observation, return doc; also reads/observes on timeout |
| `waitChange()` | Same input; return only the boolean wait result without observing |
| `observerOps()` | Add `get_observer_id` and `dispose_observer({ oid })` |
| `renderScreenshot({ selector?, viewport? })` | Input `{ path? }`; capture the shared GUI in a separate Chromium session |
| `blobOps({ directory, id? })` | Add `put_blob({ data, mime })` and `read_blob({ id })`; `data` is base64 |

Only explicit assets incur their work. Chromium is loaded for screenshots; install it with `npx playwright install chromium`. On Linux, `--with-deps` also installs required system libraries. Screenshots wait for the owner's rendered sequence; they do not capture a person's local draft, scroll position, or all app-specific asynchronous rendering. `DUET_SHOT_ORIGIN` can point to the Vite origin while developing.

MCP object inputs expose their properties directly. Scalars, arrays, and unions use `{ value: input }`; for example, an action defined with `input: z.string()` takes `{ value: "hello" }` over MCP. The quickstart uses an object input, so both callers pass `{ text: "hello" }`. No-input operations take `{}`. The daemon performs the same Zod parsing for all callers, including transforms. Unsupported input-schema forms fail at startup with the operation name.

Application results are JSON text; media assets can return MCP images. Exceptions become tool errors. No `baseRevision`, doc snapshot, change paths, or activity records are automatically attached.

`useDoc()` and `getDoc()` expose the whole state. A custom partial-information operation does **not** hide data from a party that can access the full-state endpoints. Authentication and endpoint access control belong to the application. Observer IDs are not credentials. Even a hidden-field update can wake a waiter.

## Startup and takeover

`runApp(app)` from `duet-mcp/server` starts the runtime and MCP over stdio. Keep the entry module's stdout clear for MCP. The template redirects console output before dynamically importing the app.

Each Node runtime tries the same loopback port. The owner holds the state; others delegate and continuously receive coherent checkpoints containing state, revision, and observation records. Another app, protocol, or app version at that port is an error. No automatic alternate port is chosen. Specify `app.port` when necessary. `DUET_PORT` is a deprecated fallback when `app.port` is absent.

If the owner exits, a surviving runtime takes over without waiting for a new MCP call. Browsers and one-shot Node clients are not takeover candidates. Replication is asynchronous: a successful recent update or observer change can be lost. A follower without its first complete checkpoint fails rather than inventing a replacement state.

In-flight operations and waits fail across takeover and are **never automatically replayed**. A transport error can mean external effects already happened. An unknown result is reported as `OutcomeUnknown`; an identified owner change as `DaemonChanged`. GUI subscriptions reconnect and adopt the new owner's snapshot. Revision tokens are internal equality markers; owner identity is tracked separately.

For an embedded runtime without stdio, use `await startRuntime(app)` and eventually `await runtime.stop()`.

## Build and run

Requires Node.js 22+, ESM, Zod 3.25+, and React 18.3. Verified on Linux and macOS; Windows has not been verified.
`duet init [directory]` creates package.json (dependencies and scripts), tsconfig.json, duet.config.ts, .gitignore, and template in an empty directory. Omitting the directory uses the current directory. It does not overwrite files, install dependencies, or start a server.

After `npm install`, use `npm run dev` for generation, typechecking, the runtime, and Vite; `npm run build` for compilation; `npm start` for the compiled app; and `npm run typecheck` for generation and typechecking.

```ts
// duet.config.ts
export default {
  app: "./template/app.ts",
  viteConfig: "template/ui/vite.config.ts",
  // clientDir: "template/duet", tsconfig: "tsconfig.json"
};
```

Register `node` with the absolute path to `dist/template/main.js` in your MCP client. Runtime startup comes from `duet-mcp/server`; generated Node clients come from `./duet/node`. GUI state comes from `./duet/browser`, while `useEdit` comes from `duet-mcp/react`.

Public entry points: `duet-mcp`, `duet-mcp/server`, `duet-mcp/react`, `duet-mcp/assets`, `duet-mcp/wire`, and `duet-mcp/generate`. Direct `lib/` imports are internal.

`webDist` is absolute or relative to `rootDir` (cwd if omitted). The template resolves its root from its compiled location. Custom builds should run `duet generate` before compilation. Generated `duet/` and intermediate `.duet/` files need not be edited or committed. Generation reads definition modules but does not call initialDoc or setup; do not start external connections at module scope.

## Where to start in the template

Read **`template/app.ts` for state and operations**, then **`template/ui/main.tsx` for the screen**. Add an operation directly to `app.ts`; no separate operation or document module is needed.

```text
template/
  app.ts              State, initial values, operations, and optional assets
  main.ts             Startup (keeps stdout clear for MCP)
  ui/
    main.tsx          Screen and typed operation calls
    canvas.tsx        Canvas drawing and gestures
    edit-actions.tsx  Save/cancel controls shared by the editors
    style.css         Appearance
    ...               HTML and build configuration
  duet/               Generated client and connection modules; do not edit
  .duet/              Generated intermediate bundle; do not edit
```

The GUI uses type-only imports from `app.ts` and reads initial values from the shared state. It never imports or executes the app definition in the browser. Split out operations later only when the app grows enough to benefit from it.
