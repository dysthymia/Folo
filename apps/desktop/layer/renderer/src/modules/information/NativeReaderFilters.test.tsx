import type { PropsWithChildren } from "react"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NativeReaderFilterButton, NativeReaderFilters } from "./NativeReaderFilters"

const mocks = vi.hoisted(() => ({
  reader: {
    active: true,
    nativeTimeline: false,
    loading: false,
    failed: false,
    scope: { mode: "smart" },
    page: { total: 2, latestAvailable: false },
    items: [1],
    counts: { pending: 3, failed: 1, needsContext: 0 },
    refresh: vi.fn(),
  },
}))
vi.mock("./native-reader-context", () => ({ useNativeReader: () => mocks.reader }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("jotai", () => ({ useSetAtom: () => vi.fn() }))
vi.mock("~/modules/entry-column/atoms/processing-timeline", () => ({ timelineContentModeAtom: {} }))
vi.mock("@follow/components/ui/button/index.js", () => ({ ActionButton: () => null }))
vi.mock("@follow/components/ui/input/index.js", () => ({ Input: () => null }))
vi.mock("@follow/components/ui/popover/index.js", () => ({
  Popover: ({ children }: PropsWithChildren) => children,
  PopoverTrigger: () => null,
  PopoverContent: () => null,
}))
const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
afterEach(async () => {
  await act(() => root.render(null))
  mocks.reader.page.total = 2
  mocks.reader.failed = false
  mocks.reader.nativeTimeline = false
  mocks.reader.page.latestAvailable = false
})

// 验证常驻区域只承载需用户处理的状态，正常加载与后台处理不挤占条目区域。
describe("原生时间线精简提示", () => {
  it("正常有内容时不展示搜索、日期或加载进度区域", async () => {
    await act(() => root.render(<NativeReaderFilters />))
    expect(host.innerHTML).toBe("")
  })
  it("空态保留原因和查看原始条目的入口", async () => {
    mocks.reader.page.total = 0
    await act(() => root.render(<NativeReaderFilters />))
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "processing.reader.empty_pending",
    )
    expect(host.querySelector("input, select, details")).toBeNull()
  })
  it("原生双流列表隐藏 Story 空态与专属筛选", async () => {
    mocks.reader.nativeTimeline = true
    mocks.reader.page.total = 0
    await act(() =>
      root.render(
        <>
          <NativeReaderFilters />
          <NativeReaderFilterButton />
        </>,
      ),
    )
    expect(host.innerHTML).toBe("")
  })
  it("原生双流列表保留重试与应用更新，但不出现返回原始内容", async () => {
    mocks.reader.nativeTimeline = true
    mocks.reader.failed = true
    mocks.reader.page.total = 0
    mocks.reader.page.latestAvailable = true
    await act(() => root.render(<NativeReaderFilters />))
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(host.textContent).toContain("processing.generated.apply_updates")
    expect(host.textContent).not.toContain("processing.timeline_mode_original")
    expect(host.querySelector('[role="status"]')).toBeNull()
  })
  it("失败保留原生重试提示", async () => {
    mocks.reader.failed = true
    await act(() => root.render(<NativeReaderFilters />))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "processing.reader.error.request",
    )
    expect(host.querySelector("input, select")).toBeNull()
  })
})
