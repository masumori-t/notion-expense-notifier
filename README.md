# notion-expense-notifier

Notionの「小口精算フォーム」回答データベースを定期的にチェックし、「清算完了」になっていないデータを回答者ごとに集計します。
**前回チェック時から新規に追加されたデータがある場合だけ**、Notionの担当者(あなた)に「小口清算をする」タスクを自動で作成・アサインします。新規データが無ければ何もしません(タスクは重複作成されません)。

## 仕組み

```
[Notion: 小口精算フォーム回答DB]
        │ ①「清算完了」が未チェックの行を取得(GitHub Actions, 1日2回)
        ▼
[notify.js] ─② 前回チェック以降に新規追加された行があるか判定(state/last-checked.json)
        │
        ├─ 新規データなし → 何もしない(終了)
        │
        └─ 新規データあり ─③ 回答者ごとに集計し、Notionページ本文(チェックリスト)を組み立てる
                              ▼
                    [Notion: KT_タスクDB]
                    「💴 小口清算をする」タスクを作成
                    ・対応者 = あなた
                    ・本文 = 現在未清算の全データ(🆕マーク付きで新規分を明示)
```

## 事前準備

### 1. Notion Integration(接続)の作成

1. https://www.notion.so/my-integrations を開き、「New integration」で内部インテグレーションを作成する。
2. 発行された **Internal Integration Secret** を `NOTION_API_KEY` として控える。
3. Capabilities で以下を有効にする:
   - Read content
   - Insert content
   - Update content
4. 対象の2つのデータベースそれぞれで、右上「•••」→「Connections」→ 作成したインテグレーションを追加する。
   - 小口精算フォームの回答データベース(読み取り用)
   - タスクを作成する先のタスクDB(書き込み用)

### 2. 各種IDの取得

| 環境変数 | 取得方法 |
|---|---|
| `NOTION_DATABASE_ID` | 小口精算フォームの回答データベースをブラウザで開き、URL中の32桁の文字列(`?v=`より前の部分) |
| `NOTION_TASK_DATA_SOURCE_ID` | タスクDBをNotionの「fetch」等で開き、`<data-source url="collection://xxxx">` の `xxxx` 部分 |
| `NOTION_ASSIGNEE_USER_ID` | タスクの担当者にしたい自分のNotionユーザーID(ワークスペースのメンバー一覧や `fetch id="self"` などで取得) |

### 3. ローカルでの動作確認

```bash
cd notion-expense-notifier
npm install
cp .env.example .env   # 値を編集する
npm run dry-run         # Notionは検索するが、タスク作成・状態ファイル更新は行わない
npm test                 # ユニットテスト(31件)
```

### 4. GitHub Actionsのセットアップ

1. このフォルダの内容をGitHubリポジトリ(新規 or 既存)にpushする。
2. リポジトリの Settings → Secrets and variables → Actions で以下を登録する:
   - `NOTION_API_KEY`
   - `NOTION_DATABASE_ID`
   - `NOTION_TASK_DATA_SOURCE_ID`
   - `NOTION_ASSIGNEE_USER_ID`
3. Settings → Actions → General → Workflow permissions を **"Read and write permissions"** にする
   (状態ファイル `state/last-checked.json` をワークフローがコミットするため)。
4. `.github/workflows/notify.yml` により、毎日 9:25 / 15:15 (JST) に自動実行される。
   Actionsタブの「Run workflow」から手動実行(dry-runオプション付き)も可能。

## 「新規データ」の判定方法

- 各回答ページの作成時刻(Notionが自動記録する `created_time`)を、前回チェック時刻(`state/last-checked.json`)と比較する。
- 前回チェック時刻より後に作成された行が1件でもあれば「新規データあり」と判定し、タスクを作成する。
- タスク作成に成功した場合のみ `state/last-checked.json` を現在時刻で更新し、GitHub Actionsがそれをリポジトリにコミットする。
  (タスク作成に失敗した場合は状態ファイルを更新しないため、次回実行時にも同じデータが「新規」として再検知される)
- 初回実行時(状態ファイルが存在しない)は、既存の未清算データすべてを「新規」として扱い、最初のタスクを作成する。

## 実データ特有の注意点(想定と異なっていた点)

実際のNotionデータベースを確認した結果、以下の点が一般的なNotion DBの想定と異なっていたため、コードで対応済みです:

- **回答者**: 手入力ではなく `created_by` 型(フォーム送信者のアカウントが自動記録される)
- **金額(税込総額)**: 数値型ではなく **テキスト型**(フォームの説明に「半角数字のみ、￥円不要」とあるため)。数値に変換できない値が入っていた場合は0円として集計から除外し、タスク本文に⚠️付きで「要確認」として表示する(サイレントに無視しない)
- **科目 / 清算月**: 単一選択ではなく **複数選択(multi_select)**
- **上司の承認**: 実データベースには承認用の実質的なプロパティが存在しない(タイトル列が偶然この名前になっているだけ)ため、承認フィルタは使わず「清算完了」のみで未清算を判定する

## 環境変数一覧

`.env.example` を参照してください。

## テスト

```bash
npm test
```

`src/lib.js`(純粋関数: プロパティ読み取り・集計・タスク本文生成・新規判定)、`src/notion.js`(Notion API呼び出し。モッククライアントで検証)、`src/state.js`(状態ファイルの読み書き)をそれぞれユニットテストしています。
