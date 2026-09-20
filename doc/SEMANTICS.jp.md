# duet-mcp：保証と境界

[導入ガイド](README.jp.md) | [English](SEMANTICS.md)

## 操作の型

`createAction<Doc>()` を一度書くと、handler の文書型が決まります。入力型は Zod、結果型は handler から推論します。`initialDoc` にも同じ `Doc` を使い、操作と互換性のない文書型は型エラーになります。自作操作と付属操作は一つの `actions` に並べます。分割が必要になったら普通のオブジェクトに分け、同名を検査して結合したい場合は `mergeActions(...)` を使えます。

状態キーと op・asset 名の衝突はエラーです。`then` は Promise との混同を防ぐため予約名です。初期値と更新確定前に検査します。状態・入力・結果は JSON で表せる値とし、トップレベルの `undefined` は入力・結果なし、それ以外の非 JSON 値は例外になります。

## GUI とバックエンド

`duet generate` / `duet build` / `duet dev` が専用モジュールを自動生成します。app は型としてだけ参照するので、ブラウザに handler やサーバー依存を持ち込みません。

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
const oid = await getObserverID();
```

`useDoc()` は全文を購読し、初回取得までは `null`、切断中は最後の状態を保持して再接続します。`getDoc()` は一回取得するだけです。どちらも readonly な状態と型付き op を同じオブジェクトに持ちます。最新状態が必要なら再取得してください。

op の戻り値はアプリの結果で、doc を自動同梱しません。op 完了時に React の再描画まで済んでいる保証はありません。古い取得結果のメソッドも通常の op を呼び、その取得時の revision に検査基準を固定しません。取得や成功によって観測を自動更新することもありません。

`duet-mcp/react` の `useEdit<Value>()` / `EditSession<Value>` はローカル下書きを扱います。`begin(value)`、`setValue(value)`、`cancel()` と `submit(text => doc.set_text({ text }))` を使います。submit はセッションの現在の下書きを callback に渡すため、setValue 直後でも最新値を使います。非編集中・送信中の submit は例外です。begin と setValue は編集を開始し、cancel と送信成功で終了します。例外時は下書きを保持します。業務上の不成功を値で返す場合は callback 内で判定してください。観測 ID の管理は行いません。

## 状態・非同期処理・永続化

handler と `setup` は同じ `doc.get()` / `doc.update(...)` を使います。

- `get()` は正本から切り離した snapshot を返します。
- `update()` は同期 callback で draft を変更し、検証後のコピーを確定します。
- 同じ値の代入や空の callback でも、成功した更新は revision を進めて待機を解除します。
- callback の例外、非 JSON 値、ネストした update、Promise を返す callback はその更新を確定しません。
- 各更新は独立して確定します。後の例外・結果の検証失敗で、先の更新や外部処理は戻りません。

op 自体は async にできます。DB や外部処理を await している間も他の op が進みます。更新用 draft を await 越しに保持しないでください。

`initialDoc` は非同期にもでき、最初の所有者でだけ実行します。引き継ぎ時は実行しません。任意の `setup({ doc, observers, signal })` は所有者になるたびに実行し、タイマー・接続・購読を準備します。非同期で cleanup 関数を返せます。setup 完了後に操作受付を開始します。所有権喪失で signal を abort し、旧 context の更新を拒否します。強制終了では cleanup の実行を保証しません。

**doc の自動保存・自動復元はありません。** 必要なデータを `initialDoc` で読み込み、保存 op をアプリで実装します。JSON ファイルなら一時ファイルへ書き、成功後に rename する方法が使えます。同時保存の順序もアプリが管理します。全 Node runtime 終了後は初期化から始まります。UI だけで使う下書きはローカルに置けます。

## 明示的な観測

handler 内の `observers` は次の関数を提供します。

| 関数 | 意味 |
|---|---|
| `getObserverID()` | 新しい未観測 ID を発行。daemon 内では同期 |
| `dispose(oid)` | ID を破棄し、その ID の待機を例外で終了 |
| `observe(oid)` | 呼んだ時点の最新 revision を記録 |
| `isCurrent(oid)` | 観測した revision と最新が一致すれば true |
| `waitChange(oid, timeoutMs = 10_000, { signal } = {})` | 更新あり・未観測・不一致なら true、時間切れなら false |

ID に期限はありません。未知・破棄済みは `ObserverNotFound`、中断は `AbortError`、確認できた daemon 交代は `DaemonChanged` です。待機時間は 0〜2,147,483,647 の整数ミリ秒。0 は即時検査です。

読み取り・返却・検査・待機だけでは観測を進めません。ID 操作は doc revision を進めません。発行・共有・破棄のタイミングと、必要な op への引数渡しはアプリが決めます。外部 client からの発行・破棄は `await getObserverID()` / `await disposeObserver(oid)` です。

読み取り op は返す情報を作り、同じ同期処理内で `observe(oid)` を呼びます。検査付き更新は次のように書けます。

```ts
set_text_if_current: action({
  description: "更新後の状態を観測済みにする。changed:false なら await_change で最新状態を読み、更新内容を再検討してから呼び直す。",
  input: z.object({ oid: z.string(), text: z.string() }),
  handler: ({ doc, observers }, { oid, text }) => {
    if (!observers.isCurrent(oid)) return { changed: false };
    doc.update(state => { state.text = text; });
    observers.observe(oid);
    return { changed: true };
  },
})
```

この例は、自分の更新後の状態を観測済みと扱い、他の更新がなければ同じ ID で続けて更新できる方針です。毎回アプリが決めるのは、① oid を入力へ追加する、② await を挟まず isCurrent と更新を行う、③ 更新後に observe する、④ stale 時の戻り値と復帰手順を description で伝える、の4点です。この記述量は、条件と観測の意味を handler 内に明示するために残しています。すべての操作へこの方針を強制するものではありません。

検査と更新の間に await を挟めば、別の更新が入ることがあります。必要なら再検査します。読み取り後に await してから observe すると、より新しい revision を観測済みにする場合があります。同じ ID を共有すると観測記録も共有されます。ただし登録済みの待機は、その後に別の処理が同じ ID を観測更新しても、間に起きた更新を見落としません。

## 任意のアセットと MCP

デフォルト登録のツールはありません。`duet-mcp/assets` の factory を、自作操作と同じ `actions` に明示的に追加します。

| factory | 動作 |
|---|---|
| `guiUrl()` | 実際のポートの `{ url }` を返す |
| `awaitChange()` | `{ oid, timeoutMs? }` を受け、待機・**全文取得**・観測更新を行って doc を返す。初回は即時、時間切れでも取得・観測更新する |
| `waitChange()` | 同じ入力で boolean だけ返す。取得・観測更新しない |
| `observerOps()` | `get_observer_id` と `dispose_observer({ oid })` を追加 |
| `renderScreenshot({ selector?, viewport? })` | `{ path? }` を受け、別 Chromium セッションで共有 GUI を撮影 |
| `blobOps({ directory, id? })` | `put_blob({ data, mime })` / `read_blob({ id })`。data は base64 |

撮影する場合は `npx playwright install chromium`、Linux でシステム依存も必要なら `--with-deps` を使います。Chromium は撮影時に読み込みます。描画した owner・更新連番を待ちますが、人の下書き・スクロール位置やアプリ固有の非同期描画完了は保証しません。開発中は `DUET_SHOT_ORIGIN` に Vite の origin を指定できます。

MCP はオブジェクト入力をそのまま、スカラー・配列・union を `{ value: input }` に変換します。導入例はオブジェクト入力なので GUI / Node / MCP とも `{ text: "hello" }` です。無入力は `{}`。daemon が各経路共通で Zod 検証と transform を行います。対応できないスキーマは起動時に op 名付きでエラーになります。

通常の結果は JSON text、画像アセットは MCP image、例外はツールエラーです。`baseRevision`、doc、変更パス、activity を自動付加しません。

`useDoc()` / `getDoc()` と全文 endpoint は全状態を公開します。部分情報を返す op だけ作っても、全文 endpoint に接続できる相手への秘匿は成立しません。認証・アクセス制限はアプリが担当します。観測 ID は認証情報ではありません。非公開部分の更新でも待機が解除されることがあります。

## 起動・引き継ぎ

`duet-mcp/server` の `runApp(app)` は runtime と stdio MCP を起動します。stdout は MCP 用に空けます。テンプレートは app の動的 import 前に console 出力を stderr へ向けています。

Node runtime は同じ loopback ポートに集まり、一つだけが正本を持ちます。他の runtime は常時、doc・revision・観測記録を一組で複製します。別 app・protocol・app version がそのポートを使っていれば起動エラーになり、別ポートへは自動退避しません。任意ポートは `app.port`。`DUET_PORT` は app.port 未指定時だけ使う非推奨の移行用設定です。

daemon 終了時は次の MCP 呼び出しを待たず、生存 runtime が昇格します。ブラウザや一回取得の Node client は候補になりません。複製は非同期なので、成功直後の更新や ID 操作が失われる可能性があります。最初の完全コピーを受信する前に所有者が消えた場合、初期値で代用せず失敗します。

進行中の op・待機は交代時に失敗し、**自動再実行しません**。例外でも外部処理が実行済みの場合があります。結果不明は `OutcomeUnknown`、交代を確認できた場合は `DaemonChanged`。GUI 購読だけは再接続して新しい正本へ追随します。revision と所有者 ID は内部で別々に管理します。

stdio が不要なら `await startRuntime(app)` を使い、終了時に `await runtime.stop()` を呼べます。

## 導入と開発

Node.js 22+、ESM、Zod 3.25+、React 18.3 を対象にしています。Linux と macOS で検証しています。Windows は未検証です。
`duet init [directory]` は空のディレクトリに package.json（依存関係と scripts）、tsconfig.json、duet.config.ts、.gitignore、template を作ります。引数省略時は現在のディレクトリです。既存ファイルを上書きせず、インストールやサーバー起動は行いません。

`npm install` の後、`npm run dev` で生成・型検査・runtime と Vite を起動します。`npm run build` で配布用にビルドし、`npm start` で起動します。`npm run typecheck` は生成と型検査を行います。

```ts
// duet.config.ts
export default {
  app: "./template/app.ts",
  viteConfig: "template/ui/vite.config.ts",
  // clientDir: "template/duet", tsconfig: "tsconfig.json"
};
```

MCP client には `node` と `dist/template/main.js` の絶対パスを登録します。`runApp` は `duet-mcp/server`、生成された Node client の `getDoc` は `./duet/node` から読み込みます。GUI は `./duet/browser` の `useDoc` と `duet-mcp/react` の `useEdit` を使います。

公開入口は `duet-mcp`、`duet-mcp/server`、`duet-mcp/react`、`duet-mcp/assets`、`duet-mcp/wire`、`duet-mcp/generate`。`lib/` の直接 import は内部 API です。

`webDist` は絶対パスか `rootDir` からの相対パスです。rootDir 省略時は cwd。テンプレートはコンパイル後の配置から rootDir を決めます。独自ビルドではコンパイル前に `duet generate` を実行してください。生成された `duet/` と中間生成物 `.duet/` は編集不要です。生成処理は定義モジュールを読みますが、initialDoc / setup は呼びません。モジュール直下で外部接続などを開始しないでください。

## テンプレートの読み始め方

最初に読むのは、**状態と操作の `template/app.ts`**、**画面の `template/ui/main.tsx`** の2つです。操作は app.ts に直接追加でき、別の操作 factory や文書定義ファイルへの配線は不要です。

```text
template/
  app.ts              状態型・初期値・操作・任意アセット
  main.ts             起動処理（stdout を MCP 用に空ける）
  ui/
    main.tsx          画面と型付き操作の呼び出し
    canvas.tsx        キャンバス描画とジェスチャー
    edit-actions.tsx  各編集欄で共有する保存・取消ボタン
    style.css         見た目
    ...               HTML とビルド設定
  duet/               自動生成の client・接続設定。編集不要
  .duet/              自動生成の中間 bundle。編集不要
```

GUI は app.ts を型としてだけ参照し、初期値は共有状態から取得します。ブラウザでアプリ定義を読み込んだり実行したりしません。操作の分割はアプリが大きくなってからで十分です。

