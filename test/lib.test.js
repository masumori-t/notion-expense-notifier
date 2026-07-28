import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readPropertyDisplay,
  extractExpense,
  groupByPayee,
  filterNewExpenses,
  findExpensesToNotify,
  buildNotifiedPageIds,
  buildTaskBlocks,
  formatYen,
  sumValidAmount,
} from "../src/lib.js";

const PROP_NAMES = {
  payee: "回答者",
  amount: "金額",
  summary: "摘要",
  date: "日付",
  category: "科目",
};

test("readPropertyDisplay: formula(number)型を正しく読み取れる", () => {
  const value = readPropertyDisplay({ type: "formula", formula: { type: "number", number: 1500 } });
  assert.equal(value, 1500);
});

test("readPropertyDisplay: rollup(number)型を正しく読み取れる", () => {
  const value = readPropertyDisplay({ type: "rollup", rollup: { type: "number", number: 2000 } });
  assert.equal(value, 2000);
});

test("readPropertyDisplay: checkbox型を正しく読み取れる", () => {
  assert.equal(readPropertyDisplay({ type: "checkbox", checkbox: true }), true);
  assert.equal(readPropertyDisplay({ type: "checkbox", checkbox: false }), false);
});

test("readPropertyDisplay: created_by型を正しく読み取れる(実DBの「回答者」列)", () => {
  const value = readPropertyDisplay({
    type: "created_by",
    created_by: { object: "user", id: "u1", name: "山口マキ" },
  });
  assert.equal(value, "山口マキ");
});

test("readPropertyDisplay: created_by型で名前が無い場合はメールにフォールバックする", () => {
  const value = readPropertyDisplay({
    type: "created_by",
    created_by: { object: "user", id: "u1", person: { email: "maki@example.com" } },
  });
  assert.equal(value, "maki@example.com");
});

test("readPropertyDisplay: multi_select型はカンマ区切りの文字列になる(実DBの「科目」列)", () => {
  const value = readPropertyDisplay({
    type: "multi_select",
    multi_select: [{ name: "旅費交通費" }, { name: "雑費" }],
  });
  assert.equal(value, "旅費交通費, 雑費");
});

test("extractExpense: 金額がformula型でも数値として抽出できる", () => {
  const page = {
    id: "page1",
    url: "https://notion.so/page1",
    created_time: "2026-07-01T00:00:00.000Z",
    properties: {
      回答者: { type: "title", title: [{ plain_text: "山田太郎" }] },
      金額: { type: "formula", formula: { type: "number", number: 999 } },
      摘要: { type: "rich_text", rich_text: [{ plain_text: "テスト" }] },
      日付: { type: "date", date: { start: "2026-07-01" } },
      科目: { type: "select", select: { name: "旅費交通費" } },
    },
  };
  const expense = extractExpense(page, PROP_NAMES);
  assert.equal(expense.amount, 999);
  assert.equal(expense.payee, "山田太郎");
  assert.equal(expense.amountInvalid, false);
  assert.equal(expense.createdAt, "2026-07-01T00:00:00.000Z");
});

test("extractExpense: 金額が不正な文字列でも0円にフォールバックし、amountInvalidがtrueになる(クラッシュしない)", () => {
  const page = {
    id: "page2",
    url: "https://notion.so/page2",
    created_time: "2026-07-01T00:00:00.000Z",
    properties: {
      回答者: { type: "title", title: [{ plain_text: "鈴木花子" }] },
      // 実DBの「金額(税込総額)」はテキスト型のため、"テスト"のような非数値が入り得る
      金額: { type: "rich_text", rich_text: [{ plain_text: "テスト" }] },
    },
  };
  const expense = extractExpense(page, PROP_NAMES);
  assert.equal(expense.amount, 0);
  assert.equal(expense.amountInvalid, true);
});

test("extractExpense: 金額が空文字の場合はamountInvalidにしない(未入力と不正値を区別する)", () => {
  const page = {
    id: "page3",
    url: "https://notion.so/page3",
    created_time: "2026-07-01T00:00:00.000Z",
    properties: {
      回答者: { type: "title", title: [{ plain_text: "空欄さん" }] },
      金額: { type: "rich_text", rich_text: [] },
    },
  };
  const expense = extractExpense(page, PROP_NAMES);
  assert.equal(expense.amount, 0);
  assert.equal(expense.amountInvalid, false);
});

test("groupByPayee: 同一回答者の金額が正しく合計される", () => {
  const groups = groupByPayee([
    { payee: "Aさん", amount: 100 },
    { payee: "Bさん", amount: 200 },
    { payee: "Aさん", amount: 50 },
  ]);
  const aGroup = groups.find((g) => g.payee === "Aさん");
  assert.equal(aGroup.total, 150);
  assert.equal(aGroup.items.length, 2);
});

test("filterNewExpenses: lastCheckedAtがnull(初回実行)なら全件を新規とみなす", () => {
  const expenses = [{ pageId: "p1", createdAt: "2020-01-01T00:00:00.000Z" }];
  const result = filterNewExpenses(expenses, null);
  assert.equal(result.length, 1);
});

