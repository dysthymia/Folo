import { FeedViewType } from "@follow/constants"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  GeneratedFeedPage,
  GeneratedReaderItem,
  GeneratedStoryState,
} from "./generated-feed-client"
import { readerSession } from "./generated-feed-session"
import { GeneratedTimeline } from "./GeneratedTimeline"

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  view: -1,
  page: vi.fn(),
  story: vi.fn(),
  mutate: vi.fn(),
  detail: vi.fn(),
  read: vi.fn(),
  unread: vi.fn(),
  collect: vi.fn(),
  uncollect: vi.fn(),
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("jotai", () => ({ useAtom: () => ["processed", vi.fn()] }))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("@follow/store/entry/store", () => ({
  entrySyncServices: { fetchEntryDetail: mocks.detail },
}))
vi.mock("@follow/store/unread/store", () => ({
  unreadSyncService: { markEntryAsRead: mocks.read, markEntryAsUnread: mocks.unread },
}))
vi.mock("@follow/store/collection/store", () => ({
  collectionSyncService: { starEntry: mocks.collect, unstarEntry: mocks.uncollect },
}))
vi.mock("@follow/store/subscription/getter", () => ({
  getSubscriptionByEntryId: () => ({ view: 1 }),
}))
vi.mock("~/hooks/biz/useRouteParams", () => ({ useRouteParams: () => ({ view: mocks.view }) }))
vi.mock("~/atoms/settings/general", () => ({ useGeneralSettingKey: () => false }))
vi.mock("~/modules/entry-column/atoms/processing-timeline", () => ({ timelineContentModeAtom: {} }))
vi.mock("~/modules/entry-content/components/entry-content", () => ({
  EntryContent: () => <div>原文正文</div>,
}))
vi.mock("./StoryDigestPanel", () => ({
  StoryDigestPanel: ({ storyId }: { storyId: string }) => <div>{`综述正文:${storyId}`}</div>,
}))
vi.mock("./InformationIntegration", () => ({ InformationIntegration: () => null }))
vi.mock("./ResearchPanel", () => ({ ResearchPanel: () => null }))
vi.mock("./GeneratedEntryControls", () => ({ GeneratedEntryControls: () => null }))
vi.mock("./generated-feed-client", () => ({
  loadGeneratedFeedPage: mocks.page,
  loadGeneratedStoryState: mocks.story,
  setGeneratedStoryState: mocks.mutate,
  generatedItemKey: (item: GeneratedReaderItem) =>
    item.kind === "story" ? `story:${item.id}` : `entry:${item.sourceKey}:${item.id}`,
  appendGeneratedPage: (current: GeneratedReaderItem[], next: GeneratedReaderItem[]) => [
    ...current,
    ...next.filter((item) => !current.some((known) => known.id === item.id)),
  ],
}))

