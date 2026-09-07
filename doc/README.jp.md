# duet-mcp

[English](../README.md) | 日本語

**一つの JSON 文書を、人は GUI から、LLM は MCP から編集するアプリの基盤。**

操作を一度定義すると HTTP と MCP の両方から呼べる。文書は一つの daemon が所有し、
観測後の変更を待つ仕組みを提供する。盤面、タスクボード、図、スライド構成など、
小〜中規模の文書に対する離散的な操作を対象にする。

## 操作を一度定義する

```ts
const op = opFactory<Doc>();

op({
  name: "set_text",
  description: "テキストを差し替える。",
  input: { text: z.string() },
  handler: ({ doc, reject }, { text }) => {
    if (text.length > 100) return reject("100文字以内にしてください");
    doc.text = text;
  },
});
```

これが MCP の `set_text({ text, baseRevision })` と HTTP の
`POST /api/op/set_text` になる。GUI は購読した snapshot から `snap.run("set_text", { text })` を呼ぶ。

**操作は、意図を作るために見た文書の版に対して適用する。** その版から文書が変わっていたら、
ハンドラを実行せず `conflict` と最新の doc を返す。変更箇所が別でも競合する。
新しい版で同じ引数を自動再送せず、最新の doc を読んで意図を見直す。

## npm パッケージとして使う

Node.js 22以上、ESMを対象にする。ReactアダプターはReact 18.3、操作の入力定義はZod 3を対象にする。
CIはNode.js 22 / 24とUbuntu / macOS。Windowsでの起動・ビルド手順は未検証。

パッケージ名は `duet-mcp`。以下のレジストリからのインストールは初回公開後に利用できる。
公開前は `npm pack --pack-destination /tmp` で作った `.tgz` の絶対パスを、
`duet-mcp` の代わりに `npm install` へ渡す。

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

LinuxでChromiumのシステムライブラリも必要なら `npx playwright install --with-deps chromium` を使う。
ブラウザの取得はインストール時に自動実行しない。Playwrightを更新した場合も再度取得する。

プロジェクト直下に `tsconfig.json` を作る。

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

GUIの開発中は `npx vite --config template/ui/vite.config.ts` を別ターミナルで実行する。
MCPには `node` と `<project>/dist/template/main.js` の絶対パスを登録する。
アプリを改名する場合は、フォルダ名・`app.id`・`webDist`・ビルド対象と起動パスを揃える。

公開する入口は以下の4つ。`lib/` 内部への直接importは公開APIではない。

```ts
import { defineApp, opFactory, type AppDef, type Op } from "duet-mcp";
import { runApp } from "duet-mcp/server";
import { useDoc, useEdit, EditSession, refreshDoc } from "duet-mcp/react";
import { portFor, baseUrlFor } from "duet-mcp/wire";
```

`rootDir` はアプリのルートを示す絶対パス。文書・blobはその下の `data/` に保存する。
`webDist` は `rootDir` からの相対パス、または絶対パス。
省略時の `rootDir` はプロセスの作業ディレクトリだが、MCPクライアントは任意の作業ディレクトリで
起動しうるため、テンプレートのように `import.meta.url` から明示的に指定する。
パッケージを更新しても同じ `rootDir` と `app.id` を使えば同じ保存データを読む。
既存のコピー方式から移る場合も、以前のプロジェクトルートを指定すると保存先を維持できる。

基盤の更新は `npm install duet-mcp@<version>`。コピーしたテンプレートは利用アプリが管理する。

## リポジトリで動かす

```bash
npm ci
npx playwright install chromium
npm run build
npm start
```

stderr に GUI の URL が出る。`template/` がコピー用の雛形。

テンプレートは Tailwind CSS と React で作った小さなデザインスタジオ。
見出し・メモ、チェックボックス、ラジオボタン、セレクト、不透明度スライダーと、
実際の canvas 上で移動・四隅からリサイズできるボックスを含む。
フォームは「Apply」でまとめて確定し、canvas はドラッグ終了時に確定する。
座標・サイズは数値入力でも変更できる。Esc / pointercancel は進行中のドラッグを中止する。

