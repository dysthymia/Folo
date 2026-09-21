import { afterEach, describe, expect, it, vi } from "vitest"

import { oneTimeToken } from "~/lib/auth"

import {
  loadReadingSnapshot,
  loadReadingSnapshotPage,
  mutationSchemas,
  readingEntriesSchema,
  readingEntryPresentation,
  readingPendingMessageKey,
  readingRequest,
  readingSnapshotPageSchema,
  readingSnapshotResponseSchema,
  readingStorySchema,
  researchPackSchema,
} from "./processing-reader-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const snapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  cutoffAt: "2026-09-12T00:00:00.000Z",
  maxSeq: 3,
  createdAt: "2026-09-12T00:00:00.000Z",
  latestAvailable: true,
}
const audit = {
  cutoffAt: snapshot.cutoffAt,
  maxSeq: snapshot.maxSeq,
  appliedRelease: 2,
  currentDecisionId: null,
  storyRevision: null,
}
const correction = {
  id: "correction-1",
  kind: "merged" as const,
  storyIds: ["story-1", "story-2"],
  baseRevisions: { "story-1": 1, "story-2": 2 },
  payload: { keptRevision: 3 },
  undoOf: null,
  undoneBy: null,
  createdAt: snapshot.createdAt,
}
const revision = {
  storyId: "story-1",
  revision: 3,
  title: "合并结果",
  body: "正文",
  aggregationRuleId: "rule-1",
  aggregationScopeVersion: "scope-1",
  appliedRuleSetVersion: 2,
  instructionFingerprint: "fingerprint",
  substantiveRevision: 3,
  substantiveContentFingerprint: "substantive",
  displayFingerprint: "display",
  createdAt: snapshot.createdAt,
  members: [{ inputSeq: 1, decisionId: "decision-1" }],
  sourceSpans: [],
  citations: [],
  sentences: [],
  facts: [],
}

