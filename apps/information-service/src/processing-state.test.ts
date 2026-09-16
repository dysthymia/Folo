import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { Store } from "./store"

function fixture() {
  const store = new Store(":memory:")
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
