// 小口精算通知ツールの純粋関数(ネットワーク呼び出しを含まない)をまとめたモジュール。
// Notion APIのレスポンス整形・集計・タスク本文生成ロジックを、テストしやすい形で分離している。

/**
 * Notionのプロパティオブジェクトから、人が読める文字列/値を取り出す。
 * プロパティの型(title/rich_text/people/created_by/select/date/number/checkbox等)に応じて処理を分岐する。
 */
export function readPropertyDisplay(property) {
  if (!property || !property.type) return "";

  switch (property.type) {
    case "title":
      return (property.title ?? []).map((t) => t.plain_text).join("");
    case "rich_text":
      return (property.rich_text ?? []).map((t) => t.plain_text).join("");
    case "people":
      return (property.people ?? [])
        .map((p) => p.name || p.person?.email || "(名前未設定)")
        .join(", ");
    case "created_by":
      // 実データベースでは「回答者」がこの型(ページ作成者=フォーム送信者を自動記録)になっている。
      // https://developers.notion.com/reference/property-object#created-by
      return property.created_by?.name || property.created_by?.person?.email || "(名前未設定)";
    case "select":
      return property.select?.name ?? "";
    case "status":
      return property.status?.name ?? "";
    case "multi_select":
      // 実データベースでは「科目」「清算月」がこの型(複数選択可)になっている。
      return (property.multi_select ?? []).map((s) => s.name).join(", ");
    case "date":
      return property.date?.start ?? "";
    case "number":
      return property.number ?? 0;
    case "checkbox":
      return Boolean(property.checkbox);
    case "email":
      return property.email ?? "";
    case "url":
      return property.url ?? "";
    case "created_time":
      return property.created_time ?? "";
    case "last_edited_time":
      return property.last_edited_time ?? "";
    case "formula": {
      // 「金額」列などが計算式(formula)で定義されている場合に対応する
      const inner = property.formula;
      if (!inner) return "";
      switch (inner.type) {
        case "number":
          return inner.number ?? 0;
        case "string":
          return inner.string ?? "";
        case "boolean":
          return Boolean(inner.boolean);
        case "date":
          return inner.date?.start ?? "";
        default:
          return "";
      }
    }
    case "rollup": {
      // 「金額」列などがrollup(集計)で定義されている場合に対応する
      const inner = property.rollup;
      if (!inner) return "";
      if (inner.type === "number") return inner.number ?? 0;
      if (inner.type === "array") {
        return inner.array
          .map((item) => readPropertyDisplay(item))
          .filter((value) => value !== "" && value !== null && value !== undefined)
          .join(", ");
      }
      return "";
    }
    default:
      return "";
  }
}

/**
 * Notionのページ(1行)から、通知に必要な項目を抽出する。
 * @param {object} page - Notion API の page オブジェクト
 * @param {object} propNames - { payee, amount, summary, date, category } のプロパティ名マップ
 */
export function extractExpense(page, propNames) {
  const properties = page.properties ?? {};

  const payee = readPropertyDisplay(properties[propNames.payee]) || "(回答者不明)";
  const amountRaw = readPropertyDisplay(properties[propNames.amount]);
  const parsedAmount = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);
  const amountInvalid = amountRaw !== "" && Number.isNaN(parsedAmount);
  if (amountInvalid) {
    // 金額を0円として静かに扱うと過少集計に気づけないため、必ず警告を出す
    console.warn(
      `[lib] 金額のパースに失敗しました(pageId=${page.id}, raw=${JSON.stringify(amountRaw)})。` +
        `0円として扱います。PROP_AMOUNT やNotion側のプロパティ型を確認してください。`
    );
  }
  const amount = Number.isNaN(parsedAmount) ? 0 : parsedAmount;
  const summary = readPropertyDisplay(properties[propNames.summary]);
  const date = readPropertyDisplay(properties[propNames.date]);
  const category = readPropertyDisplay(properties[propNames.category]);

  return {
    pageId: page.id,
    url: page.url,
    // ページ自体の作成時刻(=フォーム送信時刻)。「前回チェック以降に新しく追加されたか」の判定に使う。
    // Notionのページオブジェクトには常に created_time が付与されるため、
    // 個別のプロパティ名(「提出日時」等)に依存しない。
    createdAt: page.created_time ?? null,
    payee,
    amount,
    amountInvalid,
    amountRaw,
    summary,
    date,
    category,
  };
}