MCP からは `set_settings`、`set_box`、`set_text` で同じ文書を操作する。
競合時は下書きと現在値を表示して明示的な見直しを求める。
canvas の座標系は720×480、ボックスの最小サイズは64×64で、境界はハンドラでも検証する。
`ui/canvas.tsx` に描画とジェスチャー、`ui/edit-actions.tsx` に確定と競合表示を分けている。
スタイルは `ui/style.css` と各コンポーネントの Tailwind クラスで変更できる。
旧テンプレートのテキストのみの保存データは、追加項目を初期値で表示する。


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

`<repo>` は絶対パス。接続後は `gui_url` で GUI の URL、`await_change` で現在の文書を取得できる。
MCP 設定形式はクライアントに合わせる。

```bash
DUET_APP=myapp npm start
DUET_APP=myapp npm run dev:web
# 開発中の GUI を撮影する場合
DUET_SHOT_ORIGIN=http://127.0.0.1:5173 DUET_APP=myapp npm start
```

## 文書・操作・観測

| 名前 | 契約 |
|---|---|
| doc | アプリが定義する JSON。変更は op から行う |
| op | 名前・説明・Zod 入力・同期ハンドラを一度定義する |
| ctx | `{ doc, actor, reject }`。doc は書き換えてよい複製 |
| revision | 不透明な文字列。受け取った値を解析・加算せず渡す |
| snapshot | `{ doc, revision, actor, activity }` を組で持つ観測 |
| await_change | 今を読む、または観測した版以後のコミットを待つ |

ハンドラが `reject` した場合は複製を捨てる。doc が変わらなければ revision は変わらない。
**古い版の問い合わせ op も conflict** になる。ハンドラを先に動かして読み取りかどうかを判定しない。

ハンドラは短い同期処理に限定する。戻り値は `Json | void`。
Promise は型と実行時の両方で拒否する。外部 API、ファイルへの書き込み、タイマー、
後から draft を変更する処理はハンドラの契約外。doc の複製では外部副作用を取り消せない。
外部で計算した結果を適用する場合も、計算の元にした snapshot の版を使う。

doc と結果は JSON として検証する。`undefined` な項目、NaN、Map、Date、循環参照などはエラー。
項目の削除は `delete`、空の値は `null` を使う。戻り値の `undefined` は結果なしとして扱う。
`doc = next` はローカル変数の再代入で文書を置き換えない。複製のプロパティを更新すること。

入力違反・アプリの `reject` は説明付きで返す。基盤やハンドラの予期しない例外・保存失敗は
通信経路のエラーとして伝わる。HTTP 入力の検証に加え、MCP 側でも SDK が入力を検証する。

## GUI の操作と下書き

```tsx
const snap = useDoc<Doc>(); // 初回取得前は null
if (!snap) return <p>接続中…</p>;

// run はこの snapshot の revision を使う。
const result = await snap.run("move_card", { cardId, beforeCardId });
```

複数の `useDoc` は一つの購読を共有する。応答の doc と revision は一緒に反映され、
遅れて届いた古い応答で巻き戻らない。保存しておいた古い `snap.run` は古い版を送り続ける。

入力やドラッグなど、観測から確定まで時間がある編集には `useEdit` を使う。

```tsx
const snap = useDoc<Doc>();
const edit = useEdit<string>();

// 最初に入力を変えるとき
edit.begin(snap, snap.doc.text);
edit.setValue(nextText);

// 確定時。begin したときの版で送る。
const result = await edit.run("set_text", { text: edit.value });
```

- `active` / `value` / `pending` / `result` / `error` が現在の編集状態。
- 既に編集中の `begin` は拒否する。購読更新は下書きと基準版を変更しない。
- 送信中の重複 `run` は同じ Promise を返す。入力は `pending` の間無効にする。
- 成功時に編集を終了する。conflict、rejected、通信失敗では下書きを残す。
- `cancel()` は下書きを破棄する。
- `restart(latestSnapshot, revisedValue)` は見直した内容と基準を明示的に更新する。
- `refreshDoc()` は再取得を要求し、購読で現在の状態を確認したら解決する Promise を返す。