function entry(id: string): GeneratedReaderItem {
  return {
    kind: "entry",
    origin: "original",
    id,
    sourceKey: "feed/1",
    title: `原文:${id}`,
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

describe("生成时间线异步与会话归属", () => {
  let root: Root
  let container: HTMLDivElement
  let frames: FrameRequestCallback[]
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
    mocks.view = FeedViewType.All
    readerSession(null, "clear")
    mocks.page.mockResolvedValue(page([entry("one")]))
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
  const render = async (source = "feed/1", url = "/") => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <GeneratedTimeline scope={{ mode: "smart", sourceKeys: [source] }} />
        </MemoryRouter>,
      ),
    )
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
    })
  }
  const click = async (text: string) => {
    const target = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    )
    expect(target).toBeDefined()
    await act(async () => target!.click())
  }

  it("旧轮询晚返回不能覆盖已加载第二页，人工失效保留当前snapshot", async () => {
    mocks.page.mockResolvedValueOnce(page([entry("one")], "fixed", "cursor-2"))
    await render()
    const poll = deferred<GeneratedFeedPage>()
    mocks.page.mockReturnValueOnce(poll.promise)
    await act(async () => window.dispatchEvent(new Event("processing-reading-invalidated")))
    mocks.page.mockResolvedValueOnce(page([entry("two")], "fixed"))
    await click("processing.generated.load_more")
    await act(async () => poll.resolve(page([entry("one")], "fixed", "cursor-2")))
    expect(container.textContent).toContain("原文:two")
    expect(container.textContent).toContain("原文:one")
    expect(mocks.page.mock.calls[1]?.[0]).toMatchObject({ snapshotId: "fixed" })
    expect(container.textContent).not.toContain("processing.generated.load_more")
  })

  it("scope切换保存页码与滚动，返回旧scope复用不会存成新scope", async () => {
    mocks.page.mockResolvedValueOnce(page([entry("one")], "scope-a", "cursor-2"))
    await render()
    mocks.page.mockResolvedValueOnce(page([entry("two")], "scope-a"))
    await click("processing.generated.load_more")
    const scroller = container.querySelector<HTMLDivElement>("ul")!.parentElement!
    scroller.scrollTop = 123
    await act(async () => scroller.dispatchEvent(new Event("scroll", { bubbles: true })))
    mocks.page.mockResolvedValueOnce(page([entry("other")], "scope-b"))
    await render("feed/2")
    expect(container.textContent).toContain("原文:other")
    await render("feed/1")
    expect(container.textContent).toContain("原文:two")
    expect(container.querySelector("ul")!.parentElement!.scrollTop).toBe(123)
    expect(mocks.page).toHaveBeenCalledTimes(3)
  })

  it("账号切换取消旧原文详情后续读态操作并清除深链状态", async () => {
    mocks.page.mockResolvedValue(page([{ ...entry("one"), read: false }]))
    await render()
    const detail = deferred<{ feedId: string }>()
    mocks.detail.mockReturnValueOnce(detail.promise)
    const item = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("原文:one"),
    )!
    await act(async () => item.click())
    mocks.owner = "owner-b"
    mocks.page.mockResolvedValue(page([entry("other-owner")], "owner-b"))
    await render()
    await act(async () => detail.resolve({ feedId: "1" }))
    expect(mocks.read).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("原文:one")
    expect(container.textContent).toContain("原文:other-owner")
  })

  it("深链旧账号POST晚返回不能写入新账号收藏状态", async () => {
    mocks.page.mockResolvedValue(page([]))
    await render("feed/1", "/?story=deep")
    const mutation = deferred<{
      storyId: string
      read: boolean
      collected: boolean
      hasImportantUpdate: boolean
      link: { kind: "missing" }
    }>()
    mocks.mutate.mockReturnValueOnce(mutation.promise)
    await click("processing.generated.collect")
    const requestSignal = mocks.mutate.mock.calls[0]?.[2] as AbortSignal
    mocks.owner = "owner-b"
    await render("feed/1", "/?story=deep")
    expect(requestSignal.aborted).toBe(true)
    await act(async () =>
      mutation.resolve({
        storyId: "deep",
        read: true,
        collected: true,
        hasImportantUpdate: false,
        link: { kind: "missing" },
      }),
    )
    expect(container.textContent).toContain("processing.generated.collect")
    expect(container.textContent).not.toContain("processing.generated.uncollect")
  })

  it("收藏尚未完成时切换筛选不取消目标操作，返回旧快照仍保留收藏", async () => {
    mocks.page.mockResolvedValue(page([]))
    await render("feed/1", "/?story=deep")
    const mutation = deferred<GeneratedStoryState>()
    mocks.mutate.mockReturnValueOnce(mutation.promise)
    await click("processing.generated.collect")
    const requestSignal = mocks.mutate.mock.calls[0]?.[2] as AbortSignal
    const filter = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent === "processing.generated.collected",
    )!
    await act(async () => filter.click())
    expect(requestSignal.aborted).toBe(false)
    const favorite: GeneratedReaderItem = {
      kind: "story",
      origin: "generated",
      id: "deep",
      storyId: "deep",
      generatedFeedId: "generated:events",
      revision: 1,
      substantiveRevision: 1,
      title: "刚刚收藏的综述",
      summary: "正文",
      publishedAt: "2026-10-03T00:00:00Z",
      updatedAt: "2026-10-03T00:00:00Z",
      materialCount: 2,
      topics: [],
      read: true,
      collected: true,
      hasImportantUpdate: false,
      sourceKeys: ["feed/1"],
    }
    mocks.page.mockResolvedValueOnce(page([favorite], "favorite-written"))
    await act(async () =>
      mutation.resolve({
        storyId: "deep",
        read: true,
        collected: true,
        hasImportantUpdate: false,
        link: { kind: "missing" },
      }),
    )
    expect(container.textContent).toContain("processing.generated.uncollect")
    expect(container.textContent).toContain("刚刚收藏的综述")
    expect(mocks.page.mock.calls.at(-1)?.[0]).toMatchObject({ collectedOnly: true, refresh: true })
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "processing.generated.uncollect",
      )?.disabled,
    ).toBe(false)
    await act(async () => filter.click())
    expect(container.textContent).toContain("processing.generated.uncollect")
    // 成功的读态/收藏覆盖返回时较旧的深链取页响应，不跳动当前列表。
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
  })

  it("原文详情等待时切换来源仍完成读态，旧页缓存不被新来源覆盖", async () => {
    mocks.page.mockResolvedValueOnce(page([{ ...entry("one"), read: false }], "scope-a"))
    await render()
    const detail = deferred<{ feedId: string }>()
    mocks.detail.mockReturnValueOnce(detail.promise)
    const target = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("原文:one"),
    )!
    await act(async () => target.click())
    mocks.page.mockResolvedValueOnce(page([entry("other")], "scope-b"))
    await render("feed/2")
    await act(async () => detail.resolve({ feedId: "1" }))
    expect(mocks.read).toHaveBeenCalledWith("one")
    expect(container.textContent).toContain("原文:other")
    expect(container.textContent).not.toContain("原文:one")
    await render("feed/1")
    expect(container.textContent).toContain("原文:one")
    expect(container.textContent).toContain("processing.generated.mark_unread")
  })

  it("筛选前开始的深链读取晚返回，不能覆盖已完成的收藏", async () => {
    mocks.page.mockResolvedValue(page([]))
    await render("feed/1", "/?story=deep")
    const mutation = deferred<GeneratedStoryState>()
    const lateState = deferred<GeneratedStoryState>()
    mocks.mutate.mockReturnValueOnce(mutation.promise)
    await click("processing.generated.collect")
    mocks.story.mockReturnValueOnce(lateState.promise)
    const filter = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent === "processing.generated.collected",
    )!
    await act(async () => filter.click())
    await act(async () =>
      mutation.resolve({
        storyId: "deep",
        read: true,
        collected: true,
        hasImportantUpdate: false,
        link: { kind: "missing" },
      }),
    )
    await act(async () =>
      lateState.resolve({
        storyId: "deep",
        read: true,
        collected: false,
        hasImportantUpdate: false,
        link: { kind: "missing" },
      }),
    )
    expect(container.textContent).toContain("processing.generated.uncollect")
  })

  it("人工纠错在分页等待期间发生时，分页完成立即重读冻结页面", async () => {
    mocks.page.mockResolvedValueOnce(page([entry("one")], "fixed", "cursor-2"))
    await render()
    const second = deferred<GeneratedFeedPage>()
    mocks.page.mockReturnValueOnce(second.promise)
    await click("processing.generated.load_more")
    await act(async () => window.dispatchEvent(new Event("processing-reading-invalidated")))
    expect(mocks.page).toHaveBeenCalledTimes(2)
    mocks.page
      .mockResolvedValueOnce(page([], "fixed", "cursor-2"))
      .mockResolvedValueOnce(page([entry("two")], "fixed"))
    await act(async () => second.resolve(page([entry("two")], "fixed")))
    expect(mocks.page).toHaveBeenCalledTimes(4)
    expect(container.textContent).not.toContain("原文:one")
    expect(container.textContent).toContain("原文:two")
  })

  it("原文收藏使用实际view，滞后服务端快照不覆盖成功的本地读态和收藏", async () => {
    mocks.page.mockResolvedValue(page([entry("one")], "fixed"))
    await render()
    const item = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("原文:one"),
    )!
    await act(async () => item.click())
    await click("processing.generated.collect")
    expect(mocks.collect).toHaveBeenCalledWith({ entryId: "one", view: 1 })
    await act(async () => window.dispatchEvent(new Event("processing-reading-invalidated")))
    expect(container.textContent).toContain("processing.generated.uncollect")
  })

  it("深链综述不在列表页时仍可收藏和标未读，无效日期不触发渲染异常", async () => {
    mocks.page.mockResolvedValue(page([]))
    await render("feed/1", "/?story=deep&aiSince=bad&aiUntil=2026-02-30")
    expect(mocks.page.mock.calls[0]?.[0]).toMatchObject({ since: undefined, until: undefined })
    expect(container.textContent).toContain("综述正文:deep")
    await click("processing.generated.collect")
    expect(mocks.mutate.mock.calls[0]?.[0]).toBe("deep")
    expect(mocks.mutate.mock.calls[0]?.[1]).toMatchObject({ collected: true })
    await click("processing.generated.mark_unread")
    expect(mocks.mutate.mock.calls[1]?.[1]).toMatchObject({ read: false })
  })
})
