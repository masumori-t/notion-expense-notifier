// 「前回チェックした時刻」を保存/読込するモジュール。
// GitHub Actions のジョブはワーカーが毎回破棄される(実行間で状態を保持しない)ため、
// このファイル(JSON)をリポジトリにコミットして永続化する運用を想定している
// (ワークフロー側で `git commit && git push` する。.github/workflows/notify.yml 参照)。
//
// 保存する内容はタイムスタンプ1つだけなので、DBやクラウドストレージのような
// 追加インフラを用意せずに「前回チェック以降に新規データが追加されたか」を判定できる。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 状態ファイルを読み込む。
 * ファイルが存在しない(初回実行)場合やJSONとして壊れている場合は、
 * 安全側のデフォルト値 { lastCheckedAt: null } を返す(=現在の未清算データを全て「新規」扱いにする)。
 * @param {string} filePath
 * @returns {Promise<{ lastCheckedAt: string|null }>}
 */
export async function loadState(filePath) {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.lastCheckedAt === "string" || parsed.lastCheckedAt === null) {
      return { lastCheckedAt: parsed.lastCheckedAt };
    }
    console.warn(`[state] ${filePath} の内容が不正なため、初回実行として扱います。`);
    return { lastCheckedAt: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { lastCheckedAt: null };
    }
    console.warn(`[state] ${filePath} の読み込みに失敗したため、初回実行として扱います。`, error.message);
    return { lastCheckedAt: null };
  }
}

/**
 * 状態ファイルを書き込む(ディレクトリが無ければ作成する)。
 * @param {string} filePath
 * @param {{ lastCheckedAt: string }} state
 */
export async function saveState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