テンプレートは現在値と下書きを並べ、取り消しと見直し後の適用を示している。
通信失敗時には結果が不明なことがあるため、現在値を再取得してから再適用を判断する。
下書きをリストの行の中だけに置くと、相手の操作による行の移動や削除で失われる。

[移動可能なリストの例](../template/ui/card-editing.tsx) は、カード id をキーに `EditSession` を
列の外の Map に保持する。各行は `useSyncExternalStore` でその編集を購読するので、
別の列に移動して行が再マウントされても下書きが残る。これはカード用アプリへ組み込む例で、
テキストのテンプレートには表示していない。`EditSession` は `useEdit` と同じ状態管理の実体。

## 応答と待機

正常な op 応答は三種類。どれにも doc と revision を同梱する。

```jsonc
{ "revision": "epoch-a:12", "actor": "llm", "doc": { "text": "hello" },
  "activity": {}, "ok": true }
{ "revision": "epoch-a:12", "actor": "llm", "doc": { "text": "hello" },
  "activity": {}, "rejected": "100文字以内にしてください" }
{ "revision": "epoch-a:14", "actor": "llm", "doc": { "text": "new" },
  "activity": {}, "conflict": true, "changes": [], "truncated": true }
```

revision の文字列は例示。形式は公開契約ではない。daemon が再起動すると、文書が同じでも
revision は変わる。古い操作は conflict、古い待機は最新 doc と `truncated: true` を即返す。

- `await_change()` は現在の doc と revision を即時取得する。
- `await_change({ sinceRevision })` はその版以後のコミットを待つ。既にあれば即返す。
- `until: ["move_card"]` は待つ op 名を絞る。変更説明もその対象のみで、doc は全体の現状。
- `timeoutMs` は既定25秒、下限1秒、上限120秒。
- 時間切れでも対象外の変更はありうる。返された doc と revision を組で採用する。

`changes` は op・actor・count・touched（JSON Pointer）の説明。連続する同じ参加者の同じ op を
まとめる。書き込み可否や自動再送の根拠には使わない。100件または32 KiBを超える説明、
保持範囲外の履歴は空配列と `truncated: true` で返す。メモリには現在の daemon の1000コミットを保持する。
文書全体のサイズはこの説明サイズ制限とは別なので、かさばる画像などは blob の id で参照する。

`activity` は参加者の最終活動からの経過ミリ秒。`useDoc` は pointerdown / keydown をまとめて申告し、
GUI の経過時間表示も更新する。`touch()` で明示的な申告もできる。
これは助言情報で、編集完了・優先権・公平性は保証しない。revision を変えず、待機も起こさない。

## アプリの構造

`template/` を `<app>/` にコピーする。ディレクトリ名は `app.id` と一致させる。
リポジトリの `build` と `typecheck` は全アプリを対象にする。
npm導入例のビルド対象は `template/` のみなので、追加アプリに合わせて設定する。

```text
<app>/
  doc.ts      JSON 型・初期値・共有する純粋関数
  ops.ts      op 定義
  app.ts      defineApp({ id, version, rootDir?, initialDoc, ops, webDist, shot? })
  start.ts    runApp(app)
  main.ts     stdout を保護して起動
  ui/         index.html / main.tsx / vite.config.ts / tsconfig.json
  rules.ts    必要な場合のドメインロジック
```

サーバ側から読む相対 import は `.js` を付ける。UI のみのファイルは bundler 解決。
UI と共有するファイルに重いサーバ依存を入れると UI にも取り込まれるため、依存の置き場を分ける。
派生値は doc に重複保存する必要はない。例えば盤面からFENを作る純粋関数を UI と問い合わせ op で共有できる。

## 参加者と手番

MCP 設定の `env: { "DUET_ACTOR": "gpt" }` で参加者名を変えられる。既定は `llm`、ブラウザは `human`。
同じ MCP 接続を使うサブエージェントは同じ actor になる。認証や複数ユーザー管理は提供しない。

