import { randomUUID } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { Source, SourceEntry } from "./folo"
import { FoloReader } from "./folo"
import { processListLoaded } from "./processing-list-load"
import { runProcessingWorker } from "./processing-worker"
import { PublicArticleError } from "./public-article"
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
    session: vi.fn(async () => ({ ownerId: "owner", expiresAt: null })),
    sources: vi.fn(async () => [source]),
    page: vi.fn(async () => ({ entries: [], nextCursor: null, pageFull: false, boundaryCount: 0 })),
    detail: vi.fn(async (_source: Source, entry: SourceEntry) => entry),
    readability: vi.fn(async () => null),
    hydrateLinkedMaterials: vi.fn(async (entry: SourceEntry) => entry),
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
    sourceReader: reader,
    aiConfig: new AIConfigStore("/unused-folo-test-ai-config.json"),
    runtimeDir: "/unused",
    acquire,
    processEntries,
    aggregate,
  }
}

describe("调度到处理的后台链路", () => {
  it("未知读态不水合、不扩大空模型批，并报告等待上下文", async () => {
    const options = fixture()
    try {
      options.store.saveEntry({
        id: "unknown",
        sourceKey: "feed/1",
        title: "读态待同步",
        url: null,
        publishedAt: "2026-01-01T00:00:00Z",
        read: null,
        content: "真实正文",
        description: null,
      })
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())
      // 假引擎只记录范围，空批不能被解释为重新扫描全库。
      const processEntries = vi.fn(async () => ({
        completed: 0,
        pending: 0,
        failures: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      }))
      const result = await runProcessingWorker(
        { ...options, processEntries },
        new AbortController().signal,
      )
      expect(result?.status).toBe("needs_context")
      expect(options.sourceReader.detail).not.toHaveBeenCalled()
      expect(processEntries).toHaveBeenCalledWith(expect.objectContaining({ inputSeqs: [] }))
      expect(options.store.processingState.reports()[0]?.report).toMatchObject({
        entries: { completed: 0, pending: 1 },
      })
      expect(options.store.automation.inputs()[0]?.status).toBe("pending")
    } finally {
      options.store.close()
    }
  })

  it("紧迫条目先补读并发布第一小批，后续普通材料尚未水合也不阻塞它", async () => {
    const options = fixture()
    try {
      for (let index = 0; index < 10; index++)
        options.store.saveEntry({
          id: `e${index}`,
          sourceKey: "feed/1",
          title: index === 9 ? "今晚截止领取资格" : `普通文章${index}`,
          url: null,
          publishedAt: "2026-01-01T00:00:00Z",
          read: false,
          content: "真实正文",
          description: null,
        })
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())
      const snapshots: number[] = []
      const processEntries = vi.fn(
        async (input: Parameters<typeof import("./processing-engine").runEntryProcessing>[0]) => {
          snapshots.push(vi.mocked(options.sourceReader.detail).mock.calls.length)
          if (snapshots.length === 1)
            expect(vi.mocked(options.sourceReader.detail).mock.calls[0]?.[1].title).toBe(
              "今晚截止领取资格",
            )
          const seqs = input.inputSeqs ?? []
          expect(seqs.length).toBeLessThanOrEqual(8)
          return {
            completed: seqs.length,
            pending: 0,
            failures: [],
            usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
          }
        },
      )
      await runProcessingWorker({ ...options, processEntries }, new AbortController().signal)
      expect(snapshots).toEqual([8, 10])
      expect(processEntries).toHaveBeenCalledTimes(2)
      expect(options.store.processingState.reports()[0]?.report).toMatchObject({
        entries: { completed: 10, usage: { inputTokens: 20, outputTokens: 4 } },
      })
    } finally {
      options.store.close()
    }
  })
  it("持续安全公告下，每个水合批第2项保留最早普通材料并保持模型批范围", async () => {
    const options = fixture()
    try {
      for (let index = 0; index < 18; index++) {
        options.store.saveEntry({
          id: `fair-${index}`,
          sourceKey: "feed/1",
          title: index < 3 ? `普通研究${index}` : "协议遭攻击，请立即撤销授权",
          url: null,
          // 新文章不能凭发布时间反复把旧普通研究排到后面。
          publishedAt: index < 3 ? "2026-01-01T00:00:00Z" : "2026-02-01T00:00:00Z",
          read: false,
          content: "真实正文",
          description: null,
        })
      }
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())
      const batches: string[][] = []
      const processEntries = async (
        input: Parameters<typeof import("./processing-engine").runEntryProcessing>[0],
      ) => {
        const members = options.store.automation
          .inputs()
          .filter((entry) => input.inputSeqs?.includes(entry.seq))
        const hydrated = vi
          .mocked(options.sourceReader.detail)
          .mock.calls.slice(batches.flat().length)
          .map((call) => call[1].id)
        expect(new Set(hydrated)).toEqual(new Set(members.map((entry) => entry.itemId)))
        batches.push(hydrated)
        return {
          completed: members.length,
          pending: 0,
          failures: [],
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        }
      }
      await runProcessingWorker({ ...options, processEntries }, new AbortController().signal)
      expect(batches.map((batch) => batch.length)).toEqual([8, 8, 2])
      expect(batches.map((batch) => batch[1])).toEqual(["fair-0", "fair-1", "fair-2"])
      expect(batches[0]?.[0]).toBe("fair-3")
    } finally {
      options.store.close()
    }
  })

  it("手动排队的动态范围在首次领取才按新清单冻结，租约恢复保持该批次", async () => {
    const options = fixture()
    try {
      options.store.schedule.save(
        {
          scope: { mode: "all" },
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      const queued = options.store.schedule.manual(randomUUID(), new Date())
      expect(queued.sourceKeys).toEqual(["feed/1"])
      vi.mocked(options.sourceReader.sources).mockResolvedValue([
        { key: "feed/new", kind: "feed", id: "new", title: "新来源", view: 0, category: null },
      ])
      await runProcessingWorker(options, new AbortController().signal)
      expect(options.processEntries).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKeys: ["feed/new"] }),
      )
      expect(options.store.schedule.triggers()[0]?.sourceKeys).toEqual(["feed/new"])
      const now = new Date()
      options.store.schedule.manual(randomUUID(), now)
      const leased = options.store.schedule.claim(now, 1000)!
      expect(leased.sourceKeys).toEqual(["feed/new"])
      options.store.replaceSources([
        {
          key: "feed/later",
          kind: "feed",
          id: "later",
          title: "稍后订阅",
          view: 0,
          category: null,
        },
      ])
      expect(
        options.store.schedule.claim(new Date(now.getTime() + 1001), 1000)?.sourceKeys,
      ).toEqual(["feed/new"])
    } finally {
      options.store.close()
    }
  })
  it("真实采集复用刷新结果，刷新失败保留旧快照且不伪报成功", async () => {
    const options = fixture()
    try {
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())
      await runProcessingWorker({ ...options, acquire: undefined }, new AbortController().signal)
      expect(options.sourceReader.session).toHaveBeenCalledTimes(1)
      expect(options.sourceReader.sources).toHaveBeenCalledTimes(1)
      expect(options.sourceReader.page).toHaveBeenCalledTimes(1)
      vi.mocked(options.sourceReader.sources).mockRejectedValue(new Error("upstream"))
      options.store.schedule.manual(randomUUID(), new Date())
      expect(
        await runProcessingWorker({ ...options, acquire: undefined }, new AbortController().signal),
      ).toMatchObject({ status: "retry_wait" })
      expect(options.store.sources().map((source) => source.key)).toEqual(["feed/1"])
      expect(options.store.sourceSync.inventoryStatus()).toMatchObject({
        snapshot: "previous",
        failure: "sync_failed",
      })
      expect(options.store.processingState.reports().at(-1)?.report).toMatchObject({
        inventory: { snapshot: "previous", failure: "sync_failed" },
      })
    } finally {
      options.store.close()
    }
  })
  it("生成来源不能重新 capture 到原文队列", () => {
    const options = fixture()
    try {
      options.store.replaceSources([
        {
          key: "feed/generated",
          kind: "feed",
          id: "generated",
          title: "综述",
          view: 0,
          category: null,
          origin: "generated",
        },
      ])
      const entry: SourceEntry = {
        id: "story",
        sourceKey: "feed/generated",
        title: "综述",
        url: null,
        publishedAt: "2026-01-01T00:00:00Z",
        read: false,
        content: "派生正文",
        description: null,
      }
      expect(() => options.store.saveEntry(entry)).toThrow("generated_source_capture_forbidden")
      expect(() => options.store.saveEntry({ ...entry, sourceKey: "generated:events" })).toThrow(
        "generated_source_capture_forbidden",
      )
      expect(options.store.automation.inputs()).toEqual([])
    } finally {
      options.store.close()
    }
  })
  it("规则旧快照零匹配时先发现新订阅，再冻结批次，且本轮只刷新一次", async () => {
    const options = fixture()
    try {
      const draft = options.store.automation.draft()
      options.store.automation.saveDraft(
        {
          ...draft.config,
          rules: [
            {
              id: randomUUID(),
              ownerId: "owner",
              name: "新来源",
              enabled: true,
              order: 0,
              version: 1,
              executionLocation: "processing_service",
              when: {
                anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["feed/new"] }] }],
              },
              actions: [{ type: "ai_transform", prompt: "处理内容" }],
            },
          ],
        },
        draft.revision,
      )
      options.store.automation.publish(1, { mode: "future" }, randomUUID())
      options.store.schedule.save(
        {
          scope: { mode: "rules" },
          sourceKeys: [],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: true,
          times: ["00:00"],
        },
        0,
      )
      expect(options.store.schedule.snapshot().config?.sourceKeys).toEqual([])
      vi.mocked(options.sourceReader.sources).mockResolvedValue([
        { key: "feed/new", kind: "feed", id: "new", title: "新订阅", view: 0, category: null },
      ])
      await runProcessingWorker(options, new AbortController().signal)
      expect(options.processEntries).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKeys: ["feed/new"] }),
      )
      expect(options.sourceReader.sources).toHaveBeenCalledTimes(1)
      expect(options.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ inventory: expect.objectContaining({ snapshot: "fresh" }) }),
        expect.any(AbortSignal),
      )
    } finally {
      options.store.close()
    }
  })
  it("旧 all/category 后台动态展开而 fixed 不扩大", () => {
    const options = fixture()
    try {
      const save = (scope: import("@follow/information-core").ScheduleScope) => {
        const snapshot = options.store.schedule.snapshot()
        options.store.schedule.save(
          {
            scope,
            sourceKeys: ["feed/1"],
            historySince: "2026-01-01T00:00:00Z",
            timeZone: "UTC",
            enabled: false,
          },
          snapshot.revision,
        )
      }
      options.store.replaceSources([
        { key: "feed/new", kind: "feed", id: "new", title: "新增", view: 1, category: "X" },
      ])
      save({ mode: "all" })
      expect(options.store.schedule.snapshot().config?.sourceKeys).toEqual(["feed/new"])
      save({ mode: "category", view: 1, category: "X" })
      expect(options.store.schedule.snapshot().config?.sourceKeys).toEqual(["feed/new"])
      save({ mode: "fixed", sourceKeys: ["feed/1"] })
      expect(options.store.schedule.snapshot().config?.sourceKeys).toEqual(["feed/1"])
    } finally {
      options.store.close()
    }
  })
  it("已有文本但图片未读取保持待补，并允许下一轮有限重试", async () => {
    const options = fixture()
    try {
      options.store.saveEntry({
        id: "image",
        sourceKey: "feed/1",
        title: "图表",
        url: "https://x.com/example/status/1",
        publishedAt: "2026-01-01T00:00:00Z",
        read: false,
        content: '<p>图表解释</p><img src="https://example/image">',
        description: null,
      })
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())
      expect(await runProcessingWorker(options, new AbortController().signal)).toMatchObject({
        status: "needs_context",
      })
      expect(options.store.processingState.material(options.store.automation.inputs()[0]!)).toBe(
        "missing",
      )
      options.store.schedule.manual(randomUUID(), new Date())
      await runProcessingWorker(options, new AbortController().signal)
      expect(options.sourceReader.detail).toHaveBeenCalledTimes(2)
    } finally {
      options.store.close()
    }
  })

  it("明确教程外链失败保持needs_context，下一轮补齐生成新材料版本并交给处理", async () => {
    const options = fixture()
    const publicArticle = vi.fn(async (url: string) => ({
      url,
      title: "教程",
      text: "先备份，再执行迁移，最后核对数据。",
    }))
    publicArticle.mockRejectedValueOnce(new PublicArticleError("network"))
    const hydrator = new FoloReader({
      apiUrl: "https://api.example.test",
      token: "mock",
      publicArticle,
    })
    vi.mocked(options.sourceReader.hydrateLinkedMaterials).mockImplementation((entry, signal) =>
      hydrator.hydrateLinkedMaterials(entry, signal),
    )
    try {
      options.store.saveEntry({
        id: "tutorial",
        sourceKey: "feed/1",
        title: "指南",
        url: "https://x.com/example/status/1",
        publishedAt: "2026-01-01T00:00:00Z",
        read: false,
        content: '<p>完整教程详见原文：<a href="https://learn.example.com/guide">指南</a></p>',
        description: null,
      })
      options.store.saveEntry({ ...options.store.entry("feed/1", "tutorial")!, id: "same-link" })
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "UTC",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(0, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())
      expect(await runProcessingWorker(options, new AbortController().signal)).toMatchObject({
        status: "needs_context",
      })
      const failed = options.store.automation.current("feed/1", "tutorial")!
      expect(failed.body.linkedMaterials?.[0]).toMatchObject({
        status: "failed",
        failure: "network",
      })
      expect(options.store.processingState.material(failed)).toBe("missing")
      expect(publicArticle).toHaveBeenCalledOnce()
      const later = Date.now() + 60_001
      const clock = vi.spyOn(Date, "now").mockReturnValue(later)
      options.store.schedule.manual(randomUUID(), new Date())
      expect(
        await runProcessingWorker(options, new AbortController().signal).finally(() =>
          clock.mockRestore(),
        ),
      ).toMatchObject({
        status: "succeeded",
      })
      const completed = options.store.automation.current("feed/1", "tutorial")!
      expect(completed.contentVersion).not.toBe(failed.contentVersion)
      expect(completed.body.context?.links).toBe("complete")
      expect(completed.body.content).toContain("先备份，再执行迁移")
      expect(options.store.processingState.material(completed)).toBe("complete")
      expect(publicArticle).toHaveBeenCalledTimes(2)
      expect(options.processEntries).toHaveBeenLastCalledWith(
        expect.objectContaining({ inputSeqs: expect.arrayContaining([completed.seq]) }),
      )
    } finally {
      options.store.close()
    }
  })

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
        read: false,
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
  it("已读条目在抓详情之前就退出队列，不消耗正文抓取与模型额度", async () => {
    const options = fixture()
    try {
      const since = "2026-01-01T00:00:00Z"
      options.store.saveEntry({
        sourceKey: "feed/1",
        id: "e",
        title: "已读原文",
        url: null,
        read: true,
        content: '<p>完整教程详见原文：<a href="https://learn.example.com/guide">指南</a></p>',
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
      const [input] = options.store.automation.inputs()
      expect(input!.status).toBe("skipped")
      expect(options.store.processingState.material(input!)).toBeNull()
      expect(options.sourceReader.detail).not.toHaveBeenCalled()
      expect(options.sourceReader.hydrateLinkedMaterials).not.toHaveBeenCalled()
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
  it("把已发布规则引用的 List 作为成员同步范围，而不加入条目来源", async () => {
    const options = fixture()
    try {
      const draft = options.store.automation.draft()
      options.store.automation.saveDraft(
        {
          ...draft.config,
          rules: [
            {
              id: randomUUID(),
              ownerId: "owner",
              name: "List 条件",
              enabled: true,
              order: 0,
              version: 1,
              executionLocation: "processing_service",
              when: {
                anyOf: [
                  {
                    allOf: [{ field: "list_id", operator: "contains_any", value: ["watch-list"] }],
                  },
                ],
              },
              actions: [{ type: "ai_transform", prompt: "处理内容" }],
            },
          ],
        },
        draft.revision,
      )
      options.store.schedule.save(
        {
          sourceKeys: ["feed/1"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "Asia/Shanghai",
          enabled: false,
        },
        0,
      )
      options.store.automation.publish(1, { mode: "future" }, randomUUID())
      options.store.schedule.manual(randomUUID(), new Date())

      await runProcessingWorker(options, new AbortController().signal)

      expect(options.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceKeys: ["feed/1"],
          membershipListKeys: ["list/watch-list"],
        }),
        expect.any(AbortSignal),
      )
    } finally {
      options.store.close()
    }
  })
})

// 列表链路复用真实捕获/水合，只注入假处理器，保证测试没有模型费用。
describe("列表加载后台目标范围", () => {
  const now = new Date("2026-10-04T10:00:00Z")
  function setup() {
    const options = fixture()
    const draft = options.store.automation.draft()
    options.store.automation.saveDraft(
      {
        ...draft.config,
        rules: [
          {
            id: "list-ai",
            name: "列表 AI",
            ownerId: "owner",
            enabled: true,
            order: 0,
            version: 1,
            executionLocation: "processing_service",
            when: { all: true },
            actions: [{ type: "ai_transform", prompt: "提炼事实" }],
          },
        ],
      },
      draft.revision,
    )
    options.store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
    options.store.schedule.save(
      {
        scope: { mode: "rules" },
        sourceKeys: ["feed/1"],
        enabled: true,
        historySince: "2026-10-04T00:00:00Z",
        timeZone: "UTC",
        times: ["23:59"],
      },
      0,
    )
    const entry = {
      id: "listed",
      sourceKey: "feed/1",
      title: "本页文章",
      publishedAt: "2026-10-04T09:00:00Z",
      url: null,
      read: false,
      description: null,
    }
    processListLoaded(options.store, { entries: [entry] }, now)
    return { options, entry }
  }
  it("范围内历史失败不能伪报成功，退避后只续跑本页授权未读目标", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const { options, entry } = setup()
    try {
      options.store.saveEntry({ ...entry, content: "已保存完整正文" })
      const prepareFailure = (id: string, read: boolean, publishedAt = entry.publishedAt) => {
        options.store.saveEntry({ ...entry, id, read, publishedAt, content: "已保存完整正文" })
        const current = options.store.automation.current(entry.sourceKey, id)!
        const target = options.store.processingState.prepare(current.seq, {
          context: {
            source_id: entry.sourceKey,
            contextId: entry.sourceKey,
            entry_title: entry.title,
          },
          provider: "codex",
          model: "frozen-model",
          sourceRole: "媒体",
          metadataVersion: 1,
        })
        options.store.processingState.setMaterial(target.input, "complete")
        options.store.processingState.fail(target.input, "codex_process_failed", now)
        return target.input.seq
      }
      const selected = prepareFailure(entry.id, false)
      const unloaded = prepareFailure("unloaded-failure", false)
      const read = prepareFailure("read-failure", true)
      const outside = prepareFailure("outside-window", false, "2026-10-03T09:00:00Z")
      const processEntries = vi.fn(async () => ({
        completed: 0,
        pending: 0,
        failures: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      }))
      const result = await runProcessingWorker(
        { ...options, processEntries },
        new AbortController().signal,
      )
      expect(result?.status).toBe("retry_wait")
      expect(processEntries).toHaveBeenCalledWith(expect.objectContaining({ inputSeqs: [] }))
      expect(options.store.processingState.reports().at(-1)?.report).toMatchObject({
        entries: { completed: 0, failures: [{ inputSeq: selected, code: "codex_process_failed" }] },
      })
      vi.setSystemTime(new Date(now.getTime() + 300_000))
      processListLoaded(options.store, { entries: [entry] }, new Date())
      processEntries.mockClear()
      await runProcessingWorker({ ...options, processEntries }, new AbortController().signal)
      expect(processEntries).toHaveBeenCalledWith(
        expect.objectContaining({ inputSeqs: [selected] }),
      )
      expect(
        options.store.automation.inputs().find((input) => input.seq === selected)?.status,
      ).toBe("pending")
      for (const seq of [unloaded, read, outside])
        expect(options.store.automation.inputs().find((input) => input.seq === seq)?.status).toBe(
          "failed",
        )
      expect(options.sourceReader.detail).not.toHaveBeenCalled()
    } finally {
      options.store.close()
      vi.useRealTimers()
    }
  })

  it("当前规则不再命中时，不自动复活旧发布版本的失败", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const { options, entry } = setup()
    try {
      options.store.saveEntry({ ...entry, content: "已保存完整正文" })
      const target = options.store.processingState.prepare(
        options.store.automation.current(entry.sourceKey, entry.id)!.seq,
        {
          context: {
            source_id: entry.sourceKey,
            contextId: entry.sourceKey,
            entry_title: entry.title,
          },
          provider: "codex",
          model: "frozen-model",
          sourceRole: "媒体",
          metadataVersion: 1,
        },
      )
      options.store.processingState.setMaterial(target.input, "complete")
      options.store.processingState.fail(
        target.input,
        "codex_process_failed",
        new Date(now.getTime() - 300_000),
      )
      // 发布收窄后的规则，旧目标仍保留原发布版本，但不再获得当前授权。
      const draft = options.store.automation.draft()
      options.store.automation.saveDraft(
        {
          ...draft.config,
          rules: draft.config.rules.map((rule) => ({
            ...rule,
            when: {
              anyOf: [{ allOf: [{ field: "entry_title", operator: "eq", value: "另一个标题" }] }],
            },
          })),
        },
        draft.revision,
      )
      options.store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
      const processEntries = vi.fn(async () => ({
        completed: 0,
        pending: 0,
        failures: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      }))
      await runProcessingWorker({ ...options, processEntries }, new AbortController().signal)
      expect(processEntries).toHaveBeenCalledWith(expect.objectContaining({ inputSeqs: [] }))
      expect(options.store.automation.current(entry.sourceKey, entry.id)).toMatchObject({
        status: "failed",
        generation: target.input.generation,
        releaseVersion: target.input.releaseVersion,
      })
    } finally {
      options.store.close()
      vi.useRealTimers()
    }
  })

  it("不采集全来源历史，稳定目标身份穿过正文水合换代，未加载同源材料不处理", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const { options, entry } = setup()
    try {
      options.store.saveEntry({ ...entry, id: "unloaded", content: "不在列表的历史材料" })
      const before = options.store.automation.current(entry.sourceKey, entry.id)!.seq
      vi.mocked(options.sourceReader.detail).mockImplementation(async (_source, listed) => ({
        ...listed,
        content: "正文经补读后换代",
      }))
      const dedupe = vi.fn(async () => ({
        batches: 0,
        candidates: 0,
        duplicates: 0,
        exactDuplicates: 0,
        unresolved: 0,
        sharedComparisons: 0,
        relationCacheHits: 0,
        dedicatedComparisons: 0,
        unknownUsageRequests: 0,
        pending: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      }))
      const repair = vi.fn(async () => ({
        repaired: [],
        independent: [],
        pending: [],
        failures: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      }))
      await runProcessingWorker({ ...options, dedupe, repair }, new AbortController().signal)
      expect(options.acquire).not.toHaveBeenCalled()
      expect(options.sourceReader.detail).toHaveBeenCalledTimes(1)
      const after = options.store.automation.current(entry.sourceKey, entry.id)!.seq
      expect(after).not.toBe(before)
      expect(options.processEntries).toHaveBeenCalledWith(
        expect.objectContaining({ inputSeqs: [after], sourceKeys: ["feed/1"] }),
      )
      expect(dedupe).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [{ sourceKey: "feed/1", itemId: entry.id }],
          sourceKeys: ["feed/1"],
          cutoffAt: now.toISOString(),
          preparedEvaluations: [],
        }),
      )
      // 单篇结果先落定，再执行去重与事件综合；原规则 order 不再代替执行依赖。
      expect(options.processEntries.mock.invocationCallOrder[0]).toBeLessThan(
        dedupe.mock.invocationCallOrder[0]!,
      )
      expect(dedupe.mock.invocationCallOrder[0]).toBeLessThan(repair.mock.invocationCallOrder[0]!)
      expect(options.store.automation.current(entry.sourceKey, "unloaded")?.status).toBe("pending")
      // 记住水合后版本，同一加载不能被水合换代误认为新内容。
      expect(processListLoaded(options.store, { entries: [entry] }, now).trigger).toBeNull()
    } finally {
      options.store.close()
      vi.useRealTimers()
    }
  })
  it("排队后总暂停会取消目标，不抓详情也不执行处理", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const { options } = setup()
    try {
      options.store.schedule.save(
        { ...options.store.schedule.snapshot().config!, enabled: false },
        1,
      )
      expect(await runProcessingWorker(options, new AbortController().signal)).toMatchObject({
        status: "cancelled",
      })
      expect(options.acquire).not.toHaveBeenCalled()
      expect(options.sourceReader.detail).not.toHaveBeenCalled()
      expect(options.processEntries).not.toHaveBeenCalled()
    } finally {
      options.store.close()
      vi.useRealTimers()
    }
  })
})
