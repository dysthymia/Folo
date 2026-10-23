import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { Link, MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useRouterRouteParams } from "./useRouteParams"

vi.mock("@follow/store/list/getters", () => ({ getListById: () => undefined }))
vi.mock("@follow/components/atoms/route.js", () => ({
  // 模拟尚未提交的新路由：只读原子仍停在上一页。
  useReadonlyRoute: () => ({
    params: { timelineId: "articles", feedId: "old-feed", entryId: "old-entry" },
    searchParams: new URLSearchParams(),
  }),
  useReadonlyRouteSelector: vi.fn(),
  getReadonlyRoute: vi.fn(),
}))

function PersistentReaderLayout() {
  const params = useRouterRouteParams()
  const location = useLocation()
  return (
    <>
      <output data-testid="scope">
        {JSON.stringify({ pathname: location.pathname, ...params })}
      </output>
      <Link to="/events">综述</Link>
      <Link to="/timeline/all/collections/pending">收藏</Link>
      <Outlet />
    </>
  )
}

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
afterEach(async () => {
  await act(() => root.render(null))
})

describe("持续挂载的阅读路由快照", () => {
  it("在父布局中读取当前子路由参数，切换综述和收藏不依赖旧原子的提交", async () => {
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={["/timeline/articles/source/entry"]}>
          <Routes>
            <Route element={<PersistentReaderLayout />}>
              <Route path="/events" element={<span>事件列表</span>} />
              <Route
                path="/timeline/:timelineId/:feedId/:entryId"
                element={<span>普通列表</span>}
              />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    )
    const scope = () => JSON.parse(host.querySelector('[data-testid="scope"]')?.textContent ?? "{}")
    expect(scope()).toMatchObject({ feedId: "source", entryId: "entry" })
    await act(() => host.querySelector<HTMLAnchorElement>('a[href="/events"]')?.click())
    expect(scope()).toMatchObject({ pathname: "/events", isCollection: false })
    expect(scope().entryId).toBeUndefined()
    await act(() =>
      host.querySelector<HTMLAnchorElement>('a[href="/timeline/all/collections/pending"]')?.click(),
    )
    expect(scope()).toMatchObject({
      pathname: "/timeline/all/collections/pending",
      isCollection: true,
      feedId: "collections",
      entryId: "pending",
    })
  })
})
