import { FeedViewType } from "@follow/constants"
import type { MouseEventHandler, PropsWithChildren } from "react"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { GeneratedReaderItem } from "./generated-feed-client"
import { NativeReaderRow } from "./NativeReaderRow"

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  mutate: vi.fn(),
  original: vi.fn(),
  sync: vi.fn(),
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("~/atoms/settings/general", () => ({ useGeneralSettingKey: () => false }))
vi.mock("@follow/store/entry/hooks", () => ({ useEntry: () => ({ read: true }) }))
vi.mock("@follow/store/collection/hooks", () => ({ useIsEntryStarred: () => false }))
vi.mock("@follow/components/ui/button/index.js", () => ({
  ActionButton: ({
    children,
    onClick,
    tooltip,
  }: PropsWithChildren<{ onClick?: MouseEventHandler<HTMLButtonElement>; tooltip?: string }>) => (
    <button onClick={onClick} aria-label={tooltip}>
      {children}
    </button>
  ),
}))
vi.mock("~/components/ui/datetime", () => ({ RelativeTime: () => <span>time</span> }))
vi.mock("~/modules/entry-column/styles", () => ({ readableContentMaxWidth: "" }))
vi.mock("~/modules/entry-column/item", () => ({
  EntryItem: (props: { entryId: string; view: number }) => {
    mocks.original(props)
    return <div data-original-id={props.entryId} />
  },
}))
vi.mock("./native-reader-context", () => ({
  useNativeReader: () => ({
    target: null,
    selectItem: mocks.select,
    mutateItem: mocks.mutate,
    syncOriginalState: mocks.sync,
  }),
}))
const common = {
  id: "test-id",
  title: "标题",
  summary: "正文摘要",
  publishedAt: "2026-10-04T00:00:00Z",
  read: true,
  collected: false,
  materialCount: 2,
  topics: [],
}
const story: GeneratedReaderItem = {
  ...common,
  kind: "story",
  origin: "generated",
  storyId: "private-story",
  generatedFeedId: "generated:events",
  revision: 1,
  substantiveRevision: 1,
  updatedAt: common.publishedAt,
  hasImportantUpdate: false,
  sourceKeys: ["feed/official"],
}
const entry: GeneratedReaderItem = {
  ...common,
  kind: "entry",
  origin: "original",
  sourceKey: "feed/official",
  inputSeq: null,
  decisionId: null,
  storyIds: [],
  view: FeedViewType.SocialMedia,
}
const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
afterEach(async () => {
  await act(() => root.render(null))
  vi.clearAllMocks()
})

// 跨身份操作必须测组件边界，不能靠 URL 或 API 成功状态推断没有误用 SDK。
describe("原生阅读行适配", () => {
  it("原文采用当前列表view以保留全部列表单行密度，官方entryId保持不变", async () => {
    await act(() => root.render(<NativeReaderRow item={entry} view={FeedViewType.All} />))
    expect(mocks.original).toHaveBeenCalledWith({
      entryId: "test-id",
      view: FeedViewType.All,
    })
  })
  it("点击综述仅选择明确Story目标，不渲染官方EntryItem", async () => {
    await act(() => root.render(<NativeReaderRow item={story} view={FeedViewType.All} />))
    await act(() =>
      host.querySelector<HTMLButtonElement>("article button:not([aria-label])")!.click(),
    )
    expect(mocks.select).toHaveBeenCalledWith(story)
    expect(mocks.original).not.toHaveBeenCalled()
  })
  it("综述保持单行摘要和右侧时间，未读点使用原生紧凑行外壳", async () => {
    await act(() =>
      root.render(<NativeReaderRow item={{ ...story, read: false }} view={FeedViewType.All} />),
    )
    const frame = host.querySelector("article .group")!
    expect(frame.className).toContain("py-2")
    expect(frame.className).toContain("before:top-[14px]")
    expect(host.querySelector("p, .line-clamp-2")).toBeNull()
    expect(frame.lastElementChild?.textContent).toBe("time")
  })
  it("综述收藏按钮不触发行选择，也不把成员原文标读", async () => {
    await act(() => root.render(<NativeReaderRow item={story} view={FeedViewType.All} />))
    await act(() => host.querySelector<HTMLButtonElement>("button[aria-label]")!.click())
    expect(mocks.mutate).toHaveBeenCalledWith(story, { collected: true })
    expect(mocks.select).not.toHaveBeenCalled()
    expect(mocks.original).not.toHaveBeenCalled()
  })
})