席や手番は doc に置き、共通の判定関数を UI とハンドラから使う。
席のあるアプリは、追加の actor が座れる `sit` などの op も用意する。
`reject` では「誰の席か、自分は誰か」など、呼び手が見直せる理由を返す。

## GUI の撮影と blob

`render_screenshot({ path? })` は、同じ GUI を headless Chromium の別セッションで描画して撮る。
人間の下書き、ホバー、選択、スクロール位置は共有しない。初回だけページを開き、その後は再利用する。

```ts
shot: { selector: "#board", viewport: { w: 1024, h: 768 } }
```

`useDoc` は DOM の反映後に `data-duet-revision` を更新する。撮影側は同じ daemon の要求時点以降の版を待つ。
厳密に要求時の snapshot を固定した画像とは限らない。非同期画像やアプリ固有の描画完了まで
この属性だけで保証するものではない。
開発中は `DUET_SHOT_ORIGIN` を dev server に向ける。既定の撮影対象は `webDist` のビルド成果物。

`uploadBlob(file)` で実体を保存し、返された id を op で doc に入れる。GUI は `blobUrl(id)`、
LLM は `read_blob({ id })` で参照する。不変な blob は各 MCP プロセスから直読みする。

組み込みツール名 `gui_url` / `await_change` / `render_screenshot` / `read_blob` は op に使えない。

## 保存と再接続

```text
data/<id>.json       文書・アプリ版・内部のコミット連番
data/<id>.log        調査用の補助ログ（完全な監査・復元ログではない）
data/<id>-blobs/     不変の実体
```

snapshot の一時ファイルを rename できた時点で確定する。ログ追記の失敗で確定済みの操作を取り消さない。
ログは競合判定に使わず、再起動後の差分復元にも使わない。電源断に対する完全な耐久性は保証しない。
読めない snapshot は退避する。アプリ版が違う場合は固有名の控えを作って警告する。
アプリ固有の doc スキーマ検証・マイグレーションはアプリ側の責任。

ポートは app.id から8000〜8999へ導出する。衝突した場合は `DUET_PORT` で変更する
（daemon と vite に同じ値を設定）。委譲先の app.id を確認し、別アプリには操作を渡さない。
version 不一致は警告。ポートを所有するプロセスが唯一の状態を持ち、他の MCP プロセスは HTTP で委譲する。

所有者が落ちたら、生き残った MCP プロセスが次の呼び出し時に再接続・昇格を試す。
GUI だけでは daemon を起動できない。GUI を使い続けるならアプリのプロセスを残す。
**操作の POST は自動で再送しない。** 保存後に応答が途切れた場合は成功か不明なので、
現在の doc を取得して判断する。exactly-once、ロック、人間優先は保証しない。

## 更新と検証

数値 revision、独立した `runOp`、async handler を使う旧 API とは互換性がない。
daemon・MCP・GUI を同時に更新する。旧 snapshot の整数 revision は内部連番として読み込める。

```bash
npm run typecheck
npm test             # ビルドと全テスト。localhost と Chromium を使用
```

テストは一時ディレクトリを使い、アプリの保存済み文書を変更しない。

文書全体の版を照合するため、無関係な変更でも競合する。人が更新し続ける間の LLM の進行や、
文字単位の同時編集には向かない。doc は毎回全量で複製・保存・送信する。
undo / redo、CRDT / OT、外部副作用のトランザクションは提供しない。

## CI とライセンス

GitHub Actions は push / pull request 時に、Ubuntu・macOS と Node.js 22・24 の組み合わせで
`npm ci`、Chromium の導入、型チェック、ビルドと全テストを実行する。
`package-lock.json` を共有し、CI と同じ依存バージョンを入れる場合は `npm ci` を使う。

[MIT License](../LICENSE) — Copyright (c) 2026 Taniguchi Ryoga (SabaCan0141)。


配布物の独立インストール検証は `npm run test:package` で実行する。
一時プロジェクトで型定義・GUI・MCP・保存・blob・撮影・再起動を確認し、終了後に削除する。
この検証は依存パッケージとChromiumをダウンロードする。CIでも実行する。
