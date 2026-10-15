import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AutomationDebug } from "~/modules/action/processing-client"
import { automationDebugSchema } from "~/modules/action/processing-client"

import { AutomationDebugPanel } from "./automation-debug-panel"

const mocks = vi.hoisted(() => ({ debug: vi.fn(), model: vi.fn() }))
vi.mock("~/modules/action/processing-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/action/processing-client")>()),
  createProcessingClient: () => ({
    loadAutomationDebug: mocks.debug,
    loadModelSettings: mocks.model,
  }),
}))
vi.mock("~/modules/ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))

const snapshot = (): AutomationDebug => ({
  ownerId: "owner",
  observedAt: "2026-10-14T00:00:00Z",
  releaseVersion: 2,
  status: {
    sourceInventory: { available: 8, covered: 6, unknown: 0 },
    counts: { processed: 10, pending: 2, needsContext: 1, uncovered: 0 },
    nextRunAt: null,
    scheduleEnabled: true,
    rules: [
      {
        ruleId: "classify",
        sourceKeys: ["feed/1"],
        unknownSourceKeys: [],
        processed: 4,
        lastProcessedAt: null,
      },
    ],
  },
  rules: [
    {
      id: "classify",
      name: "分类与过滤",
      enabled: true,
      actions: ["ai_classify", "reading_decision"],
    },
  ],
  outcomes: { total: 10, hidden: 2, tagged: 6, facts: 14, policyPending: 1 },
  queue: { running: 0, pending: 0 },
  run: null,
  report: null,
  recent: [
    {
      inputSeq: 1,
      title: "最新处理原文",
      status: "hide",
      reason: "命中筛选条件",
      labels: ["科技"],
      model: "test-model",
      reused: true,
    },
  ],
})
let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.debug.mockResolvedValue(snapshot())
  mocks.model.mockResolvedValue({ provider: "codex", model: "configured-model" })
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})
const render = async (ownerId = "owner") =>
  act(async () => root.render(<AutomationDebugPanel key={ownerId} ownerId={ownerId} />))
const value = (key: string) =>
  [...host.querySelectorAll("span")].find((span) => span.textContent === key)?.nextElementSibling
    ?.textContent

// 检查正文侧栏的账号隔离、后台进度和刷新边界，不启动任何规则或模型。
describe("自动化规则调试侧栏", () => {
  it("校验调试响应，拒绝无账号快照与超量最近结果", () => {
    expect(automationDebugSchema.parse(snapshot()).ownerId).toBe("owner")
    expect(automationDebugSchema.safeParse({ ...snapshot(), ownerId: null }).success).toBe(false)
    expect(
      automationDebugSchema.safeParse({
        ...snapshot(),
        recent: Array.from({ length: 4 }, () => snapshot().recent[0]),
      }).success,
    ).toBe(false)
  })
  it("显示分类、过滤、事实、规则和最近结果，旧报告的缺失指标不补零", async () => {
    await render()
    expect(host.textContent).toContain("automation.debug.title")
    expect(value("automation.debug.tagged")).toBe("6")
    expect(value("automation.debug.hidden")).toBe("2")
    expect(value("automation.debug.facts")).toBe("14")
    expect(host.textContent).toContain("分类与过滤")
    expect(host.textContent).toContain("automation.action.ai_classify")
    expect(host.textContent).toContain("最新处理原文")
    expect(host.textContent).toContain("configured-model")
    const next = {
      ...snapshot(),
      run: {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "manual" as const,
        dedupeKey: "test",
        configRevision: 1,
        sourceKeys: ["feed/1"],
        historySince: "2026-10-01T00:00:00Z",
        timeZone: "UTC",
        scheduledFor: null,
        cutoffAt: "2026-10-14T00:00:00Z",
        status: "running" as const,
        leaseToken: "lease",
        leaseUntil: null,
        createdAt: "2026-10-14T00:00:00Z",
        startedAt: "2026-10-14T00:00:00Z",
        finishedAt: null,
        error: null,
      },
      report: {
        phase: "presentation",
        entries: { completed: 4, failures: [{ code: "processing_interrupted" }] },
        dedupe: { exactDuplicates: 1, duplicates: 2, pending: 0 },
        stories: [
          {
            created: [{ storyId: "one" }],
            updated: [],
            pending: [],
            failures: [{ reason: "model_failed" }],
          },
        ],
      },
    }
    mocks.debug.mockResolvedValue(next)
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(value("automation.debug.exact")).toBe("1")
    expect(value("automation.debug.stories_created")).toBe("1")
    expect(value("processing.report.model_calls")).toBe("processing.report.not_collected")
    expect(host.textContent).toContain("processing_interrupted")
    expect(host.textContent).toContain("model_failed")
  })

  it("隐藏时停止刷新，刷新失败明确标记旧数据", async () => {
    await render()
    const count = mocks.debug.mock.calls.length
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(mocks.debug).toHaveBeenCalledTimes(count)
    mocks.debug.mockRejectedValue(new Error("offline"))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    expect(host.textContent).toContain("automation.debug.stale")
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "processing.report.load_error",
    )
    expect(host.textContent).toContain("最新处理原文")
  })

  it("切换账号立即清空旧结果，拒绝不属于当前账号的响应", async () => {
    await render()
    mocks.debug.mockResolvedValue(snapshot())
    await render("other-owner")
    expect(host.textContent).not.toContain("最新处理原文")
    expect(host.textContent).not.toContain("configured-model")
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
})
