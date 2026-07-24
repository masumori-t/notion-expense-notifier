#!/usr/bin/env node
// Notionの小口精算フォーム回答データベースを定期チェックし、
// 「清算完了」が未チェックのデータを回答者ごとに集計して、
// 前回チェック時から新規データが増えていた場合のみ、Notionの「KT_タスク」DBに
// 「小口清算をする」タスクを作成して担当者にアサインするメインスクリプト。
//
// 実行方法:
//   node src/notify.js          … 実際にNotionを検索し、必要ならタスクを作成する
//   node src/notify.js --dry-run … Notionは検索するがタスク作成・状態ファイル更新は行わずコンソール表示のみ(動作確認用)
//
// 必須環境変数: NOTION_API_KEY, NOTION_DATABASE_ID, NOTION_TASK_DATA_SOURCE_ID
// 詳細は README.md を参照。

import "dotenv/config";
import { Client } from "@notionhq/client";
import { buildFilter, queryAllPages, createExpenseTask, describeNotionError } from "./notion.js";
import {
  extractExpense,
  groupByPayee,
  filterNewExpenses,
  buildTaskBlocks,
  formatYen,
  sumValidAmount,
} from "./lib.js";
import { loadState, saveState } from "./state.js";

const PROP_NAMES = {
  payee: process.env.PROP_PAYEE ?? "回答者",
  // ※実際のNotion側のプロパティ名と1文字でも違うと取得できないため、
  //   異なる場合は .env の PROP_AMOUNT などで上書きしてください(詳細はREADME参照)
  amount: process.env.PROP_AMOUNT ?? "金額（税込総額）",
  summary: process.env.PROP_SUMMARY ?? "摘要",
  date: process.env.PROP_DATE ?? "日付",
  category: process.env.PROP_CATEGORY ?? "科目",
  settled: process.env.PROP_SETTLED ?? "清算完了",
};

const SETTLED_PROPERTY_TYPE = process.env.SETTLED_PROPERTY_TYPE ?? "checkbox";
// SETTLED_PROPERTY_TYPE が status/select の場合のみ使う、「完了」に相当する値の名前
const SETTLED_VALUE = process.env.SETTLED_VALUE;

const TASK_CONFIG = {
  titleProperty: process.env.TASK_TITLE_PROPERTY ?? "内容",
  title: process.env.TASK_TITLE ?? "小口清算をする",
  assigneeProperty: process.env.TASK_ASSIGNEE_PROPERTY ?? "対応者",
  assigneeUserId: process.env.NOTION_ASSIGNEE_USER_ID,
  statusProperty: process.env.TASK_STATUS_PROPERTY ?? "ステータス",
  statusValue: process.env.TASK_STATUS_VALUE ?? "❗️Todo",
  dueDateProperty: process.env.TASK_DUE_DATE_PROPERTY ?? "予定日",
  icon: process.env.TASK_ICON ?? "💴",
};

const STATE_FILE_PATH = process.env.STATE_FILE_PATH ?? "state/last-checked.json";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません。README.md の初期設定手順を確認してください。`);
  }
  return value;
}

function todayIso() {
  // 予定日プロパティに使う「今日の日付」(Asia/Tokyo基準、YYYY-MM-DD)。
  // en-CA ロケールは元々 YYYY-MM-DD 形式を返すため、そのまま利用できる。
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";

  const notionApiKey = requireEnv("NOTION_API_KEY");
  const databaseId = requireEnv("NOTION_DATABASE_ID");
  const taskDataSourceId = requireEnv("NOTION_TASK_DATA_SOURCE_ID");
  if (!TASK_CONFIG.assigneeUserId) {
    console.warn("[notify] NOTION_ASSIGNEE_USER_ID が未設定のため、タスクの担当者は設定されません。");
  }

  // リトライは@notionhq/client組み込みの機能に任せる(Retry-Afterヘッダーを解釈し、
  // 指数バックオフ+ジッターを行う。429は常にリトライ、5xxはGET/DELETEのみ)
  const notion = new Client({ auth: notionApiKey, retry: { maxRetries: 3 } });

  const filter = buildFilter({
    settledProperty: PROP_NAMES.settled,
    settledPropertyType: SETTLED_PROPERTY_TYPE,
    settledValue: SETTLED_VALUE,
  });

  console.log("[notify] Notionデータベースを検索中...", JSON.stringify(filter));

  let pages;
  try {
    pages = await queryAllPages(notion, databaseId, filter);
  } catch (error) {
    console.error("[notify] Notion検索に失敗しました:", describeNotionError(error));
    process.exitCode = 1;
    return;
  }

  console.log(`[notify] 未清算データ ${pages.length} 件を取得しました`);

  const expenses = pages.map((page) => extractExpense(page, PROP_NAMES));

  const state = await loadState(STATE_FILE_PATH);
  const isFirstRun = state.lastCheckedAt === null;
  const newExpenses = filterNewExpenses(expenses, state.lastCheckedAt);

  console.log(
    `[notify] 前回チェック時刻: ${state.lastCheckedAt ?? "(未実行/初回)"} / ` +
      `新規データ: ${newExpenses.length}件`
  );

  if (newExpenses.length === 0) {
    console.log(
      "[notify] 前回チェック以降に新規追加された未清算データはありません。タスクは作成しません。"
    );
    if (isDryRun) {
      console.log("\n----- (dry-runのため実際には何も行っていません) -----\n");
    }
    return;
  }

  // タスク本文には、新規データだけでなく現在未清算の全データを見せる(全体像がわかるように)。
  // 新規データには 🆕 マークを付けて区別する。
  const groups = groupByPayee(expenses);
  const newPageIds = new Set(newExpenses.map((e) => e.pageId));
  const children = buildTaskBlocks(groups, { newPageIds });

  const grandTotal = sumValidAmount(groups);

  if (isDryRun) {
    console.log(
      `\n----- dry-run: 作成される予定のタスク -----\n` +
        `タイトル: ${TASK_CONFIG.title}\n` +
        `新規データ: ${newExpenses.length}件 / 未清算合計: ${formatYen(grandTotal)}\n` +
        `本文ブロック数: ${children.length}\n` +
        `----- (dry-runのため実際にはタスクを作成していません。状態ファイルも更新していません) -----\n`
    );
    return;
  }

  try {
    const page = await createExpenseTask(notion, {
      taskDataSourceId,
      children,
      ...TASK_CONFIG,
      dueDate: todayIso(),
    });
    console.log(`[notify] Notionタスクを作成しました: ${page.url ?? page.id}`);
  } catch (error) {
    console.error("[notify] Notionタスクの作成に失敗しました:", describeNotionError(error));
    process.exitCode = 1;
    return; // 状態ファイルは更新しない(次回また同じ新規データとして再検知させる)
  }

  await saveState(STATE_FILE_PATH, { lastCheckedAt: new Date().toISOString() });
  console.log(`[notify] 状態ファイル(${STATE_FILE_PATH})を更新しました。`);
}

main().catch((error) => {
  console.error("[notify] 想定外のエラーが発生しました:", error);
  process.exitCode = 1;
});
