import type { PropsWithChildren } from "react"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NativeReaderContent } from "./NativeReaderContent"
import type { ReaderTarget } from "./reader-target"

const mocks = vi.hoisted(() => ({
  reader: {
    active: true,
    target: null as ReaderTarget | null,
    storyId: null as string | null,
    selected: undefined,
    entryState: null,
    deepState: null as {
      link:
        | { kind: "merged"; mergedInto: string }
        | { kind: "split"; splitInto: string[]; independentInputSeqs: number[] }
    } | null,
    syncOriginalState: vi.fn(),
    mutationTarget: null as { kind: "story"; storyId: string; revision: number } | null,
    selectedRead: false,
    mutateItem: vi.fn(),
  },
  original: vi.fn(),
  sdkEntry: vi.fn(),
  entry: null as { read: boolean } | null,
  starred: false,
  digestReady: null as ((revision: number) => void) | null,
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./native-reader-context", () => ({ useNativeReader: () => mocks.reader }))
vi.mock("@follow/store/entry/hooks", () => ({
  useEntry: (entryId: string) => {
    mocks.sdkEntry(entryId)
    return mocks.entry
  },
}))
vi.mock("@follow/store/collection/hooks", () => ({ useIsEntryStarred: () => mocks.starred }))
vi.mock("~/hooks/biz/useRenderStyle", () => ({ useRenderStyle: () => ({}) }))
vi.mock("~/modules/entry-content/components/entry-content", () => ({
  EntryContent: ({ entryId }: { entryId: string }) => {
    mocks.original(entryId)
    return <div data-original={entryId} />
  },
}))
vi.mock("~/components/common/Focusable", () => ({
  Focusable: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))
vi.mock("@follow/components/ui/scroll-area/index.js", () => ({
  ScrollArea: { ScrollArea: ({ children }: PropsWithChildren) => <div>{children}</div> },
}))
vi.mock(
  "~/modules/entry-content/components/entry-content/EntryScrollingAndNavigationHandler",
  () => ({ EntryScrollingAndNavigationHandler: () => null }),
)
vi.mock("~/providers/wrapped-element-provider", () => ({
  WrappedElementProvider: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))
vi.mock("./StoryDigestPanel", () => ({
  StoryDigestPanel: ({
    storyId,
    onReady,
  }: {
    storyId: string
    onReady?: (revision: number) => void
  }) => {
    mocks.digestReady = onReady ?? null
    return <div data-story={storyId} />
  },
}))
vi.mock("./GeneratedEntryControls", () => ({ GeneratedEntryControls: () => null }))
vi.mock("./StoryReadingActions", () => ({
  StoryReadingActions: ({ resolution }: { resolution: { independentInputSeqs: number[] } }) => (
    <div data-independent-materials={resolution.independentInputSeqs.length} />
  ),
}))
vi.mock("./InformationIntegration", () => ({ InformationIntegration: () => null }))
vi.mock("./ResearchPanel", () => ({ ResearchPanel: () => null }))
const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
afterEach(async () => {
  await act(() => root.render(null))
  vi.clearAllMocks()
  mocks.reader.deepState = null
  mocks.reader.mutationTarget = null
  mocks.digestReady = null
})

// 验证正文边界实际传递的身份；深链可读不能只靠第一页有匹配项。
describe("统一原生正文", () => {
  // 旧深链完全拆回原文后没有子综述，仍须显示纠错结果，不能留下空白正文。
  it("完全拆回原文的旧链接交给已有纠错提示组件", async () => {
    mocks.reader.target = { kind: "story", storyId: "split-story" }
    mocks.reader.storyId = "split-story"
    mocks.reader.deepState = {
      link: { kind: "split", splitInto: [], independentInputSeqs: [11, 19, 23] },
    }
    await act(() =>
      root.render(
        <MemoryRouter>
          <NativeReaderContent entryId="" />
        </MemoryRouter>,
      ),
    )
    expect(host.querySelector('[data-independent-materials="3"]')).not.toBeNull()
    expect(mocks.digestReady).toBeNull()
  })
  it("成功正文回调只标记实际冻结版本，不能提前确认深链的较新版本", async () => {
    mocks.reader.target = { kind: "story", storyId: "private-story" }
    mocks.reader.storyId = "private-story"
    mocks.reader.mutationTarget = { kind: "story", storyId: "private-story", revision: 5 }
    await act(() =>
      root.render(
        <MemoryRouter>
          <NativeReaderContent entryId="" />
        </MemoryRouter>,
      ),
    )
    expect(mocks.reader.mutateItem).not.toHaveBeenCalled()
    await act(() => mocks.digestReady?.(3))
    expect(mocks.reader.mutateItem).toHaveBeenCalledWith(
      { kind: "story", storyId: "private-story", revision: 3 },
      { read: true },
    )
  })
  // 合并后的综述继续沿用当前全部列表，阅读过程中不跳回独立事件页面。
  it("合并综述的后继链接保留当前普通时间线", async () => {
    mocks.reader.target = { kind: "story", storyId: "old-story" }
    mocks.reader.storyId = "old-story"
    mocks.reader.deepState = { link: { kind: "merged", mergedInto: "replacement" } }
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/all/pending?story=old-story"]}>
          <NativeReaderContent entryId="" />
        </MemoryRouter>,
      ),
    )
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/timeline/all/all/pending?story=replacement",
    )
  })
  it("首批之外的原文在没有selected行时仍交给原生正文", async () => {
    mocks.reader.target = { kind: "entry", entryId: "official-outside-first-page" }
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/all/pending"]}>
          <NativeReaderContent entryId="official-outside-first-page" />
        </MemoryRouter>,
      ),
    )
    expect(mocks.original).toHaveBeenCalledWith("official-outside-first-page")
  })
  it("私人Story不使用官方EntryContent", async () => {
    mocks.reader.target = { kind: "story", storyId: "private-story" }
    mocks.reader.storyId = "private-story"
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/all/pending"]}>
          <NativeReaderContent entryId="" />
        </MemoryRouter>,
      ),
    )
    expect(host.querySelector('[data-story="private-story"]')).not.toBeNull()
    expect(mocks.original).not.toHaveBeenCalled()
    expect(mocks.sdkEntry).not.toHaveBeenCalled()
  })
  it("原文正文在没有虚拟行时独立订阅SDK读态与收藏", async () => {
    mocks.reader.active = true
    mocks.reader.target = { kind: "entry", entryId: "deep-original" }
    mocks.entry = { read: false }
    mocks.starred = false
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/all/pending"]}>
          <NativeReaderContent entryId="deep-original" />
        </MemoryRouter>,
      ),
    )
    expect(mocks.reader.syncOriginalState).toHaveBeenLastCalledWith({
      kind: "entry",
      entryId: "deep-original",
    })
    mocks.entry = { read: true }
    mocks.starred = true
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/all/pending"]}>
          <NativeReaderContent entryId="deep-original" />
        </MemoryRouter>,
      ),
    )
    expect(mocks.reader.syncOriginalState).toHaveBeenCalledTimes(2)
  })
  it("关闭AI查询后保留已选Story正文与身份", async () => {
    mocks.reader.active = false
    mocks.reader.target = { kind: "story", storyId: "private-story" }
    mocks.reader.storyId = "private-story"
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/all/pending"]}>
          <NativeReaderContent entryId="" />
        </MemoryRouter>,
      ),
    )
    expect(host.querySelector('[data-story="private-story"]')).not.toBeNull()
    expect(mocks.original).not.toHaveBeenCalled()
  })
})
