import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  GeneratedFeedPage,
  GeneratedReaderItem,
  GeneratedStoryState,
} from "./generated-feed-client"
import { readerSession, saveReaderSession } from "./generated-feed-session"
import { NativeReaderContext } from "./native-reader-context"
import { NativeReaderContent } from "./NativeReaderContent"
import type { GeneratedReader, GeneratedReaderOptions } from "./use-generated-reader"
import { useGeneratedReader } from "./use-generated-reader"

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  entryId: undefined as string | undefined,
  unreadOnly: false,
  page: vi.fn(),
  entryState: vi.fn(),
  story: vi.fn(),
  mutate: vi.fn(),
  detail: vi.fn(),
  read: vi.fn(),
  unread: vi.fn(),
  collect: vi.fn(),
  uncollect: vi.fn(),
  navigate: vi.fn(),
  setting: vi.fn(),
  getEntry: vi.fn(),
  starred: vi.fn(),
  locate: vi.fn(),
  patchRead: vi.fn(),
  cacheCollection: vi.fn(),
  scrollTo: vi.fn(),
  sdkListeners: new Set<() => void>(),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("@follow/store/entry/store", () => ({
  entrySyncServices: { fetchEntryDetail: mocks.detail },
  entryActions: { markEntryReadStatusInSession: mocks.patchRead },
}))
vi.mock("@follow/store/entry/getter", () => ({ getEntry: mocks.getEntry }))
vi.mock("@follow/store/collection/getter", () => ({ isEntryStarred: mocks.starred }))
vi.mock("@follow/store/entry/hooks", () => ({
  useEntry: (entryId: string) =>
    React.useSyncExternalStore(
      (listener) => {
        mocks.sdkListeners.add(listener)
        return () => {
          mocks.sdkListeners.delete(listener)
        }
      },
      () => mocks.getEntry(entryId),
    ),
}))
vi.mock("@follow/store/collection/hooks", () => ({
  useIsEntryStarred: (entryId: string) =>
    React.useSyncExternalStore(
      (listener) => {
        mocks.sdkListeners.add(listener)
        return () => {
          mocks.sdkListeners.delete(listener)
        }
      },
      () => mocks.starred(entryId),
    ),
}))
vi.mock("@follow/store/unread/store", () => ({
  unreadSyncService: { markEntryAsRead: mocks.read, markEntryAsUnread: mocks.unread },
}))
vi.mock("@follow/store/collection/store", () => ({
  collectionSyncService: { starEntry: mocks.collect, unstarEntry: mocks.uncollect },
  collectionActions: { upsertManyInSession: mocks.cacheCollection },
}))
vi.mock("@follow/store/subscription/getter", () => ({
  getSubscriptionByEntryId: () => ({ view: 1 }),
}))
vi.mock("~/hooks/biz/useRouteParams", async () => {
  const { useParams } = await import("react-router")
  // 模型测试仍读取当前 React Router 参数，不能把旧 readonly atom 当成本次导航。
  return { useRouterRouteParams: () => ({ view: -1, entryId: useParams().entryId }) }
})
vi.mock("~/hooks/biz/useNavigateEntry", () => ({ navigateEntry: mocks.navigate }))
vi.mock("~/atoms/settings/general", () => ({
  useGeneralSettingKey: () => mocks.unreadOnly,
  setGeneralSetting: mocks.setting,
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("~/hooks/biz/useRenderStyle", () => ({ useRenderStyle: () => ({}) }))
vi.mock("~/components/common/Focusable", () => ({
  Focusable: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))
vi.mock("@follow/components/ui/scroll-area/index.js", () => ({
  ScrollArea: { ScrollArea: ({ children }: React.PropsWithChildren) => <div>{children}</div> },
}))
vi.mock("~/providers/wrapped-element-provider", () => ({
  WrappedElementProvider: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))
vi.mock("~/modules/entry-content/components/entry-content", () => ({
  EntryContent: ({ entryId }: { entryId: string }) => (
    <div data-native-content={entryId}>
      <button
        onClick={() => {
          void mocks.read(entryId)
        }}
      >
        read
      </button>
      <button
        onClick={() => {
          void mocks.unread(entryId)
        }}
      >
        unread
      </button>
      <button
        onClick={() => {
          void mocks.collect({ entryId })
        }}
      >
        star
      </button>
      <button
        onClick={() => {
          void mocks.uncollect({ entryId })
        }}
      >
        unstar
      </button>
    </div>
  ),
}))
vi.mock(
  "~/modules/entry-content/components/entry-content/EntryScrollingAndNavigationHandler",
  () => ({ EntryScrollingAndNavigationHandler: () => null }),
)
vi.mock("./GeneratedEntryControls", () => ({ GeneratedEntryControls: () => null }))
vi.mock("./InformationIntegration", () => ({ InformationIntegration: () => null }))
vi.mock("./ResearchPanel", () => ({ ResearchPanel: () => null }))
vi.mock("./StoryDigestPanel", () => ({ StoryDigestPanel: () => null }))
vi.mock("./generated-feed-client", () => ({
  loadGeneratedFeedPage: mocks.page,
  loadGeneratedEntryState: mocks.entryState,
  loadGeneratedStoryState: mocks.story,
  setGeneratedStoryState: mocks.mutate,
  locateGeneratedReaderTarget: mocks.locate,
  generatedItemKey: (item: GeneratedReaderItem) =>
    item.kind === "story" ? `story:${item.id}` : `entry:${item.sourceKey}:${item.id}`,
  appendGeneratedPage: (current: GeneratedReaderItem[], next: GeneratedReaderItem[]) => [
    ...current,
    ...next.filter((item) => !current.some((known) => known.id === item.id)),
  ],
}))

function entry(id: string): Extract<GeneratedReaderItem, { kind: "entry" }> {
  return {
    kind: "entry",
    origin: "original",
    id,
    sourceKey: "feed/1",
    title: id,
    summary: "摘要",
    publishedAt: "2026-10-03T00:00:00Z",
    read: true,
    collected: false,
    materialCount: 1,
    topics: [],
    inputSeq: 1,
    decisionId: "decision",
    storyIds: [],
  }
}
function page(
  items: GeneratedReaderItem[],
  snapshotId = "snapshot-a",
  nextCursor: string | null = null,
): GeneratedFeedPage {
  return {
    feed: { id: "generated:events", origin: "generated", title: "事件综述", private: true },
    snapshotId,
    latestAvailable: false,
    total: items.length,
    nextCursor,
    items,
    counts: { pending: 0, failed: 0, needsContext: 0 },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("共享原生阅读查询与异步归属", () => {
  let root: Root
  let container: HTMLDivElement
  let reader: GeneratedReader
  let frames: FrameRequestCallback[]
  let location: ReturnType<typeof useLocation>
  let renderContent: boolean
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.owner = "owner-a"
    mocks.entryId = undefined
    mocks.unreadOnly = false
    renderContent = false
    readerSession(null, "clear")
    mocks.page.mockResolvedValue(page([entry("one")]))
    mocks.entryState.mockResolvedValue({
      entryId: "deep-entry",
      status: "ready",
      reason: null,
      item: entry("deep-entry"),
      target: null,
    })
    mocks.story.mockResolvedValue({
      storyId: "deep",
      read: true,
      collected: false,
      hasImportantUpdate: false,
      link: { kind: "missing" },
    })
    mocks.mutate.mockResolvedValue({
      storyId: "deep",
      read: true,
      collected: true,
      hasImportantUpdate: false,
      link: { kind: "missing" },
    })
    mocks.detail.mockResolvedValue({ feedId: "1" })
    mocks.read.mockResolvedValue(undefined)
    mocks.collect.mockResolvedValue(undefined)
    mocks.getEntry.mockReturnValue({ read: true })
    mocks.starred.mockReturnValue(false)
    mocks.locate.mockResolvedValue({ target: null })
    frames = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function Harness(options: GeneratedReaderOptions) {
    location = useLocation()
    reader = useGeneratedReader(options)
    reader.listScrollRef.current = mocks.scrollTo
    return (
      <div ref={reader.scrollRef}>
        {reader.items.map((item) => (
          <span key={item.id}>{item.id}</span>
        ))}
        {renderContent && (
          <NativeReaderContext value={reader}>
            <NativeReaderContent
              entryId={reader.target?.kind === "entry" ? reader.target.entryId : ""}
            />
          </NativeReaderContext>
        )}
      </div>
    )
  }
  const render = async (enabled = true, source = "feed/1", url = "/") => {
    const path = url === "/" && mocks.entryId ? `/timeline/all/all/${mocks.entryId}` : url
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/timeline/:timelineId/:feedId/:entryId"
              element={
                <Harness enabled={enabled} scope={{ mode: "smart", sourceKeys: [source] }} />
              }
            />
            <Route
              path="*"
              element={
                <Harness enabled={enabled} scope={{ mode: "smart", sourceKeys: [source] }} />
              }
            />
          </Routes>
        </MemoryRouter>,
      ),
    )
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
    })
  }

  it("关闭 AI 不发投影请求，重新开启复用分页与滚动会话", async () => {
    await render(false)
    expect(mocks.page).not.toHaveBeenCalled()
    mocks.page.mockResolvedValueOnce(page([entry("one")], "fixed", "next"))
    await render()
    mocks.page.mockResolvedValueOnce(page([entry("two")], "fixed"))
    await act(async () => reader.loadMore())
    reader.scrollRef.current!.scrollTop = 123
    await render(false)
    await render()
    expect(reader.items.map((item) => item.id)).toEqual(["one", "two"])
    expect(reader.scrollRef.current!.scrollTop).toBe(123)
    expect(mocks.page).toHaveBeenCalledTimes(2)
  })

  it("忽略旧 aiUnread 参数并消费共享原生未读偏好", async () => {
    await render(true, "feed/1", "/?aiUnread=true")
    expect(reader.query.unreadOnly).toBe(false)
    mocks.unreadOnly = true
    await render()
    expect(mocks.page.mock.calls.at(-1)?.[0]).toMatchObject({ unreadOnly: true })
    await act(async () => reader.setUnreadOnly(false))
    expect(mocks.setting).toHaveBeenCalledWith("unreadOnly", false)
  })

  it("原生收藏范围忽略未读偏好，已读且收藏的Story仍显示", async () => {
    mocks.unreadOnly = true
    const story: GeneratedReaderItem = {
      kind: "story",
      origin: "generated",
      id: "read-story",
      storyId: "read-story",
      generatedFeedId: "generated:events",
      revision: 1,
      substantiveRevision: 1,
      title: "已读综述",
      summary: "摘要",
      publishedAt: "2026-10-03T00:00:00Z",
      updatedAt: "2026-10-03T00:00:00Z",
      read: true,
      collected: true,
      materialCount: 2,
      topics: [],
      hasImportantUpdate: false,
      sourceKeys: ["feed/1"],
    }
    mocks.page.mockImplementation((query: { unreadOnly: boolean }) =>
      Promise.resolve(page(query.unreadOnly ? [] : [story])),
    )
    await act(async () =>
      root.render(
        <MemoryRouter>
          <Harness enabled scope={{ mode: "collections" }} />
        </MemoryRouter>,
      ),
    )
    expect(reader.query.unreadOnly).toBe(false)
    expect(reader.items).toEqual([story])
  })

  it("无Row的深链原文通过原生正文SDK动作同步深链和跨来源收藏缓存", async () => {
    renderContent = true
    mocks.entryId = "deep-entry"
    mocks.page.mockResolvedValue(page([]))
    mocks.entryState.mockResolvedValue({
      entryId: "deep-entry",
      status: "ready",
      reason: null,
      item: { ...entry("deep-entry"), read: true, collected: true },
      target: null,
    })
    mocks.getEntry.mockReturnValue({ read: false, feedId: "1" })
    mocks.starred.mockReturnValue(true)
    readerSession("owner-a", "other-favorites")
    const cached = { ...entry("deep-entry"), sourceKey: "list/other", collected: true }
    saveReaderSession("owner-a", "other-favorites", {
      page: page([cached]),
      items: [cached],
      cursors: [undefined],
      scrollTop: 88,
    })
    const emitSdk = () => {
      for (const listener of mocks.sdkListeners) listener()
    }
    mocks.read.mockImplementation(async () => {
      mocks.getEntry.mockReturnValue({ read: true, feedId: "1" })
      emitSdk()
    })
    mocks.unread.mockImplementation(async () => {
      mocks.getEntry.mockReturnValue({ read: false, feedId: "1" })
      emitSdk()
    })
    mocks.uncollect.mockImplementation(async () => {
      mocks.starred.mockReturnValue(false)
      emitSdk()
    })
    mocks.collect.mockImplementation(async () => {
      mocks.starred.mockReturnValue(true)
      emitSdk()
    })
    await render()
    expect(reader.items).toEqual([])
    expect(reader.selectedRead).toBe(true)
    expect(reader.selectedCollected).toBe(true)
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      )!
      await act(async () => button.click())
    }
    await click("read")
    await click("unread")
    expect(reader.selectedRead).toBe(false)
    await click("unstar")
    expect(reader.selectedCollected).toBe(false)
    expect(readerSession("owner-a", "other-favorites")?.items[0]).toMatchObject({
      read: false,
      collected: false,
    })
    await click("star")
    expect(reader.selectedCollected).toBe(true)
    expect(readerSession("owner-a", "other-favorites")?.items[0]?.collected).toBe(true)
    expect(reader.items).toEqual([])
    expect(reader.counts).toEqual({ pending: 0, failed: 0, needsContext: 0 })
    expect(mocks.page).toHaveBeenCalledTimes(1)
  })

  it("旧轮询晚返回不能覆盖已加载第二页", async () => {
    mocks.page.mockResolvedValueOnce(page([entry("one")], "fixed", "next"))
    await render()
    const poll = deferred<GeneratedFeedPage>()
    mocks.page.mockReturnValueOnce(poll.promise)
    await act(async () => window.dispatchEvent(new Event("processing-reading-invalidated")))
    mocks.page.mockResolvedValueOnce(page([entry("two")], "fixed"))
    await act(async () => reader.loadMore())
    await act(async () => poll.resolve(page([entry("one")], "fixed", "next")))
    expect(reader.items.map((item) => item.id)).toEqual(["one", "two"])
    expect(reader.page?.nextCursor).toBeNull()
  })

  it("分页期间人工失效在完成后重读所有冻结页", async () => {
    mocks.page.mockResolvedValueOnce(page([entry("one")], "fixed", "next"))
    await render()
    const second = deferred<GeneratedFeedPage>()
    mocks.page.mockReturnValueOnce(second.promise)
    let loading!: Promise<void>
    await act(async () => {
      loading = reader.loadMore()
    })
    await act(async () => window.dispatchEvent(new Event("processing-reading-invalidated")))
    mocks.page
      .mockResolvedValueOnce(page([], "fixed", "next"))
      .mockResolvedValueOnce(page([entry("two")], "fixed"))
    await act(async () => {
      second.resolve(page([entry("two")], "fixed"))
      await loading
    })
    expect(reader.items.map((item) => item.id)).toEqual(["two"])
    expect(mocks.page).toHaveBeenCalledTimes(4)
  })

  it("账号切换取消旧详情请求后的官方读态操作并隐藏旧结果", async () => {
    await render()
    const detail = deferred<{ feedId: string }>()
    mocks.detail.mockReturnValueOnce(detail.promise)
    let mutation!: Promise<void>
    await act(async () => {
      mutation = reader.mutateItem(entry("one"), { read: true })
    })
    mocks.owner = "owner-b"
    mocks.page.mockResolvedValue(page([entry("new-owner")]))
    await render()
    await act(async () => {
      detail.resolve({ feedId: "1" })
      await mutation
    })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(reader.items.map((item) => item.id)).toEqual(["new-owner"])
  })

  it("切换来源不取消目标操作，旧会话保留确认后的收藏", async () => {
    await render()
    const detail = deferred<{ feedId: string }>()
    mocks.detail.mockReturnValueOnce(detail.promise)
    let mutation!: Promise<void>
    await act(async () => {
      mutation = reader.mutateItem(entry("one"), { collected: true })
    })
    mocks.page.mockResolvedValueOnce(page([entry("other")], "scope-b"))
    await render(true, "feed/2")
    await act(async () => {
      detail.resolve({ feedId: "1" })
      await mutation
    })
    expect(reader.items[0]?.id).toBe("other")
    await render()
    expect(reader.items[0]?.collected).toBe(true)
  })

  it("原文深链独立读取，不在首批页的未处理收藏仍可操作", async () => {
    mocks.entryId = "deep-entry"
    mocks.entryState.mockResolvedValue({
      entryId: "deep-entry",
      status: "unprocessed",
      reason: null,
      item: { ...entry("deep-entry"), inputSeq: null, decisionId: null },
      target: null,
    })
    await render()
    expect(mocks.entryState).toHaveBeenCalledWith("deep-entry", expect.any(AbortSignal))
    expect(reader.selected?.id).toBe("deep-entry")
    expect(reader.target).toEqual({ kind: "entry", entryId: "deep-entry" })
    await act(async () => reader.mutateItem(reader.selected!, { collected: true }))
    expect(mocks.collect).toHaveBeenCalledWith({ entryId: "deep-entry", view: 1 })
    expect(reader.selectedCollected).toBe(true)
  })

  it("深链综述不在列表时仍有独立操作目标", async () => {
    await render(true, "feed/1", "/?story=deep")
    expect(reader.storyId).toBe("deep")
    await act(async () => reader.mutateItem(reader.mutationTarget!, { collected: true }))
    expect(mocks.mutate).toHaveBeenCalledWith(
      "deep",
      expect.objectContaining({ collected: true }),
      expect.any(AbortSignal),
    )
    expect(reader.selectedCollected).toBe(true)
  })

  it("普通条目选择调用原生导航，不制造处理服务 entryId", async () => {
    await render()
    await act(async () => reader.selectItem(entry("official-entry")))
    expect(mocks.navigate).toHaveBeenCalledWith({ entryId: "official-entry" })
  })

  it("分页原文仅补齐官方 store 缺失项，重复渲染不重复取详情", async () => {
    mocks.getEntry.mockReturnValue(undefined)
    mocks.page.mockResolvedValue(page([entry("one"), entry("two"), entry("three"), entry("four")]))
    await render()
    expect(mocks.detail).toHaveBeenCalledTimes(4)
    await render()
    expect(mocks.detail).toHaveBeenCalledTimes(4)
  })

  it("来源变更时上一批未完成的 hydrate 请求仍受三并发限制", async () => {
    mocks.getEntry.mockReturnValue(undefined)
    mocks.page.mockResolvedValueOnce(
      page([entry("one"), entry("two"), entry("three"), entry("four")]),
    )
    const details: ReturnType<typeof deferred<{ feedId: string }>>[] = []
    mocks.detail.mockImplementation(() => {
      const detail = deferred<{ feedId: string }>()
      details.push(detail)
      return detail.promise
    })
    await render()
    expect(mocks.detail).toHaveBeenCalledTimes(3)
    mocks.page.mockResolvedValueOnce(page([entry("other")], "scope-b"))
    await render(true, "feed/2")
    expect(mocks.detail).toHaveBeenCalledTimes(3)
    await act(async () => details[0]!.resolve({ feedId: "1" }))
    expect(mocks.detail).toHaveBeenCalledTimes(4)
    await act(async () => {
      for (const detail of details) detail.resolve({ feedId: "1" })
    })
  })

  it("原生行完成读态和收藏后同步冻结投影与阅读会话", async () => {
    await render()
    await act(async () => reader.syncOriginalState(entry("one")))
    mocks.getEntry.mockReturnValue({ read: false })
    mocks.starred.mockReturnValue(true)
    await act(async () =>
      reader.syncOriginalState(entry("one") as Extract<GeneratedReaderItem, { kind: "entry" }>),
    )
    expect(reader.items[0]).toMatchObject({ read: false, collected: true })
    await render(false)
    await render()
    expect(reader.items[0]).toMatchObject({ read: false, collected: true })
  })

  it("同步回调跨普通render保持稳定且首个SDK false不会抹掉后台收藏", async () => {
    mocks.page.mockResolvedValue(
      page([{ ...entry("one"), collected: true, collectedAt: "2026-10-01T00:00:00Z", view: 1 }]),
    )
    mocks.getEntry.mockReturnValue({ read: false, feedId: "1" })
    await render()
    const sync = reader.syncOriginalState
    await act(async () =>
      reader.syncOriginalState(reader.items[0] as Extract<GeneratedReaderItem, { kind: "entry" }>),
    )
    expect(reader.items[0]).toMatchObject({ read: true, collected: true })
    expect(mocks.cacheCollection).toHaveBeenCalledWith([
      { entryId: "one", feedId: "1", view: 1, createdAt: "2026-10-01T00:00:00Z" },
    ])
    await render()
    expect(reader.syncOriginalState).toBe(sync)
    expect(mocks.collect).not.toHaveBeenCalled()
  })

  it("深链状态先到导致hydrate队列取消时，晚到详情仍补齐实际SDK读态", async () => {
    mocks.entryId = "deep-entry"
    mocks.page.mockResolvedValue(page([]))
    let hydrated = false
    let sdkRead = false
    mocks.getEntry.mockImplementation(() => (hydrated ? { read: sdkRead, feedId: "1" } : undefined))
    mocks.patchRead.mockImplementation(({ read }: { read: boolean }) => {
      sdkRead = read
    })
    const detail = deferred<{ feedId: string }>()
    mocks.detail.mockReturnValueOnce(detail.promise)
    await render()
    await act(async () => {
      hydrated = true
      detail.resolve({ feedId: "1" })
    })
    expect(mocks.patchRead).toHaveBeenCalledWith({ entryIds: ["deep-entry"], read: true })
    expect(sdkRead).toBe(true)
  })

  it("首批外深链自动读取同快照前一页与目标页，键盘邻项正确且返回恢复滚动", async () => {
    mocks.entryId = "far-entry"
    mocks.entryState.mockResolvedValue({
      entryId: "far-entry",
      status: "ready",
      reason: null,
      item: entry("far-entry"),
      target: null,
    })
    mocks.locate.mockResolvedValue({
      target: { snapshotId: "fixed", cursor: "far-cursor", previousCursor: "previous-cursor" },
    })
    mocks.page.mockImplementation((query: { cursor?: string }) =>
      Promise.resolve(
        query.cursor === "previous-cursor"
          ? page([entry("before")], "fixed", "far-cursor")
          : query.cursor === "far-cursor"
            ? page([entry("far-entry"), entry("after")], "fixed", "later")
            : page([entry("one")], "fixed", "first-next"),
      ),
    )
    await render()
    expect(reader.items.map((item) => item.id)).toEqual(["before", "far-entry", "after"])
    expect(reader.selected?.id).toBe("far-entry")
    expect(mocks.page).toHaveBeenCalledTimes(3)
    expect(mocks.page.mock.calls[1]?.[0]).toMatchObject({
      snapshotId: "fixed",
      cursor: "previous-cursor",
    })
    expect(mocks.page.mock.calls[1]?.[0]).not.toHaveProperty("previousCursor")
    expect(mocks.scrollTo).toHaveBeenCalledWith(1)
    reader.scrollRef.current!.scrollTop = 321
    await render(false)
    await render()
    expect(reader.scrollRef.current!.scrollTop).toBe(321)
    expect(mocks.page).toHaveBeenCalledTimes(3)
    expect(mocks.scrollTo).toHaveBeenCalledTimes(1)
  })

  it("自动定位旧范围晚返回不能将目标页写入新范围", async () => {
    mocks.entryId = "far-entry"
    const oldLocate = deferred<{
      target: { snapshotId: string; cursor: string; previousCursor: string | null }
    }>()
    mocks.locate.mockReturnValueOnce(oldLocate.promise)
    await render()
    mocks.page.mockResolvedValueOnce(page([entry("other")], "other-snapshot"))
    await render(true, "feed/2")
    await act(async () =>
      oldLocate.resolve({
        target: { snapshotId: "old-snapshot", cursor: "far-cursor", previousCursor: null },
      }),
    )
    expect(reader.items.map((item) => item.id)).toEqual(["other"])
    expect(mocks.page).toHaveBeenCalledTimes(2)
  })

  it("冷启动旧item深链replace为原生路径并保留搜索范围", async () => {
    mocks.entryId = "pending"
    await render(true, "feed/1", "/timeline/all/all/pending?item=entry:feed/1:official&aiSearch=AI")
    expect(location.pathname).toBe("/timeline/all/all/official")
    expect(new URLSearchParams(location.search).get("aiSearch")).toBe("AI")
    expect(new URLSearchParams(location.search).has("item")).toBe(false)
  })

  it("原生操作旧回调晚到时不能为新账号保存读态", async () => {
    await render()
    const oldReader = reader
    mocks.owner = "owner-b"
    await render()
    mocks.getEntry.mockReturnValue({ read: false })
    mocks.starred.mockReturnValue(true)
    await act(async () =>
      oldReader.syncOriginalState(entry("one") as Extract<GeneratedReaderItem, { kind: "entry" }>),
    )
    expect(reader.items[0]).toMatchObject({ read: true, collected: false })
  })

  it("人工纠错的新深链状态不会被更早的读取覆盖", async () => {
    mocks.entryId = "deep-entry"
    const older =
      deferred<
        Awaited<ReturnType<typeof import("./generated-feed-client").loadGeneratedEntryState>>
      >()
    mocks.entryState.mockReturnValueOnce(older.promise)
    await render()
    mocks.entryState.mockResolvedValueOnce({
      entryId: "deep-entry",
      status: "hidden",
      reason: "manual",
      item: null,
      target: null,
    })
    await act(async () => window.dispatchEvent(new Event("processing-reading-invalidated")))
    expect(reader.entryState?.status).toBe("hidden")
    await act(async () =>
      older.resolve({
        entryId: "deep-entry",
        status: "ready",
        reason: null,
        item: entry("deep-entry"),
        target: null,
      }),
    )
    expect(reader.entryState?.status).toBe("hidden")
    expect(reader.deepLoading).toBe(false)
  })

  it("深链定位使用当前范围与冻结快照", async () => {
    mocks.entryId = "deep-entry"
    await render()
    mocks.locate.mockResolvedValue({
      target: { snapshotId: "snapshot-a", cursor: "deep-cursor", previousCursor: null },
    })
    let located: { snapshotId: string; cursor: string | null } | null = null
    await act(async () => {
      located = await reader.locateTarget()
    })
    expect(located).toEqual({
      snapshotId: "snapshot-a",
      cursor: "deep-cursor",
      previousCursor: null,
    })
    expect(mocks.locate.mock.calls[0]?.[1]).toMatchObject({
      mode: "smart",
      sourceKeys: ["feed/1"],
      snapshotId: "snapshot-a",
    })
  })

  it("筛选时尚未完成的收藏在写入后重新读取当前收藏范围", async () => {
    await render(true, "feed/1", "/?story=deep")
    const mutation = deferred<GeneratedStoryState>()
    mocks.mutate.mockReturnValueOnce(mutation.promise)
    let pending!: Promise<void>
    await act(async () => {
      pending = reader.mutateItem(reader.mutationTarget!, { collected: true })
    })
    await act(async () => reader.setCollectedOnly(true))
    expect((mocks.mutate.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(false)
    await act(async () => {
      mutation.resolve({
        storyId: "deep",
        read: true,
        collected: true,
        hasImportantUpdate: false,
        link: { kind: "missing" },
      })
      await pending
    })
    expect(mocks.page.mock.calls.at(-1)?.[0]).toMatchObject({ collectedOnly: true, refresh: true })
    expect(reader.selectedCollected).toBe(true)
  })
})
