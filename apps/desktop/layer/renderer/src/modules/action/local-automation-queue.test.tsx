import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { LocalAutomationQueue } from "./local-automation-queue"

const { loadRuns } = vi.hoisted(() => ({ loadRuns: vi.fn() }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))
vi.mock("../ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("./processing-client", () => ({ createProcessingClient: () => ({ loadRuns }) }))
const run = (id: string) => ({
  id,
  kind: "manual",
  dedupeKey: "manual:test",
  configRevision: 1,
  sourceKeys: ["feed/1"],
  historySince: "2026-01-01T00:00:00.000Z",
  timeZone: "UTC",
  scheduledFor: null,
  cutoffAt: "2026-01-02T00:00:00.000Z",
  status: "running",
  leaseToken: "lease",
  leaseUntil: "2026-01-02T00:30:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
  startedAt: "2026-01-02T00:00:02.000Z",
  finishedAt: null,
  error: null,
})
const data = (id: string, completed: number) => ({
  runs: [run(id)],
  reports: [{ triggerId: id, report: { entries: { completed } } }],
})

describe("自动化页的处理队列", () => {
  let root: Root, container: HTMLDivElement
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    loadRuns.mockReset()
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  it("真实报告连接到批次详情，手动刷新更新已发布结果", async () => {
    loadRuns.mockResolvedValueOnce(data("run", 2)).mockResolvedValueOnce(data("run", 8))
    await act(async () => root.render(<LocalAutomationQueue ownerId="owner" />))
    expect(container.querySelector("details")?.open).toBe(true)
    const completed = () =>
      [...container.querySelectorAll("dt")].find(
        (item) => item.textContent === "processing.report.completed",
      )?.nextElementSibling?.textContent
    expect(completed()).toBe("2")
    await act(async () => container.querySelector("button")!.click())
    expect(completed()).toBe("8")
    expect(loadRuns).toHaveBeenCalledTimes(2)
  })
  it("切账号取消旧请求且隐藏旧报告，晚到数据不能覆盖新账号", async () => {
    let resolveOld: (value: ReturnType<typeof data>) => void = () => {}
    loadRuns
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        }),
      )
      .mockResolvedValueOnce(data("new", 9))
    await act(async () => root.render(<LocalAutomationQueue ownerId="old" />))
    const oldSignal = loadRuns.mock.calls[0]![0] as AbortSignal
    await act(async () => root.render(<LocalAutomationQueue ownerId="new" />))
    expect(oldSignal.aborted).toBe(true)
    await act(async () => resolveOld(data("old", 777)))
    expect(container.textContent).not.toContain("777")
    await act(async () => root.render(<LocalAutomationQueue ownerId={null} />))
    expect(container.textContent).toBe("")
  })
  it("后台页面不轮询，返回可见时刷新，之后每分钟更新", async () => {
    vi.useFakeTimers()
    loadRuns.mockResolvedValue(data("run", 1))
    await act(async () => root.render(<LocalAutomationQueue ownerId="owner" />))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      vi.advanceTimersByTime(60_000)
    })
    expect(loadRuns).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    expect(loadRuns).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(loadRuns).toHaveBeenCalledTimes(3)
  })
})
