# AI Knowledge MCP（Cloudflare Workers 版）

Make の「Safe Update Shared Knowledge」（シナリオ 8027652）と MCP ツールボックス「AI Knowledge」（9653）を置き換える、無料で動かせるリモート MCP サーバーです。

## Make 版との対応

| Make v2 の機能 | このサーバー |
|---|---|
| 入力 6 項目（file_id / expected_modified_time / request_id / mode / content / old_text） | 同じ |
| 出力 6 項目（status / file_id / match / length / backup_file_id / modified_time） | 同じ（失敗時の説明として `message` が付くことがあります） |
| 対象の検査（AI-Knowledge 直下・text/markdown・末尾 .md・ゴミ箱以外） | 同じ |
| 版の照合（最初と書込み直前の 2 回） | 同じ |
| 再送の防止（appProperties にハッシュを記録 → already_applied） | 同じ方式（記録はこのサーバー専用で、Make の記録とは共有しません） |
| full / append / replace_exact | 同じ（完全一致の文字列置換で、正規表現は使いません） |
| 更新前のコピー → 本文更新 → 保存後の全文照合 | 同じ |
| バックアップの 20 世代管理（21 世代目以降をゴミ箱へ、次ページがあれば整理しない） | 同じ |
| — | **追加**：`read_shared_knowledge`（エスケープなしの生の本文と modified_time を返す）、`list_shared_knowledge`（ファイル一覧） |

Cloudflare Workers・KV・SQLite版Durable Objectsの無料枠とGoogle Drive APIを使います。無料枠を超えた場合の停止はあり、無制限ではありません。

接続できるのは `ALLOWED_EMAIL` に設定した Google アカウントでログインした場合だけです。

## 初回セットアップ（Windows PC で約 30〜60 分）