test("filterNewExpenses: lastCheckedAtより後に作成されたものだけを新規とみなす", () => {
  const expenses = [
    { pageId: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { pageId: "new", createdAt: "2026-07-23T00:00:00.000Z" },
  ];
  const result = filterNewExpenses(expenses, "2026-06-01T00:00:00.000Z");
  assert.deepEqual(result.map((e) => e.pageId), ["new"]);
});

test("filterNewExpenses: createdAtが無いデータは安全側に倒して新規とみなす", () => {
  const expenses = [{ pageId: "unknown", createdAt: null }];
  const result = filterNewExpenses(expenses, "2026-06-01T00:00:00.000Z");
  assert.equal(result.length, 1);
});

test("findExpensesToNotify: notifiedPageIdsがある場合は未通知のpageIdだけを返す", () => {
  const expenses = [
    { pageId: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { pageId: "new", createdAt: "2026-07-28T00:00:00.000Z" },
  ];
  const result = findExpensesToNotify(expenses, {
    lastCheckedAt: "2026-07-01T00:00:00.000Z",
    notifiedPageIds: ["old"],
  });
  assert.deepEqual(result.map((e) => e.pageId), ["new"]);
});

test("findExpensesToNotify: notifiedPageIdsが空なら時刻ベースにフォールバックする", () => {
  const expenses = [
    { pageId: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { pageId: "new", createdAt: "2026-07-28T00:00:00.000Z" },
  ];
  const result = findExpensesToNotify(expenses, {
    lastCheckedAt: "2026-07-01T00:00:00.000Z",
    notifiedPageIds: [],
  });
  assert.deepEqual(result.map((e) => e.pageId), ["new"]);
});

test("buildNotifiedPageIds: 現在の未清算IDを通知済みとして残す", () => {
  const result = buildNotifiedPageIds(
    [{ pageId: "a" }, { pageId: "b" }],
    ["a", "settled-already"]
  );
  assert.deepEqual(result.sort(), ["a", "b"]);
});

test("sumValidAmount: amountInvalidな行を除外して合計する", () => {
  const groups = groupByPayee([
    { payee: "Aさん", amount: 100, amountInvalid: false },
    { payee: "Aさん", amount: 0, amountInvalid: true },
  ]);
  assert.equal(sumValidAmount(groups), 100);
});

test("buildTaskBlocks: 対象が0件ならヘッダーのみのブロックになる", () => {
  const blocks = buildTaskBlocks([]);
  assert.ok(blocks.length >= 2);
  assert.equal(blocks[0].type, "paragraph");
});

test("buildTaskBlocks: 回答者ごとに見出し+チェックリストが作られる", () => {
  const groups = groupByPayee([
    {
      pageId: "p1",
      url: "https://notion.so/p1",
      payee: "ヤマグチマキ",
      amount: 306,
      amountInvalid: false,
      date: "7/8",
      summary: "ガソリン代",
      category: "旅費交通費",
    },
  ]);
  const blocks = buildTaskBlocks(groups);
  const headingBlock = blocks.find((b) => b.type === "heading_3");
  assert.ok(headingBlock, "見出しブロックが存在するはず");
  assert.match(headingBlock.heading_3.rich_text[0].text.content, /ヤマグチマキ/);

  const todoBlock = blocks.find((b) => b.type === "to_do");
  assert.ok(todoBlock, "to_doブロックが存在するはず");
  const todoText = todoBlock.to_do.rich_text.map((t) => t.text.content).join("");
  assert.match(todoText, /ガソリン代/);
  assert.match(todoText, /¥306/);
});

test("buildTaskBlocks: newPageIdsに含まれる行には🆕マークが付く", () => {
  const groups = groupByPayee([
    { pageId: "new1", url: "u", payee: "Aさん", amount: 100, amountInvalid: false, date: "7/1" },
  ]);
  const blocks = buildTaskBlocks(groups, { newPageIds: new Set(["new1"]) });
  const todoBlock = blocks.find((b) => b.type === "to_do");
  const todoText = todoBlock.to_do.rich_text.map((t) => t.text.content).join("");
  assert.match(todoText, /🆕/);
});

test("buildTaskBlocks: 金額が不正な行は⚠️付きで表示され、合計には含まれない", () => {
  const groups = groupByPayee([
    { pageId: "invalid1", url: "u", payee: "Bさん", amount: 0, amountInvalid: true, amountRaw: "テスト" },
    { pageId: "valid1", url: "u2", payee: "Bさん", amount: 500, amountInvalid: false },
  ]);
  const blocks = buildTaskBlocks(groups);
  const totalParagraph = blocks.find(
    (b) => b.type === "paragraph" && b.paragraph.rich_text[0].text.content.includes("合計金額")
  );
  assert.match(totalParagraph.paragraph.rich_text[0].text.content, /¥500/);

  const warnTodo = blocks.find(
    (b) => b.type === "to_do" && b.to_do.rich_text.some((t) => t.text.content.includes("⚠️"))
  );
  assert.ok(warnTodo, "要確認のto_doブロックが存在するはず");
});

test("formatYen: 3桁区切りの円表記になる", () => {
  assert.equal(formatYen(1562), "¥1,562");
});
