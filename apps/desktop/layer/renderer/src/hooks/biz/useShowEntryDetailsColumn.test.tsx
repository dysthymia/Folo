import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useShowEntryDetailsColumn } from "./useShowEntryDetailsColumn"

const mocks = vi.hoisted(() => ({ debug: false, wide: true, fixedAI: false }))
vi.mock("@follow/constants", () => ({ getView: () => ({ wideMode: mocks.wide }) }))
vi.mock("~/hooks/biz/useRouteParams", () => ({ useRouteParamsSelector: () => ({ view: 1 }) }))
vi.mock("~/modules/action/use-automation-debug", () => ({
  useAutomationDebugEnabled: () => mocks.debug,
}))
vi.mock("~/atoms/settings/ai", () => ({
  AIChatPanelStyle: { Floating: "floating", Fixed: "fixed" },
  useAIChatPanelStyle: () => (mocks.fixedAI ? "fixed" : "floating"),
  useAIPanelVisibility: () => mocks.fixedAI,
}))
const host = document.createElement("div")
const root = createRoot(host)
function Probe() {
  return <div data-reader-column={useShowEntryDetailsColumn()} />
}
afterEach(async () => {
  await act(() => root.render(null))
  mocks.debug = false
  mocks.wide = true
  mocks.fixedAI = false
})

// 宽列表也能访问调试侧栏，同时不抢占用户明确打开的固定 AI 面板。
describe("调试侧栏布局资格", () => {
  it("关闭时保留宽列表；启用时保留正文侧栏", async () => {
    await act(() => root.render(<Probe />))
    expect(host.firstElementChild?.getAttribute("data-reader-column")).toBe("false")
    mocks.debug = true
    await act(() => root.render(<Probe />))
    expect(host.firstElementChild?.getAttribute("data-reader-column")).toBe("true")
  })
  it("固定 AI 面板打开时仍让出原正文侧栏", async () => {
    mocks.debug = true
    mocks.fixedAI = true
    await act(() => root.render(<Probe />))
    expect(host.firstElementChild?.getAttribute("data-reader-column")).toBe("false")
  })
})