/**
 * 精算項目一覧を回答者ごとにグルーピングし、合計金額を計算する。
 * @param {Array<{payee:string, amount:number}>} expenses
 * @returns {Array<{payee:string, total:number, items:Array}>} 回答者名の昇順(日本語ロケール)でソート
 */
export function groupByPayee(expenses) {
  const map = new Map();

  for (const expense of expenses) {
    const key = expense.payee || "(回答者不明)";
    if (!map.has(key)) {
      map.set(key, { payee: key, total: 0, items: [] });
    }
    const group = map.get(key);
    group.total += expense.amount;
    group.items.push(expense);
  }

  return Array.from(map.values()).sort((a, b) => a.payee.localeCompare(b.payee, "ja"));
}

/**
 * 「前回チェック以降に新しく追加された(=フォームに送信された)データ」だけを抜き出す。
 * lastCheckedAt が null(=初回実行)の場合は、現在の未清算データすべてを「新規」とみなす。
 * @param {Array<{createdAt: string|null}>} expenses
 * @param {string|null} lastCheckedAt - ISO8601文字列、または未実行を表す null
 */
export function filterNewExpenses(expenses, lastCheckedAt) {
  if (!lastCheckedAt) {
    return expenses;
  }
  const lastCheckedTime = new Date(lastCheckedAt).getTime();
  return expenses.filter((expense) => {
    if (!expense.createdAt) return true; // 作成時刻が取れない場合は安全側に倒して「新規」扱いにする
    return new Date(expense.createdAt).getTime() > lastCheckedTime;
  });
}

/**
 * NotionのページIDを比較用に正規化する(ハイフン有無の差を吸収する)。
 * @param {string} pageId
 */
export function normalizePageId(pageId) {
  if (!pageId || typeof pageId !== "string") return "";
  return pageId.replace(/-/g, "").toLowerCase();
}

/**
 * まだタスク通知していない未清算データだけを抜き出す。
 * notifiedPageIds が空(=旧state形式からの移行直後など)の場合は、時刻ベース(filterNewExpenses)にフォールバックする。
 * @param {Array<{pageId:string, createdAt:string|null}>} expenses
 * @param {{ lastCheckedAt?: string|null, notifiedPageIds?: string[] }} state
 */
export function findExpensesToNotify(expenses, state = {}) {
  const notifiedPageIds = state.notifiedPageIds ?? [];
  if (notifiedPageIds.length > 0) {
    const notified = new Set(notifiedPageIds.map(normalizePageId).filter(Boolean));
    return expenses.filter((expense) => !notified.has(normalizePageId(expense.pageId)));
  }
  return filterNewExpenses(expenses, state.lastCheckedAt ?? null);
}

/**
 * タスク作成後に保存する「通知済みpageId」一覧を作る。
 * 現在の未清算IDをすべて通知済みとし、すでに清算済みになった古いIDは捨てる(肥大化防止)。
 * @param {Array<{pageId:string}>} expenses - 現在の未清算一覧
 * @param {string[]} [previousNotifiedPageIds]
 */
export function buildNotifiedPageIds(expenses, previousNotifiedPageIds = []) {
  const currentIds = expenses.map((expense) => expense.pageId).filter(Boolean);
  const currentNormalized = new Set(currentIds.map(normalizePageId));
  // 現在未清算のものだけ残せば十分(清算済みIDを持ち続ける必要はない)
  // 保存形式は Notion API が返すハイフン付きIDを優先する
  const byNormalized = new Map();
  for (const id of currentIds) {
    byNormalized.set(normalizePageId(id), id);
  }
  for (const id of previousNotifiedPageIds ?? []) {
    const key = normalizePageId(id);
    if (currentNormalized.has(key) && !byNormalized.has(key)) {
      byNormalized.set(key, id);
    }
  }
  return Array.from(byNormalized.values());
}

