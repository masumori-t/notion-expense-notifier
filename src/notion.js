// Notion APIとのやり取りを担当するモジュール。
// 参考(公式ドキュメント):
// - https://developers.notion.com/reference/query-a-data-source (旧: post-database-query。API 2025-09-03で分離)
// - https://developers.notion.com/reference/filter-data-source-entries
// - https://developers.notion.com/reference/post-page (タスク作成)
// - https://developers.notion.com/reference/request-limits
//
// 注意: @notionhq/client v5.x(API version 2025-09-03以降)では、
// データベースは複数の「データソース」を持てるようになり、
// ページ検索は databases.query ではなく dataSources.query を使う必要がある。
// そのため database_id → data_source_id の解決を先に行う。

/**
 * 「未清算」を表す filter を組み立てる。
 * 「清算完了」プロパティの実際の型(checkbox / status / select)に応じて
 * SETTLED_PROPERTY_TYPE 環境変数で切り替えられるようにしている。
 * (実データベースには「上司の承認」に相当する承認用チェックボックスは実質存在しないため、
 *  清算完了のみで判定する仕様に簡略化している)
 */
export function buildFilter({ settledProperty, settledPropertyType = "checkbox", settledValue }) {
  return buildBooleanLikeCondition({
    property: settledProperty,
    propertyType: settledPropertyType,
    // 「未清算」= 完了していない状態を表す条件
    targetValue: false,
    // status/select型のとき、「完了」に相当する値の名前(例:"完了")。checkbox型では未使用。
    truthyValue: settledValue,
  });
}

/**
 * checkbox / status / select のいずれの型でも「真偽的な条件」を組み立てる共通ヘルパー。
 * @param {boolean} targetValue - checkbox型のとき、equalsに使う真偽値
 * @param {string} truthyValue - status/select型のとき、「真」に相当する値の名前(例:"承認済み")
 */
function buildBooleanLikeCondition({ property, propertyType, targetValue, truthyValue }) {
  switch (propertyType) {
    case "checkbox":
      return { property, checkbox: { equals: targetValue } };
    case "status":
      return targetValue
        ? { property, status: { equals: truthyValue } }
        : { property, status: { does_not_equal: truthyValue } };
    case "select":
      return targetValue
        ? { property, select: { equals: truthyValue } }
        : { property, select: { does_not_equal: truthyValue } };
    default:
      throw new Error(
        `未対応のプロパティ型: "${propertyType}" (checkbox / status / select のいずれかを指定してください。対象プロパティ: ${property})`
      );
  }
}

/**
 * database_id から data_source_id を解決する。
 * 1つのデータベースが複数の data source を持つ場合(マルチソースDB)は先頭を採用し、警告を出す。
 * 同一プロセス内で同じdatabase_idに対する解決結果はキャッシュする。
 * https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03
 */
const dataSourceIdCache = new Map();

export async function resolveDataSourceId(notionClient, databaseId) {
  if (dataSourceIdCache.has(databaseId)) {
    return dataSourceIdCache.get(databaseId);
  }

  const database = await notionClient.databases.retrieve({ database_id: databaseId });

  const dataSources = database.data_sources ?? [];
  if (dataSources.length === 0) {
    throw new Error(
      `データベース(${databaseId})に data source が見つかりません。NOTION_DATABASE_ID を確認してください。`
    );
  }
  if (dataSources.length > 1) {
    console.warn(
      `[notion] データベース(${databaseId})に data source が${dataSources.length}件あります。` +
        `先頭の "${dataSources[0].name}"(${dataSources[0].id})を使用します。`
    );
  }

  const dataSourceId = dataSources[0].id;
  dataSourceIdCache.set(databaseId, dataSourceId);
  return dataSourceId;
}

/**
 * フィルタ条件に合致する全ページを取得する(ページネーション対応)。
 * リトライ(429レート制限・5xx)は @notionhq/client 側の組み込みリトライ機能に委ねている。
 * 組み込みリトライは Retry-After ヘッダーを正しく解釈し、指数バックオフ+ジッターも行うため、
 * 自前でラップするより確実(https://github.com/makenotion/notion-sdk-js 参照)。
 */
