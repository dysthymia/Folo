import { FeedViewType } from "@follow/constants"
import { queryClientContext } from "@follow/store/context"
import { entrySyncServices } from "@follow/store/entry/store"
import { unreadSyncService } from "@follow/store/unread/store"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, expect, it, vi } from "vitest"

import { useEntriesByView } from "./useEntriesByView"

vi.mock("~/hooks/biz/useRouteParams", () => ({
  useRouteParams: () => ({ feedId: "all", view: FeedViewType.Articles }),
}))
vi.mock("~/hooks/biz/useFeature", () => ({ useFeature: () => false }))
vi.mock("./useIsPreviewFeed", () => ({ useIsPreviewFeed: () => false }))
vi.mock("~/atoms/settings/general", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/atoms/settings/general")>()),
  useGeneralSettingKey: (key: string) => key === "unreadOnly",
}))
vi.mock("~/atoms/settings/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/atoms/settings/ai")>()),
  useAISettingKey: () => false,
}))
vi.mock("~/modules/information/native-reader-context", () => ({ useNativeReader: () => null }))
vi.mock("~/modules/information/use-list-load-processing", () => ({
  useListLoadProcessing: () => {},
}))
vi.mock("~/modules/information/processing-role-client", () => ({
  useServiceProcessingRoles: () => {},
}))

const host = document.createElement("div")
const root = createRoot(host)
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
// 真实查询刷新会修剪共享客户端的分页缓存，测试与界面共用同一实例。
queryClientContext.provide(client)
let entries: ReturnType<typeof useEntriesByView>
function Probe() {
  entries = useEntriesByView({})
  return null
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(() => root.render(null))
  client.clear()
  vi.restoreAllMocks()
})

it("首屏网络失败后结束加载保护，刷新重试远程查询并恢复后续分页", async () => {
  const failure = new TypeError("Failed to fetch")
  // 使用真实查询生命周期复现失败；只替换网络边界，避免占位结果掩盖错误。
  const response = (id: string, hour: number) =>
    ({
      data: [
        {
          entries: { id, publishedAt: `2026-10-10T0${hour}:00:00.000Z` },
          feeds: { id: "source", type: "feed" },
        },
      ],
    }) as unknown as Awaited<ReturnType<typeof entrySyncServices.fetchEntries>>
  const fetch = vi
    .spyOn(entrySyncServices, "fetchEntries")
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(response("first", 2))
    .mockResolvedValueOnce(response("second", 1))
  // 校准沿用同步服务新入口，避免测试发起真实未读请求。
  vi.spyOn(unreadSyncService, "refresh").mockResolvedValue(undefined)
  vi.spyOn(entrySyncServices, "fetchEntryContentByStream").mockResolvedValue(undefined)

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  await act(async () => {
    await vi.waitFor(() => expect(entries.error).toBe(failure))
  })
  expect(entries.type).toBe("local")
  expect(entries.isLoading).toBe(false)
  expect(entries.isFetching).toBe(false)

  // 即便正在展示本地缓存，刷新也必须调用远程 refetch，而不是只重置本地页码。
  await act(async () => {
    await entries.refetch()
  })
  await act(async () => {
    await vi.waitFor(() => expect(entries.type).toBe("remote"))
  })
  expect(entries.entriesIds).toEqual(["first"])
  expect(entries.hasNextPage).toBe(true)
  expect(entries.error).toBeNull()

  await act(async () => {
    await entries.fetchNextPage()
  })
  await act(async () => {
    await vi.waitFor(() => expect(entries.entriesIds).toEqual(["first", "second"]))
  })
  expect(fetch).toHaveBeenLastCalledWith(
    expect.objectContaining({ pageParam: "2026-10-10T02:00:00.000Z" }),
  )
  expect(entries.isLoading).toBe(false)
  expect(entries.isFetchingNextPage).toBe(false)
})