// Intl.NumberFormatの style:"currency" は実行環境のICUデータによって
// 全角の「￥」(U+FFE5)を返す場合があるため、桁区切りのみ利用して
// 半角の「¥」(U+00A5)を明示的に付ける(report.html等の表記と一致させる)。
const NUMBER_FORMATTER = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 0,
});

export function formatYen(amount) {
  return `¥${NUMBER_FORMATTER.format(amount)}`;
}

/**
 * groupByPayee() の戻り値から、金額が正しくパースできた行だけを合計する。
 * (amountInvalid な行は0円として扱われているが、意図的に除外して合計する方が実態に近いため)
 * @param {Array} groups - groupByPayee() の戻り値
 */
export function sumValidAmount(groups) {
  return groups.reduce(
    (sum, group) => sum + group.items.filter((item) => !item.amountInvalid).reduce((s, item) => s + item.amount, 0),
    0
  );
}

/**
 * Notionページ(通常のNotion API pages.create の children)に渡す、
 * 「未清算リスト」タスクの本文ブロック配列を組み立てる。
 * 回答者ごとに見出し+チェックリストのセクションを作り、
 * 金額が不正な行は要確認セクションにまとめて警告する。
 * @param {Array} groups - groupByPayee() の戻り値(内訳には全ての未清算データを渡す)
 * @param {{ newPageIds?: Set<string> }} options - 「前回チェック以降の新規データ」のpageId集合。渡すと🆕マークを付ける
 * @returns {Array<object>} Notion API の block object の配列
 */
export function buildTaskBlocks(groups, options = {}) {
  const newPageIds = options.newPageIds ?? new Set();

  const paragraph = (text) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  });
  const heading = (text) => ({
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
  });
  const todo = (text, { link } = {}) => ({
    object: "block",
    type: "to_do",
    to_do: {
      checked: false,
      rich_text: link
        ? [
            { type: "text", text: { content: `${text} ` } },
            { type: "text", text: { content: "詳細", link: { url: link } } },
          ]
        : [{ type: "text", text: { content: text } }],
    },
  });
  const divider = () => ({ object: "block", type: "divider", divider: {} });

  const blocks = [];

  const validGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.amountInvalid),
      invalidItems: group.items.filter((item) => item.amountInvalid),
    }))
    .filter((group) => group.items.length > 0 || group.invalidItems.length > 0);

  const grandTotal = validGroups.reduce((sum, g) => sum + g.total, 0);
  const totalItemCount = validGroups.reduce((sum, g) => sum + g.items.length + g.invalidItems.length, 0);

  blocks.push(
    paragraph(
      `未清算の小口精算が ${validGroups.length}名 / ${totalItemCount}件 あります。内容を確認して支払いを行ってください。`
    )
  );
  blocks.push(paragraph(`合計金額(有効データのみ): ${formatYen(grandTotal)}`));
  blocks.push(divider());

  for (const group of validGroups) {
    blocks.push(heading(`${group.payee} さん  ${formatYen(group.total)}（${group.items.length}件）`));
    for (const item of group.items) {
      const isNew = newPageIds.has(item.pageId);
      const detailParts = [
        isNew ? "🆕" : null,
        item.date || null,
        item.summary || null,
        item.category ? `[${item.category}]` : null,
        formatYen(item.amount),
      ]
        .filter(Boolean)
        .join(" ");
      blocks.push(todo(detailParts, { link: item.url }));
    }
    for (const item of group.invalidItems) {
      const isNew = newPageIds.has(item.pageId);
      const detailParts = [
        isNew ? "🆕" : null,
        "⚠️ 金額が数値になっていません:",
        JSON.stringify(item.amountRaw),
        item.summary || null,
      ]
        .filter(Boolean)
        .join(" ");
      blocks.push(todo(detailParts, { link: item.url }));
    }
  }

  return blocks;
}