export async function queryAllPages(notionClient, databaseId, filter) {
  const dataSourceId = await resolveDataSourceId(notionClient, databaseId);
  const pages = [];
  let cursor = undefined;

  do {
    const response = await notionClient.dataSources.query({
      data_source_id: dataSourceId,
      filter,
      start_cursor: cursor,
      page_size: 100,
    });
    // 念のため object !== "page" の要素は除外する(防御的プログラミング)
    pages.push(...response.results.filter((result) => result.object === "page"));
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

/**
 * 「小口清算をする」タスクを、指定したタスクDB(data source)に作成する。
 * @param {object} notionClient - @notionhq/client の Client インスタンス
 * @param {object} params
 * @param {string} params.taskDataSourceId - タスクを作成するdata sourceのID(タスクDB)
 * @param {string} params.titleProperty - タイトルプロパティ名(例: "内容")
 * @param {string} params.title - タスクのタイトル(例: "小口清算をする")
 * @param {string} [params.assigneeUserId] - 担当者に設定するNotionユーザーID(personプロパティ)
 * @param {string} [params.assigneeProperty] - 担当者プロパティ名(例: "対応者")
 * @param {string} [params.statusProperty] - ステータスプロパティ名(例: "ステータス")
 * @param {string} [params.statusValue] - ステータスの初期値(例: "❗️Todo")
 * @param {string} [params.dueDateProperty] - 期日プロパティ名(例: "予定日")
 * @param {string} [params.dueDate] - 期日(YYYY-MM-DD)
 * @param {string} [params.icon] - ページアイコン(絵文字)
 * @param {Array<object>} params.children - ページ本文のブロック配列(lib.js の buildTaskBlocks で生成)
 */
export async function createExpenseTask(notionClient, params) {
  const {
    taskDataSourceId,
    titleProperty,
    title,
    assigneeUserId,
    assigneeProperty,
    statusProperty,
    statusValue,
    dueDateProperty,
    dueDate,
    icon,
    children,
  } = params;

  const properties = {
    [titleProperty]: { title: [{ type: "text", text: { content: title } }] },
  };

  if (assigneeUserId && assigneeProperty) {
    properties[assigneeProperty] = { people: [{ object: "user", id: assigneeUserId }] };
  }
  if (statusValue && statusProperty) {
    properties[statusProperty] = { status: { name: statusValue } };
  }
  if (dueDate && dueDateProperty) {
    properties[dueDateProperty] = { date: { start: dueDate } };
  }

  // Notion API は children を1リクエストにつき最大100ブロックまでしか受け付けないため
  // (https://developers.notion.com/reference/patch-block-children)、超える場合は
  // 作成後に append-block-children で追加する。
  const FIRST_BATCH_SIZE = 100;
  const firstBatch = children.slice(0, FIRST_BATCH_SIZE);
  const remainingBatches = [];
  for (let i = FIRST_BATCH_SIZE; i < children.length; i += FIRST_BATCH_SIZE) {
    remainingBatches.push(children.slice(i, i + FIRST_BATCH_SIZE));
  }

  const page = await notionClient.pages.create({
    parent: { type: "data_source_id", data_source_id: taskDataSourceId },
    icon: icon ? { type: "emoji", emoji: icon } : undefined,
    properties,
    children: firstBatch,
  });

  for (const batch of remainingBatches) {
    await notionClient.blocks.children.append({ block_id: page.id, children: batch });
  }

  return page;
}

/**
 * Notion APIのエラーを、対処法がわかりやすい日本語メッセージに変換する。
 */
export function describeNotionError(error) {
  const code = error?.code;
  const status = error?.status;

  if (status === 404 || code === "object_not_found") {
    return (
      "Notionデータベース(またはタスクDB)が見つかりません(404)。" +
      "対象のデータベースに、作成したインテグレーション(接続)を共有していない可能性があります。" +
      "データベースを開き、「•••」→「Connections」から接続を追加してください。"
    );
  }
  if (status === 401 || code === "unauthorized") {
    return "Notion APIトークンが無効です(401)。NOTION_API_KEY を確認してください。";
  }
  if (status === 403 || code === "restricted_resource") {
    return (
      "Notion接続の権限が不足しています(403)。" +
      "インテグレーションの Capabilities で「Read content」「Update content」「Insert content」が" +
      "有効になっているか確認してください。"
    );
  }
  if (status === 429 || code === "rate_limited") {
    return "Notion APIのレート制限に達しました(429)。しばらく待って再実行してください。";
  }
  if (code === "validation_error") {
    return (
      "Notionへのリクエストが不正です(validation_error)。" +
      "プロパティ名や「清算完了」プロパティの型(SETTLED_PROPERTY_TYPE)、" +
      "タスクDB側のプロパティ名(TASK_*_PROPERTY)が実際のDB定義と一致しているか確認してください。"
    );
  }
  return error?.message ?? String(error);
}
