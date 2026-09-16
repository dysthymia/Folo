import { randomUUID } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { FoloReader, Source, SourceEntry } from "./folo"
import { runProcessingWorker } from "./processing-worker"
import { Store } from "./store"

function fixture() {
  const store = new Store(":memory:")
  store.bindOwner("owner")
  const source = {
    key: "feed/1",
    kind: "feed" as const,
    id: "1",
    title: "真实来源",
    view: 0,
    category: null,
  }
  store.replaceSources([source])
  store.sourceSync.replaceSources([source], new Date().toISOString())
  const reader = {
    detail: vi.fn(async (_source: Source, entry: SourceEntry) => entry),
    readability: vi.fn(async () => null),
  } as unknown as FoloReader
  const acquire = vi.fn(async () => [
    { sourceKey: source.key, pages: 1, entries: 1, coverage: "end" as const, failure: null },
  ])
  const processEntries = vi.fn(async () => ({
    completed: 1,
    pending: 0,
    failures: [],
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  }))
  const aggregate = vi.fn(async () => ({
    created: [],
    updated: [],
    pending: [],
    failures: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    cacheHits: 0,
  }))
  return {
    store,
    reader: async () => reader,
    aiConfig: new AIConfigStore("/unused-folo-test-ai-config.json"),
    runtimeDir: "/unused",
    acquire,
    processEntries,
    aggregate,
  }
}

describe("调度到处理的后台链路", () => {
  it("未配置来源和发布规则时不会读取材料或调用模型", async () => {
    const options = fixture()
    try {
      expect(await runProcessingWorker(options, new AbortController().signal)).toBeNull()
      expect(options.acquire).not.toHaveBeenCalled()
      expect(options.processEntries).not.toHaveBeenCalled()
    } finally {
      options.store.close()
    }
  })
  it("手动触发独立于自动启停，按截止范围补齐正文并保存运行报告", async () => {
    const options = fixture()
    try {
      const since = "2026-01-01T00:00:00Z"
      options.store.saveEntry({
        sourceKey: "feed/1",
        id: "e",
        title: "原文",
        url: null,
        read: true,
        content: "完整正文",
        description: null,
        publishedAt: since,
      })
      options.store.schedule.save(
        { sourceKeys: ["feed/1"], historySince: since, timeZone: "Asia/Shanghai", enabled: false },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      const queued = options.store.schedule.manual(randomUUID(), new Date())
      expect(await runProcessingWorker(options, new AbortController().signal)).toEqual({
        id: queued.id,
        status: "succeeded",
      })
      expect(options.processEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceKeys: ["feed/1"],
          historySince: new Date(since).toISOString(),
          cutoffAt: queued.cutoffAt,
        }),
      )
      expect(options.store.processingState.material(options.store.automation.inputs()[0]!)).toBe(
        "complete",
      )
      expect(options.store.processingState.reports()).toHaveLength(1)
      expect(await runProcessingWorker(options, new AbortController().signal)).toBeNull()
    } finally {
      options.store.close()
    }
  })
  it("分页预算不足记录为待补，不能报告全部完成", async () => {
    const options = fixture()
    try {
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "Asia/Shanghai",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())
      const acquire = vi.fn(async () => [
        {
          sourceKey: "feed/1",
          pages: 20,
          entries: 2000,
          coverage: "budget" as const,
          failure: null,
        },
      ])
      expect(
        await runProcessingWorker({ ...options, acquire }, new AbortController().signal),
      ).toMatchObject({ status: "deferred_budget" })
    } finally {
      options.store.close()
    }
  })
})
