import type { UseEntriesReturn } from "@follow/store/entry/types"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { GeneratedFeedQuery, GeneratedReaderItem } from "./generated-feed-client"
import type { GeneratedReader } from "./use-generated-reader"
import { useNativeTimelineOverlay } from "./use-native-timeline-overlay"

const stores = vi.hoisted(() => ({
  data: {} as Record<
    string,
    {
      title: string
      description: string
      feedId: string
      inboxHandle?: string
      publishedAt: Date
      read: boolean
    }
  >,
  collections: {} as Record<string, { entryId: string }>,
}))
vi.mock("@follow/store/entry/store", () => ({
  useEntryStore: (selector: (state: { data: typeof stores.data }) => unknown) => selector(stores),
}))
vi.mock("@follow/store/collection/store", () => ({
  useCollectionStore: (selector: (state: { collections: typeof stores.collections }) => unknown) =>
    selector(stores),
}))

const date = (hour: number) => `2026-10-04T${String(hour).padStart(2, "0")}:00:00.000Z`
const story: Extract<GeneratedReaderItem, { kind: "story" }> = {
  kind: "story",
  origin: "generated",
  id: "story-row",
  storyId: "private-story",
  generatedFeedId: "generated:events",
  revision: 1,
  substantiveRevision: 1,
  title: "事件综述",
  summary: "摘要",
  publishedAt: date(11),
  updatedAt: date(11),
  read: false,
  collected: false,
  materialCount: 2,
  topics: [],
  sourceKeys: ["feed/source"],
  hasImportantUpdate: false,
}
const staleOriginal: Extract<GeneratedReaderItem, { kind: "entry" }> = {
  kind: "entry",
  origin: "original",
  id: "sdk-new",
  title: "服务中的过时条目",
  summary: "过时摘要",
  sourceKey: "feed/source",
  publishedAt: date(9),
  read: false,
  collected: false,
  materialCount: 1,
  topics: [],
  inputSeq: null,
  decisionId: null,
  storyIds: [],
}

// 只为投影所消费的字段构造完整 fixture，网络和身份动作都保留独立 spy。
function makeReader(overrides: Partial<GeneratedReader> = {}): GeneratedReader {
  return {
    active: true,
    nativeTimeline: true,
    scope: { mode: "stories" },
    items: [story],
    target: { kind: "entry", entryId: "sdk-new" },
    selected: staleOriginal,
    mutationTarget: staleOriginal,
    selectedRead: false,
    selectedCollected: false,
    hasNextPage: false,
    loading: false,
    failed: false,
    page: {
      feed: { id: "generated:events", origin: "generated", title: "事件综述", private: true },
      snapshotId: "00000000-0000-4000-8000-000000000000",
      latestAvailable: false,
      total: 1,
      nextCursor: null,
      items: [story],
    },
    loadMore: vi.fn(async () => undefined),
    refresh: vi.fn(),
    selectItem: vi.fn(),
    mutateItem: vi.fn(),
    syncOriginalState: vi.fn(),
    ...overrides,
  } as GeneratedReader
}
function makeEntries(overrides: Partial<UseEntriesReturn> = {}): UseEntriesReturn {
  return {
    entriesIds: ["sdk-new", "sdk-old"],
    hasNext: false,
    hasNextPage: false,
    isLoading: false,
    isRefetching: false,
    isReady: true,
    isFetching: false,
    isFetchingNextPage: false,
    error: null,
    fetchNextPage: vi.fn(async () => undefined),
    refetch: vi.fn(async () => undefined),
    ...overrides,
  }
}
const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
let projection: GeneratedReader | null = null
function Probe({ reader, entries }: { reader: GeneratedReader | null; entries: UseEntriesReturn }) {
  projection = useNativeTimelineOverlay(reader, entries)
  return null
}
async function render(reader = makeReader(), entries = makeEntries()) {
  stores.data = {
    "sdk-new": {
      title: "官方新条目",
      description: "官方摘要",
      feedId: "source",
      publishedAt: new Date(date(12)),
      read: true,
    },
    "sdk-old": {
      title: "官方旧条目",
      description: "旧摘要",
      feedId: "source",
      publishedAt: new Date(date(10)),
      read: false,
    },
  }
  stores.collections = { "sdk-new": { entryId: "sdk-new" } }
  await act(() => root.render(<Probe reader={reader} entries={entries} />))
  return projection!
}
afterEach(async () => {
  await act(() => root.render(null))
  projection = null
})

