import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import { join } from "pathe"
import { describe, expect, it } from "vitest"

import { Store } from "./store"

function fixture(path = ":memory:") {
  const store = new Store(path)
  store.bindOwner("owner")
  store.saveEntry({
    sourceKey: "feed/1",
    id: "1",
    title: "原文",
    url: null,
    publishedAt: "2026-09-12T00:00:00Z",
    read: true,
    content: "完整原文",
    description: null,
  })
  store.automation.publish(0, { mode: "future" }, randomUUID())
  return store
}

describe("后台目标与用户纠偏", () => {
  it("暂时性失败退避五分钟，重启保留两次上限，显式重试重置额度", () => {
    const directory = mkdtempSync(join(tmpdir(), "folo-retry-test-"))
    const path = join(directory, "test.sqlite")
    let store = fixture(path)
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 4, 10, minutes))
    try {
      const first = store.processingState.prepare(store.automation.inputs()[0]!.seq, {
        context: { source_id: "feed/1", contextId: "feed/1", entry_title: "原文" },
        provider: "codex",
        model: "frozen-model",
        sourceRole: "媒体",
        metadataVersion: 1,
      })
      const current = () => store.automation.inputs()[0]!
      store.processingState.fail(first.input, "codex_process_failed", at(0))
      expect(store.processingState.retryAutomatically(current(), at(4))).toBe(false)
      expect(store.processingState.retryAutomatically(current(), at(5))).toBe(true)
      // 真正重开测试数据库，验证次数不是只存在进程内。
      store.close()
      store = new Store(path)
      store.processingState.fail(current(), "codex_timeout", at(5))
      expect(store.processingState.retryAutomatically(current(), at(9))).toBe(false)
      expect(store.processingState.retryAutomatically(current(), at(10))).toBe(true)
      store.processingState.fail(current(), "codex_process_failed", at(10))
      expect(store.processingState.retryAutomatically(current(), at(20))).toBe(false)
      expect(store.processingState.retry(current().seq)).toBe(true)
      store.processingState.fail(current(), "codex_process_failed", at(20))
      expect(store.processingState.retryAutomatically(current(), at(25))).toBe(true)
      expect(current()).toMatchObject({
        generation: first.input.generation,
        releaseVersion: first.input.releaseVersion,
      })
      expect(
        store.processingState.prepare(current().seq, { ...first.snapshot, model: "changed-model" })
          .snapshot,
      ).toEqual(first.snapshot)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("旧失败从首次观察起退避，配置和未知中断不自动付费重试", () => {
    const directory = mkdtempSync(join(tmpdir(), "folo-legacy-retry-"))
    const path = join(directory, "test.sqlite")
    let store = fixture(path)
    const at = new Date("2026-10-04T10:00:00Z")
    try {
      const first = store.processingState.prepare(store.automation.inputs()[0]!.seq, {
        context: { source_id: "feed/1", contextId: "feed/1", entry_title: "原文" },
        provider: "codex",
        model: "frozen-model",
        sourceRole: "媒体",
        metadataVersion: 1,
      })
      store.processingState.fail(first.input, "codex_process_failed", at)
      store.close()
      // 只在临时测试库模拟升级前缺少重试记录的失败目标。
      const db = new DatabaseSync(path)
      db.exec("DELETE FROM processing_input_retries")
      db.close()
      store = new Store(path)
      const current = () => store.automation.inputs()[0]!
      expect(store.processingState.retryAutomatically(current(), at)).toBe(false)
      expect(
        store.processingState.retryAutomatically(current(), new Date(at.getTime() + 300_000)),
      ).toBe(true)
      for (const code of ["codex_invalid_options", "codex_invalid_schema", "codex_authorization"]) {
        store.processingState.fail(current(), code, at)
        expect(
          store.processingState.retryAutomatically(current(), new Date(at.getTime() + 600_000)),
        ).toBe(false)
      }
      store.processingState.retry(current().seq)
      store.processingState.start(current())
      store.processingState.recover()
      expect(
        store.processingState.retryAutomatically(current(), new Date(at.getTime() + 600_000)),
      ).toBe(false)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("旧失败已有实际失败报告时复用退避时间，连接与限流允许有限续跑", () => {
    const directory = mkdtempSync(join(tmpdir(), "folo-reported-retry-"))
    const path = join(directory, "test.sqlite")
    let store = fixture(path)
    const at = new Date(Date.now() + 1000)
    try {
      const input = store.automation.assign(store.automation.inputs()[0]!.seq)
      store.processingState.prepare(input.seq, {
        context: { source_id: "feed/1", contextId: "feed/1" },
        provider: "codex",
        model: "frozen-model",
        sourceRole: "媒体",
        metadataVersion: 1,
      })
      store.processingState.fail(input, "codex_process_failed", at)
      store.processingState.report("old-failure", {
        entries: { failures: [{ inputSeq: input.seq, code: "codex_process_failed" }] },
        finishedAt: at.toISOString(),
      })
      store.close()
      const db = new DatabaseSync(path)
      db.exec("DELETE FROM processing_input_retries")
      db.close()
      store = new Store(path)
      const current = () => store.automation.inputs()[0]!
      expect(
        store.processingState.retryAutomatically(current(), new Date(at.getTime() + 300_000)),
      ).toBe(true)
      for (const code of ["codex_connection", "codex_rate_limit"]) {
        store.processingState.fail(current(), code, at)
        store.processingState.retry(current().seq)
        store.processingState.fail(current(), code, at)
        expect(
          store.processingState.retryAutomatically(current(), new Date(at.getTime() + 300_000)),
        ).toBe(true)
      }
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("同一 generation 保留模型和上下文，新发布不会接受旧任务结果", () => {
    const store = fixture()
    try {
      const seq = store.automation.inputs()[0]!.seq
      const first = store.processingState.prepare(seq, {
        context: { source_id: "feed/1", contextId: "feed/1", entry_title: "原文" },
        provider: "qianwen",
        model: "qwen3.8-flash",
        sourceRole: "研究者",
        metadataVersion: 1,
      })
      const retry = store.processingState.prepare(seq, {
        context: { source_id: "feed/1", contextId: "feed/1", entry_title: "已变更" },
        provider: "codex",
        model: "other",
        sourceRole: "媒体",
        metadataVersion: 2,
      })
      expect(retry.snapshot).toEqual(first.snapshot)
      expect(store.processingState.start(first.input)).toBe(true)
      expect(store.processingState.start(first.input)).toBe(false)
      store.automation.publish(0, { mode: "selected", inputIds: [seq] }, randomUUID())
      expect(store.automation.complete(first.input, { schemaVersion: 1 })).toMatchObject({
        published: false,
      })
      expect(store.automation.inputs()[0]!.status).toBe("pending")
    } finally {
      store.close()
    }
  })

  it("正文新版本仍保留用户恢复，过期 revision 无法覆盖，撤销回到前一模式", () => {
    const store = fixture()
    try {
      const input = store.automation.inputs()[0]!
      store.processingState.setOverride(input.seq, "restore", 0)
      store.saveEntry({ ...input.body, content: "更新后的原文" })
      const next = store.automation.inputs()[0]!
      expect(next.seq).not.toBe(input.seq)
      expect(store.processingState.overrides()).toContainEqual({
        inputSeq: next.seq,
        mode: "restore",
        revision: 1,
      })
      expect(() => store.processingState.setOverride(next.seq, "hide", 0)).toThrow(
        "revision_conflict",
      )
      store.processingState.setOverride(next.seq, "hide", 1)
      expect(store.processingState.undoOverride(next.seq, 2)).toMatchObject({
        mode: "restore",
        revision: 3,
      })
    } finally {
      store.close()
    }
  })

  it("崩溃中断不自动重付费，只有显式重试恢复 pending", () => {
    const store = fixture()
    try {
      const input = store.automation.assign(store.automation.inputs()[0]!.seq)
      store.processingState.start(input)
      store.processingState.recover()
      expect(store.automation.inputs()[0]!.status).toBe("failed")
      expect(store.processingState.start(input)).toBe(false)
      expect(store.processingState.retry(input.seq)).toBe(true)
      expect(store.processingState.start(input)).toBe(true)
    } finally {
      store.close()
    }
  })
})