### 0. 準備
- [Node.js](https://nodejs.org/)（LTS 版）をインストールする
- このリポジトリを取得し、PowerShell で `knowledge-mcp` フォルダーに移動して `npm install` を実行する

### 1. Cloudflare（無料アカウント）
```powershell
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```
表示された `id` で、`wrangler.jsonc` の `REPLACE_WITH_KV_NAMESPACE_ID` を置き換えます。続けて、一度デプロイして URL を確定させます。
```powershell
npx wrangler deploy
```
表示された `https://ai-knowledge-mcp.<あなたのサブドメイン>.workers.dev` を控えておきます（以下では `<WORKER_URL>` と書きます）。

### 2. Google Cloud（無料）
1. https://console.cloud.google.com/ で新しいプロジェクトを作成する
2. 「API とサービス」→「ライブラリ」で **Google Drive API** を有効にする
3. 「OAuth 同意画面」（Google Auth Platform）を開き、ユーザーの種類を「外部」にして作成する
   - データアクセス（スコープ）に `openid`、`.../auth/userinfo.email`、`.../auth/drive` を追加する
   - **対象（Audience）で「アプリを公開」を押し、「本番環境」にする**。テストのままだと 7 日ごとにリフレッシュトークンが切れて、保存が止まります。自分だけが使うなら Google の審査は不要です（ログイン時に表示される「確認されていないアプリ」の警告を承認します）
4. 「クライアント」→「クライアントを作成」で、種類「ウェブ アプリケーション」を選ぶ
   - 承認済みのリダイレクト URI：`<WORKER_URL>/callback`
   - 表示されたクライアント ID とクライアント シークレットを控える

### 3. 秘密情報の登録
各コマンドを実行すると値の入力を求められます。
```powershell
npx wrangler secret put GOOGLE_CLIENT_ID       # 手順 2 のクライアント ID
npx wrangler secret put GOOGLE_CLIENT_SECRET   # 手順 2 のクライアント シークレット
npx wrangler secret put ALLOWED_EMAIL          # 接続を許可する Google アカウントのメールアドレス
npx wrangler secret put KNOWLEDGE_FOLDER_ID    # AI-Knowledge フォルダーの ID
npx wrangler secret put BACKUP_FOLDER_ID       # Backups フォルダーの ID
```
フォルダー ID は system-maintenance.md の「管理場所」にあるフォルダー URL の末尾です。

### 4. AI に接続する
MCP の URL は `<WORKER_URL>/mcp` です。
- **Claude**：設定 →「コネクタ」→「カスタムコネクタを追加」→ URL を入力 →「接続」→ 許可 → Google でログイン
- **ChatGPT**：設定 →「アプリ」→ 開発者モードで、MCP サーバーとして URL を追加し、OAuth で接続
- **Codex**：`codex mcp add ai-knowledge --url <WORKER_URL>/mcp` を実行し、`codex mcp login ai-knowledge` でログイン

### 5. 検証（本番の知識は使わない）
専用の `knowledge-update-test.md`（1K8hczqgNHE9KtrsNK2amtKJtOmOjOLDM）だけを使います。
1. `read_shared_knowledge` → `append`：status=saved、match=true になり、Backups にコピーができること
2. 同じ全入力で再送：already_applied が返り、本文とバックアップが増えないこと
3. 古い modified_time を使った別の依頼：conflict が返り、本文が変わらないこと
4. `replace_exact`：一致が 0 件または複数件なら invalid_request、ちょうど 1 件なら置換されること

### 6. Make から切り替える
検証が済んだら、AI-Rules.md と system-maintenance.md の保存ツールの記述を新しいツールに更新します。Make のシナリオは削除せず、**無効化して残しておきます**（切り戻し用）。

## 開発
```bash
npm test          # 偽の Drive で保存ロジックを検証
npm run check     # バンドルの確認（デプロイしない）
npm run deploy
```

## 制約
- このMCPから同じファイルへの保存はファイルごとのDurable Objectで直列化します。Obsidian等の直接編集にはこの制御が働かず、Driveの版確認と書込み自体も原子的ではありません。直接編集との同時保存は避けてください
- 再送防止の記録は直近の 1 件だけです（Make 版と同じ）
- Workers の無料枠では、1 リクエストあたりの CPU 時間が 10 ミリ秒までです。Drive の応答を待つ時間は含まれませんが、大きな本文で上限に当たった場合は Cloudflare のログに表示されます

## 1.1.0の追加機能

- `read_shared_knowledge`に`section`（見出し名の完全一致）または`product_ids`（商品ID配列）を指定すると必要部分を返します。選択は併用できません。`complete=false`は部分本文です。全文保存の元には使わず、保存直前に選択なしで再取得してください。選択は返却量を減らすもので、Driveからの取得は全文です。
- 読取り前後で版を照合し、不整合なスナップショットは再取得します。変更が続く場合は競合として返します。
- `check_shared_knowledge`で表の列数、分離した商品行、商品ID重複、参照切れを点検します。専用テストMDを除外します。意味の矛盾や出典の正しさを保証しません。
- 保存時には新しく発生する構造の問題を拒否します。既存の問題を直す変更は妨げません。欠落IDの全ファイル横断検査は明示的な点検ツールで実行します。
- 保存はファイルごとの`KnowledgeCoordinator`で直列化します。処理が失敗しても次の保存を止めません。Durable ObjectsはSQLite版を使用し、名前空間を増やす変更は設定ファイルで管理します。
- 本文と再送判定用appPropertiesを1回のDrive multipart PATCHで送ります。応答や照合が途中で失われた場合も、同じ依頼をそのまま再送して判定できます。全文照合と記録の確認を終えた場合だけ成功を返します。
- Google Drive APIの仕様：https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Durable Objectsの無料枠：https://developers.cloudflare.com/durable-objects/platform/pricing/

## 1.2.0の追加機能（外部の有料APIを使わない検索）

- `search_shared_knowledge({query, file_ids?, limit?})`は、質問の分野に応じて対象ファイルを絞り、語句・別名・見出しで検索します。対象不明なら全件を無条件に読まず`needs_scope=true`を返します。明示的な`file_ids`指定も可能です。専用テストMDは対象外です。
- `read_shared_knowledge({file_id, query, limit?})`で1ファイル内だけの検索もできます。`section`・`product_ids`とは併用できません。
- 結果は原文の抜粋、見出し、行番号、版の時刻、取得できた確認範囲とともに返します。順位は語句の関連性です。真偽判定・医学的判断・網羅的な一覧ではありません。結果がないことも、情報がない証拠にはなりません。
- 検索は関連箇所を見つける入口です。全件列挙・成分の合計・根拠の確認には、該当する見出し等を追加取得してください。検索結果は`complete=false`であり、全文保存の元には使えません。
- 外部のモデルAPI・埋め込みAPI・有料サービス・新しい保存領域・定期タスクは追加していません。既存のCloudflare無料枠・Drive APIを使用し、無料枠を超えれば停止し得ます。
- 公開用の匿名データで自動試験33件。本人データを使う検索評価は公開リポジトリへ置かず、回答モデルの正答率と分けて扱います。

## 1.2.1の保存確認

- 書込み応答のversionだけと比較せず、保存後のメタデータ→本文→メタデータで安定したスナップショットを確認します。Driveのversionは本文に見えない変更でも進むためです。版が読み取り中に変われば再確認し、外部の本文変更や依頼情報の不一致は成功としません。
- 33件には、書込み応答の版が古い場合と、保存後に外部変更が入った場合の回帰試験を含みます。
