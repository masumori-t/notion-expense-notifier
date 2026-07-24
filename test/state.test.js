import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../src/state.js";

test("loadState: ファイルが存在しない場合は lastCheckedAt: null を返す(初回実行扱い)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notion-expense-notifier-test-"));
  try {
    const state = await loadState(join(dir, "does-not-exist.json"));
    assert.deepEqual(state, { lastCheckedAt: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveState → loadState: 保存した内容をそのまま読み込める(往復)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notion-expense-notifier-test-"));
  try {
    const filePath = join(dir, "nested", "last-checked.json");
    await saveState(filePath, { lastCheckedAt: "2026-07-23T00:00:00.000Z" });
    const state = await loadState(filePath);
    assert.deepEqual(state, { lastCheckedAt: "2026-07-23T00:00:00.000Z" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadState: JSONとして壊れている場合は null にフォールバックする(クラッシュしない)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notion-expense-notifier-test-"));
  try {
    const filePath = join(dir, "broken.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "{not valid json", "utf-8");
    const state = await loadState(filePath);
    assert.deepEqual(state, { lastCheckedAt: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