describe("稳定阅读快照 client", () => {
  it.each(["smart", "pending", "failed"])("接受阅读视图 %s", (view) => {
    expect(
      readingSnapshotPageSchema.parse({
        snapshot,
        view,
        offset: 0,
        limit: 50,
        total: 0,
        items: [],
      }).view,
    ).toBe(view)
  })

  it("解析快照汇总、当前来源状态和分离的固定计划与轮询状态", () => {
    expect(
      readingSnapshotResponseSchema.parse({
        snapshot,
        counts: { standalone: 3, stories: 1, hidden: 2, pending: 1, failed: 1 },
        processing: {
          runStatus: "running",
          sourceTotal: 4,
          incompleteSources: 1,
          sourceStatusAt: "2026-09-12T00:01:00.000Z",
        },
        schedule: {
          revision: 2,
          enabled: true,
          timeZone: "Asia/Shanghai",
          nextScheduledStartLocal: "2026-09-12T07:30",
          nextScheduledReadyLocal: "2026-09-12T08:00",
          readyByLeadMinutes: 30,
          pollIntervalMinutes: 15,
          nextPollAt: "2026-09-12T00:15:00.000Z",
        },
      }),
    ).toMatchObject({
      counts: { standalone: 3, failed: 1 },
      processing: { incompleteSources: 1 },
      schedule: {
        nextScheduledStartLocal: "2026-09-12T07:30",
        pollIntervalMinutes: 15,
      },
    })
  })

  it("引用待核对时展示原文标题并收起 AI 摘要，且忽略旧 decision 反馈", () => {
    const item = {
      title: "原文标题",
      decision: { id: "decision-new", title: "AI 标题", summary: "AI 摘要" },
    }
    expect(
      readingEntryPresentation(item, {
        decision: { id: "decision-new" },
        reviewNeeded: true,
        issueCount: 2,
      }),
    ).toEqual({
      title: "原文标题",
      summary: null,
      summaryKey: "processing.reader.review_needed",
      aiSummary: "AI 摘要",
      issueCount: 2,
    })
    expect(
      readingEntryPresentation(item, {
        decision: { id: "decision-old" },
        reviewNeeded: true,
        issueCount: 1,
      }),
    ).toMatchObject({ title: "AI 标题", summary: "AI 摘要", issueCount: 0 })
  })

  it.each([
    ["failed", "processing.reader.pending_failed"],
    ["running", "processing.reader.pending_running"],
    ["pending", "processing.reader.pending"],
    ["material_missing", "processing.reader.pending"],
  ])("主列表将输入状态 %s 映射为 %s", (status, expected) => {
    expect(readingPendingMessageKey(status)).toBe(expected)
  })

  it("无请求体的 v1 读取改为带读取标记的 POST", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ snapshot })),
    )
    vi.stubGlobal("fetch", fetcher)

    await loadReadingSnapshot(new AbortController().signal)

    const init = fetcher.mock.calls[0]?.[1]
    expect(init).toEqual(expect.objectContaining({ method: "POST" }))
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get("X-Folo-Read")).toBe("1")
  })

  it("保留快照中的晚到 pending 占位，不用实时结果替换", () => {
    const page = {
      snapshot,
      view: "all" as const,
      offset: 0,
      limit: 50,
      total: 2,
      items: [
        {
          kind: "entry" as const,
          state: "pending" as const,
          ordinal: 0,
          inputSeq: 1,
          sourceKey: "feed:1",
          itemId: "entry-1",
          title: "等待处理",
          url: null,
          read: false,
          receivedAt: "2026-09-11T00:00:00.000Z",
          status: "pending",
          decision: null,
          audit,
        },
        {
          kind: "entry" as const,
          state: "repairing" as const,
          ordinal: 1,
          inputSeq: 2,
          storyId: null,
          audit,
        },
      ],
    }

    const parsed = readingSnapshotPageSchema.safeParse(page)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.items[0]).toMatchObject({ state: "pending", decision: null })
      expect(parsed.data.items[1]).toMatchObject({ state: "repairing" })
    }
  })

  it("严格保留后端分页 total、offset 和稳定 snapshot id", () => {
    const page = {
      snapshot,
      view: "stories" as const,
      offset: 50,
      limit: 50,
      total: 101,
      items: [],
    }

    expect(readingSnapshotPageSchema.parse(page)).toMatchObject({
      snapshot: { id: snapshot.id },
      view: "stories",
      offset: 50,
      limit: 50,
      total: 101,
    })
  })

  it("拒绝未知 snapshot 响应字段或错误结构", () => {
    expect(
      readingSnapshotResponseSchema.safeParse({
        snapshot: { ...snapshot, unexpected: true },
      }).success,
    ).toBe(false)
    expect(
      readingSnapshotPageSchema.safeParse({
        snapshot,
        view: "all",
        offset: 0,
        limit: 50,
        total: 1,
        items: [{ kind: "entry", state: "ready" }],
      }).success,
    ).toBe(false)
  })

  it("分页请求固定 snapshot、view、offset 和 50 条上限", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST")
      return new Response(
        JSON.stringify({ snapshot, view: "all", offset: 50, limit: 50, total: 51, items: [] }),
      )
    })
    vi.stubGlobal("fetch", fetcher)

    await loadReadingSnapshotPage(snapshot.id, "all", 50, new AbortController().signal)

    expect(fetcher).toHaveBeenCalledWith(
      "/information/v1/reading-snapshot",
      expect.objectContaining({
        body: JSON.stringify({ snapshotId: snapshot.id, view: "all", offset: 50, limit: 50 }),
      }),
    )
  })

  it("未知响应通过 readingRequest 时报告 request 错误", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unexpected: true }))),
    )

    await expect(
      readingRequest(
        "reading-snapshot",
        readingSnapshotResponseSchema,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "request" })
  })

  it("严格校验合并、拆分和原文撤回的真实返回结构", () => {
    expect(mutationSchemas.merge.safeParse({ correction, revision }).success).toBe(true)
    expect(
      mutationSchemas.split.safeParse({
        correction: { ...correction, kind: "split", storyIds: ["story-1"] },
        childIds: ["11111111-1111-4111-8111-111111111112"],
        independentInputSeqs: [3],
      }).success,
    ).toBe(true)
    expect(
      mutationSchemas.withdraw.safeParse({ ...correction, kind: "material_withdrawn" }).success,
    ).toBe(true)
  })

  it("完整保留处理条目列表的正式字段并拒绝正文扩展", () => {
    const response = {
      entries: [
        {
          seq: 1,
          sourceKey: "feed/1",
          itemId: "entry-1",
          title: "Entry title",
          url: "https://example.com/entry-1",
          read: false,
          receivedAt: "2026-09-12T00:00:00.000Z",
          status: "succeeded",
          decision: {
            id: "decision-1",
            status: "keep" as const,
            title: "Processed title",
            summary: "Summary",
            reason: "Relevant",
            labels: ["product"],
            policy: { standalone: "auto" as const, aggregation: "allow" as const },
          },
          reviewNeeded: false,
          issueCount: 0,
          override: { inputSeq: 1, mode: "automatic" as const, revision: 0 },
          metadata: { sourceSyncedAt: null, listMembershipVersion: 2 },
        },
      ],
    }

    expect(readingEntriesSchema.parse(response)).toEqual(response)
    expect(
      readingEntriesSchema.safeParse({
        entries: [{ ...response.entries[0], content: "private raw body" }],
      }).success,
    ).toBe(false)
  })

  it("支持旧 StoryLink 与材料不足的 independent link，且 independent 不含旧正文", () => {
    const story = {
      id: "story-1",
      aggregationRuleId: "rule-1",
      aggregationScopeVersion: "scope-1",
      status: "repairing" as const,
      currentRevision: 3,
      currentSubstantiveRevision: 3,
      mergedInto: null,
      splitInto: [],
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt,
    }
    expect(readingStorySchema.safeParse({ kind: "current", story, revision }).success).toBe(true)
    expect(
      readingStorySchema.safeParse({ kind: "independent", story, reason: "不足两条材料" }).success,
    ).toBe(true)
    expect(
      readingStorySchema.safeParse({
        kind: "split",
        story: { ...story, status: "split" },
        splitInto: ["child"],
        independentInputSeqs: [3],
      }).success,
    ).toBe(true)
  })

  it("接受后端 ready 与 repairing research pack 的完整结构", () => {
    const ready = {
      status: "ready" as const,
      storyId: "11111111-1111-4111-8111-111111111111",
      revision: 3,
      title: "Research material",
      markdown: "# Research material",
      references: [
        {
          inputSeq: 1,
          sourceKey: "feed/1",
          itemId: "entry-1",
          title: "Entry title",
          url: "https://example.com/entry-1",
          quote: "Quoted source text",
        },
      ],
    }

    expect(researchPackSchema.parse(ready)).toEqual(ready)
    expect(
      researchPackSchema.safeParse({
        status: "repairing",
        storyId: ready.storyId,
        revision: null,
        title: null,
        markdown: null,
        references: [],
      }).success,
    ).toBe(true)
    expect(researchPackSchema.safeParse({ ...ready, revision: null }).success).toBe(false)
  })
})