// 混合时间线必须保留 SDK 全集及各自游标，不能从服务库存或失败状态推断官方全集。
describe("原生时间线双流投影", () => {
  it("服务未采集的 SDK 条目仍保留，并按时间插入 Story", async () => {
    const result = await render()
    expect(result.items.map((item) => item.id)).toEqual(["sdk-new", "story-row", "sdk-old"])
    expect(result.selected).toMatchObject({
      id: "sdk-new",
      title: "官方新条目",
      read: true,
      collected: true,
    })
    expect(result.selectedRead).toBe(true)
    expect(result.selectedCollected).toBe(true)
    expect(result.mutationTarget).toBe(result.selected)
  })
  it("服务原文缓存不覆盖 SDK 标题、时间、读态与收藏", async () => {
    const result = await render(makeReader({ items: [staleOriginal, story] }))
    expect(result.items[0]).toMatchObject({
      id: "sdk-new",
      publishedAt: date(12),
      read: true,
      collected: true,
    })
    expect(result.items.filter((item) => item.id === "sdk-new")).toHaveLength(1)
  })
  it("选中的 Story 继续使用 Story 自己的身份与状态", async () => {
    const result = await render(makeReader({ target: { kind: "story", storyId: story.storyId } }))
    expect(result.selected).toBe(story)
    expect(result.selectedRead).toBe(false)
    expect(result.selectedCollected).toBe(false)
  })
  it("服务失败保留普通条目和官方分页，不让服务 loading 卡住列表", async () => {
    const result = await render(
      makeReader({ failed: true, loading: true }),
      makeEntries({ hasNextPage: true }),
    )
    expect(result.items.map((item) => item.id)).toEqual(["sdk-new", "sdk-old"])
    expect(result.hasNextPage).toBe(true)
    expect(result.loading).toBe(false)
  })
  it.each(["sdk", "story"] as const)("%s 分页拒绝时另一个来源仍加载", async (side) => {
    const sdkLoad = vi.fn(async () => {
      if (side === "sdk") throw new Error("SDK 分页失败")
    })
    const storyLoad = vi.fn(async () => {
      if (side === "story") throw new Error("Story 分页失败")
    })
    const result = await render(
      makeReader({ hasNextPage: true, loadMore: storyLoad }),
      makeEntries({ hasNextPage: true, fetchNextPage: sdkLoad }),
    )
    await act(async () => {
      await result.loadMore()
    })
    expect(sdkLoad).toHaveBeenCalledOnce()
    expect(storyLoad).toHaveBeenCalledOnce()
  })
  it("非原生投影返回原 reader 本身", async () => {
    const reader = makeReader({ nativeTimeline: false })
    expect(await render(reader)).toBe(reader)
  })
  // 处理范围没有材料或产物时，当前官方范围的未处理条目与分页仍完整保留。
  it.each<GeneratedFeedQuery>([
    { mode: "stories", category: { view: "all", name: "AI" } },
    { mode: "stories", sourceKeys: ["feed/source"] },
  ])("空的处理范围 $mode 不撤掉官方未处理条目", async (scope) => {
    const reader = makeReader({
      scope,
      items: [],
      page: { ...makeReader().page!, total: 0, items: [] },
    })
    const result = await render(reader, makeEntries({ hasNextPage: true }))
    expect(result.items.map((item) => item.id)).toEqual(["sdk-new", "sdk-old"])
    expect(result.items.every((item) => item.kind === "entry" && item.inputSeq === null)).toBe(true)
    expect(result.selected?.title).toBe("官方新条目")
    expect(result.hasNextPage).toBe(true)
  })
  it.each([
    { sdkNext: true, storyNext: false, sdkLoading: false, storyLoading: false },
    { sdkNext: false, storyNext: true, sdkLoading: true, storyLoading: false },
    { sdkNext: true, storyNext: true, sdkLoading: false, storyLoading: true },
    { sdkNext: false, storyNext: false, sdkLoading: false, storyLoading: false },
  ])(
    "独立加载/分页状态保留所有未耗尽来源 $sdkNext/$storyNext",
    async ({ sdkNext, storyNext, sdkLoading, storyLoading }) => {
      const result = await render(
        makeReader({ hasNextPage: storyNext, loading: storyLoading }),
        makeEntries({ hasNextPage: sdkNext, isLoading: sdkLoading }),
      )
      expect(result.hasNextPage).toBe(sdkNext || storyNext)
      expect(result.loading).toBe(sdkLoading || storyLoading)
    },
  )
  it("SDK 正在分页时只继续 Story 分页，避免重复推进官方游标", async () => {
    const reader = makeReader({ hasNextPage: true })
    const entries = makeEntries({ hasNextPage: true, isFetchingNextPage: true })
    const result = await render(reader, entries)
    await act(async () => {
      await result.loadMore()
    })
    expect(entries.fetchNextPage).not.toHaveBeenCalled()
    expect(reader.loadMore).toHaveBeenCalledOnce()
    expect(result.hasNextPage).toBe(true)
  })
})
