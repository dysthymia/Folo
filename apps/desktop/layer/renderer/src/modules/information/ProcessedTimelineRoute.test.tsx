import { FeedViewType } from "@follow/constants"
import { createStore, Provider } from "jotai"
import type { PropsWithChildren } from "react"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { BizRouteParams } from "~/hooks/biz/useRouteParams"
import { timelineContentModeAtom } from "~/modules/entry-column/atoms/processing-timeline"

import type { GeneratedFeedQuery } from "./generated-feed-client"
import { NativeTimelineReaderProvider } from "./ProcessedTimelineRoute"

const mocks = vi.hoisted(() => ({
  route: { view: -1, folderName: "Blockchain" } as Partial<BizRouteParams>,
  scope: null as GeneratedFeedQuery | null,
  enabled: false,
  nativeTimeline: false,
  preview: false,
}))
vi.mock("@follow/store/subscription/getter", () => ({
  getSubscriptionByFeedId: () => (mocks.preview ? undefined : {}),
}))
vi.mock("~/hooks/biz/useRouteParams", () => ({ useRouterRouteParams: () => mocks.route }))
vi.mock("~/modules/ai-chat/local-provider", () => ({ isLocalFoloHost: () => true }))
vi.mock("~/modules/app-layout/ai-enhanced-timeline", () => ({
  AIEnhancedTimelineLayout: () => null,
}))
vi.mock("./native-reader-provider", () => ({
  NativeReaderProvider: ({
    scope,
    enabled,
    nativeTimeline,
    children,
  }: PropsWithChildren<{
    scope: GeneratedFeedQuery
    enabled: boolean
    nativeTimeline: boolean
  }>) => {
    mocks.scope = scope
    mocks.enabled = enabled
    mocks.nativeTimeline = nativeTimeline
    return <>{children}</>
  },
}))

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
afterEach(async () => {
  await act(() => root.render(null))
  mocks.route = { view: -1, folderName: "Blockchain" }
  mocks.preview = false
})

// 分类范围必须保留原生跨视图语义，不能把 UI 的 All 枚举送入服务校验。
describe("原生分类阅读范围", () => {
  it.each(["processed", "original"] as const)(
    "全部的 %s 模式都保留官方全集与综述叠加",
    async (mode) => {
      mocks.route = { view: FeedViewType.All, feedId: "all", isAllFeeds: true }
      const store = createStore()
      store.set(timelineContentModeAtom, mode)
      await act(() =>
        root.render(
          <Provider store={store}>
            <MemoryRouter initialEntries={["/timeline/all/all/pending"]}>
              <NativeTimelineReaderProvider>
                <div />
              </NativeTimelineReaderProvider>
            </MemoryRouter>
          </Provider>,
        ),
      )
      expect(mocks.scope).toEqual({ mode: "stories", view: "all" })
      expect(mocks.enabled).toBe(true)
      expect(mocks.nativeTimeline).toBe(true)
    },
  )
  it.each([
    [FeedViewType.All, "all"],
    [FeedViewType.Articles, FeedViewType.Articles],
  ] as const)("视图 %s 生成有效分类范围", async (view, expectedView) => {
    mocks.route.view = view
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/folder-Blockchain/pending"]}>
          <NativeTimelineReaderProvider>
            <div />
          </NativeTimelineReaderProvider>
        </MemoryRouter>,
      ),
    )
    expect(mocks.scope).toEqual({
      mode: "stories",
      category: { view: expectedView, name: "Blockchain" },
    })
    expect(mocks.nativeTimeline).toBe(true)
    expect(mocks.enabled).toBe(true)
  })

  // 未覆盖的分类、单源、List 与 inbox 都须保留 SDK 查询，切换模式不能撤掉未处理条目。
  it.each(["processed", "original"] as const)(
    "%s 模式在所有普通范围叠加同范围综述",
    async (mode) => {
      const scopes: Array<{ route: Partial<BizRouteParams>; expected: GeneratedFeedQuery }> = [
        {
          route: { view: FeedViewType.All, folderName: "AI" },
          expected: { mode: "stories", category: { view: "all", name: "AI" } },
        },
        {
          route: { view: FeedViewType.Articles, feedId: "1234567890123456789" },
          expected: { mode: "stories", sourceKeys: ["feed/1234567890123456789"] },
        },
        {
          route: { view: FeedViewType.SocialMedia, listId: "1234567890123456789" },
          expected: { mode: "stories", sourceKeys: ["list/1234567890123456789"] },
        },
        {
          route: { view: FeedViewType.Articles, inboxId: "inbox-one" },
          expected: { mode: "stories", sourceKeys: ["inbox/inbox-one"] },
        },
        {
          route: { view: FeedViewType.Articles, feedId: "all", isAllFeeds: true },
          expected: { mode: "stories", view: FeedViewType.Articles },
        },
      ]
      const store = createStore()
      store.set(timelineContentModeAtom, mode)
      for (const { route, expected } of scopes) {
        mocks.route = route
        await act(() =>
          root.render(
            <Provider store={store}>
              <MemoryRouter initialEntries={["/timeline/all/folder-AI/pending"]}>
                <NativeTimelineReaderProvider>
                  <div />
                </NativeTimelineReaderProvider>
              </MemoryRouter>
            </Provider>,
          ),
        )
        expect(mocks.scope).toEqual(expected)
        expect(mocks.nativeTimeline).toBe(true)
        expect(mocks.enabled).toBe(true)
      }
    },
  )

  it("收藏继续使用完整收藏投影，预览不请求私人处理范围", async () => {
    mocks.route = { view: FeedViewType.All, isCollection: true }
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/all/collections/pending"]}>
          <NativeTimelineReaderProvider />
        </MemoryRouter>,
      ),
    )
    expect(mocks.scope).toEqual({ mode: "collections" })
    expect(mocks.nativeTimeline).toBe(false)
    expect(mocks.enabled).toBe(true)
    mocks.preview = true
    mocks.route = { view: FeedViewType.Articles, feedId: "1234567890123456789" }
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/0/1234567890123456789/pending"]}>
          <NativeTimelineReaderProvider />
        </MemoryRouter>,
      ),
    )
    expect(mocks.nativeTimeline).toBe(false)
    expect(mocks.enabled).toBe(false)
  })
})
