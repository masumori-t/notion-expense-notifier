// 実行状態を保存/読込するモジュール。
// GitHub Actions のジョブはワーカーが毎回破棄される(実行間で状態を保持しない)ため、
// このファイル(JSON)をリポジトリにコミットして永続化する運用を想定している
// (ワークフロー側で `git commit && git push` する。.github/workflows/notify.yml 参照)。
//
// 保存内容:
// - lastCheckedAt: 最後にタスク作成(または状態更新)した時刻(ログ用)
// - notifiedPageIds: すでにタスク通知した未清算ページのID一覧
//   → 「時刻」ではなく「ページID」で未通知を判定するため、定期実行が遅れても取りこぼしにくい

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = { lastCheckedAt: null, notifiedPageIds: [], lastRunAt: null };

/**
 * 状態ファイルを読み込む。
 * ファイルが存在しない(初回実行)場合やJSONとして壊れている場合は、
 * 安全側のデフォルト値を返す(=現在の未清算データを全て「未通知」扱いにする)。
 * @param {string} filePath
 * @returns {Promise<{ lastCheckedAt: string|null, notifiedPageIds: string[], lastRunAt: string|null }>}
 */
export async function loadState(filePath) {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const lastCheckedAt =
      typeof parsed.lastCheckedAt === "string" || parsed.lastCheckedAt === null
        ? parsed.lastCheckedAt
        : null;
    const notifiedPageIds = Array.isArray(parsed.notifiedPageIds)
      ? parsed.notifiedPageIds.filter((id) => typeof id === "string")
      : [];
    const lastRunAt =
      typeof parsed.lastRunAt === "string" || parsed.lastRunAt === null || parsed.lastRunAt === undefined
        ? parsed.lastRunAt ?? null
        : null;
    return { lastCheckedAt, notifiedPageIds, lastRunAt };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ...EMPTY_STATE };
    }
    console.warn(`[state] ${filePath} の読み込みに失敗したため、初回実行として扱います。`, error.message);
    return { ...EMPTY_STATE };
  }
}

/**
 * 状態ファイルを書き込む(ディレクトリが無ければ作成する)。
 * @param {string} filePath
 * @param {{ lastCheckedAt: string|null, notifiedPageIds?: string[], lastRunAt?: string|null }} state
 */
export async function saveState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true });
  const payload = {
    lastCheckedAt: state.lastCheckedAt ?? null,
    notifiedPageIds: Array.isArray(state.notifiedPageIds) ? state.notifiedPageIds : [],
    lastRunAt: state.lastRunAt ?? null,
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}
