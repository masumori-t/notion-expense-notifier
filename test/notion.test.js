import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter, queryAllPages, resolveDataSourceId, createExpenseTask } from "../src/notion.js";

// Critical修正の検証: databases.query()ではなく、
// databases.retrieve() → dataSources.query() の2段構成で正しく動作することを確認する。

function makeMockClient({ dataSources, queryPages, createdPage }) {
  const calls = { retrieve: 0, query: [], pagesCreate: [], blocksAppend: [] };
  return {
    client: {
      databases: {
        retrieve: async ({ database_id }) => {
          calls.retrieve += 1;
          return { id: database_id, data_sources: dataSources };
        },
      },
      dataSources: {
        query: async (args) => {
          calls.query.push(args);
          const pageIndex = args.start_cursor ? Number(args.start_cursor) : 0;
          return queryPages[pageIndex];
        },
      },
      pages: {
        create: async (args) => {
          calls.pagesCreate.push(args);
          return createdPage ?? { id: "created_page_id", url: "https://notion.so/created_page_id" };
        },
      },
      blocks: {
        children: {
          append: async (args) => {
            calls.blocksAppend.push(args);
            return {};
          },
        },
      },
    },
    calls,
  };
}

test("resolveDataSourceId: database_idからdata_source_idを解決できる", async () => {
  const { client } = makeMockClient({
    dataSources: [{ id: "ds_123", name: "小口精算フォーム回答" }],
    queryPages: [],
  });

  const dataSourceId = await resolveDataSourceId(client, "db_abc_" + Math.random());
  assert.equal(dataSourceId, "ds_123");
});

test("resolveDataSourceId: data_sourcesが空の場合はエラーを投げる", async () => {
  const { client } = makeMockClient({ dataSources: [], queryPages: [] });
  await assert.rejects(
    () => resolveDataSourceId(client, "db_empty_" + Math.random()),
    /data source が見つかりません/
  );
});

test("queryAllPages: dataSources.queryを使い、ページネーションも正しく処理する", async () => {
  const databaseId = "db_paginate_" + Math.random();
  const { client, calls } = makeMockClient({
    dataSources: [{ id: "ds_999", name: "回答テーブル" }],
    queryPages: [
      { results: [{ object: "page", id: "p1" }], has_more: true, next_cursor: "1" },
      { results: [{ object: "page", id: "p2" }], has_more: false, next_cursor: null },
    ],
  });

  const pages = await queryAllPages(client, databaseId, { property: "清算完了", checkbox: { equals: false } });

  assert.deepEqual(pages.map((p) => p.id), ["p1", "p2"]);
  assert.equal(calls.retrieve, 1, "databases.retrieveは1回だけ呼ばれる(キャッシュされる)");
  assert.equal(calls.query.length, 2);
  assert.equal(calls.query[0].data_source_id, "ds_999");
});

test("buildFilter: 清算完了(checkbox)のfilterを返す", () => {
  const filter = buildFilter({ settledProperty: "清算完了" });
  assert.deepEqual(filter, { property: "清算完了", checkbox: { equals: false } });
});

test("buildFilter: settledPropertyTypeがstatus型の場合も正しいfilterになる", () => {
  const filter = buildFilter({
    settledProperty: "清算完了",
    settledPropertyType: "status",
    settledValue: "完了",
  });
  assert.deepEqual(filter, { property: "清算完了", status: { does_not_equal: "完了" } });
});

test("buildFilter: 未対応のプロパティ型ではエラーを投げる", () => {
  assert.throws(
    () => buildFilter({ settledProperty: "清算完了", settledPropertyType: "multi_select" }),
    /未対応のプロパティ型/
  );
});

test("createExpenseTask: タイトル・担当者・ステータス・期日プロパティを正しく組み立ててpages.createを呼ぶ", async () => {
  const { client, calls } = makeMockClient({ dataSources: [], queryPages: [] });

  const page = await createExpenseTask(client, {
    taskDataSourceId: "ds_task_123",
    titleProperty: "内容",
    title: "小口清算をする",
    assigneeProperty: "対応者",
    assigneeUserId: "user_abc",
    statusProperty: "ステータス",
    statusValue: "❗️Todo",
    dueDateProperty: "予定日",
    dueDate: "2026-07-23",
    icon: "💴",
    children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }],
  });

  assert.equal(page.id, "created_page_id");
  assert.equal(calls.pagesCreate.length, 1);
  const createArgs = calls.pagesCreate[0];
  assert.deepEqual(createArgs.parent, { type: "data_source_id", data_source_id: "ds_task_123" });
  assert.deepEqual(createArgs.properties.内容, { title: [{ type: "text", text: { content: "小口清算をする" } }] });
  assert.deepEqual(createArgs.properties.対応者, { people: [{ object: "user", id: "user_abc" }] });
  assert.deepEqual(createArgs.properties.ステータス, { status: { name: "❗️Todo" } });
  assert.deepEqual(createArgs.properties.予定日, { date: { start: "2026-07-23" } });
  assert.deepEqual(createArgs.icon, { type: "emoji", emoji: "💴" });
  assert.equal(createArgs.children.length, 1);
});

test("createExpenseTask: children が100件を超える場合は blocks.children.append で追加送信する", async () => {
  const { client, calls } = makeMockClient({ dataSources: [], queryPages: [] });
  const manyChildren = Array.from({ length: 150 }, (_, i) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: `item ${i}` } }] },
  }));

  await createExpenseTask(client, {
    taskDataSourceId: "ds_task_123",
    titleProperty: "内容",
    title: "小口清算をする",
    children: manyChildren,
  });

  assert.equal(calls.pagesCreate[0].children.length, 100);
  assert.equal(calls.blocksAppend.length, 1);
  assert.equal(calls.blocksAppend[0].children.length, 50);
});

test("createExpenseTask: assigneeUserIdが未指定なら対応者プロパティを設定しない", async () => {
  const { client, calls } = makeMockClient({ dataSources: [], queryPages: [] });

  await createExpenseTask(client, {
    taskDataSourceId: "ds_task_123",
    titleProperty: "内容",
    title: "小口清算をする",
    assigneeProperty: "対応者",
    children: [],
  });

  assert.equal(calls.pagesCreate[0].properties.対応者, undefined);
});
