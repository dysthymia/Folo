// @vitest-environment jsdom
import type { ParseKeys } from "i18next"
import { createInstance } from "i18next"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LocalAutomationFeedback } from "./local-automation-feedback"
import type { ProcessingEditor } from "./processing-client"

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  model: vi.fn(),
  settings: vi.fn(),
  translate: vi.fn(),
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: mocks.translate,
    i18n: { language: "en" },
  }),
}))
vi.mock("~/modules/settings/modal/use-setting-modal-hack", () => ({
  useSettingModal: () => mocks.settings,
}))
vi.mock("../ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("./processing-client", () => ({
  createProcessingClient: () => ({
    loadAutomationStatus: mocks.status,
    loadModelSettings: mocks.model,
  }),
}))
const editor = { sources: [{ key: "feed/1", title: "实际来源" }] } as ProcessingEditor
const status = {
  sourceInventory: { available: 5, covered: 1, unknown: 0 },
  counts: { processed: 3, pending: 2, needsContext: 1, uncovered: 4 },
  nextRunAt: "2026-10-04T12:00:00+08:00",
  scheduleEnabled: true,
  rules: [
    {
      ruleId: "rule",
      sourceKeys: ["feed/1"],
      unknownSourceKeys: [],
      processed: 3,
      lastProcessedAt: null,
    },
  ],
}
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.translate.mockImplementation(
    (key: string, values?: unknown) => `${key}${values ? JSON.stringify(values) : ""}`,
  )
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  mocks.status.mockResolvedValue(status)
  mocks.model.mockResolvedValue({ provider: "qianwen", model: "actual", hasApiKey: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
describe("实际覆盖反馈", () => {
  it("模型与运行日期以真实JSX文本呈现，HTML字符仍由React安全转义", async () => {
    // 使用真实 i18next 默认转义，避免简单 t mock 掩盖双重转义问题。
    const i18n = createInstance()
    await i18n.init({
      lng: "en",
      defaultNS: "app",
      resources: {
        en: {
          app: {
            "automation.model.current": "Processing model: {{model}}",
            "automation.feedback.next_run": "Next processing: {{time}}",
            "automation.feedback.rule_coverage": "Last processed: {{time}}",
          },
        },
      },
    })
    const translate = i18n.getFixedT("en", "app")
    mocks.translate.mockImplementation(
      (key: ParseKeys<"app">, values: Record<string, unknown> = {}) => translate(key, values),
    )
    mocks.model.mockResolvedValue({
      provider: "qianwen",
      model: "actual / <b>probe</b>",
      hasApiKey: true,
    })
    mocks.status.mockResolvedValue({
      ...status,
      rules: [{ ...status.rules[0], lastProcessedAt: status.nextRunAt }],
    })
    await act(async () =>
      root.render(<LocalAutomationFeedback ownerId="owner" editor={editor} ruleId="rule" />),
    )
    const renderedDate = new Date(status.nextRunAt).toLocaleString("en")
    expect(container.textContent).toContain("Processing model: qianwen / actual / <b>probe</b>")
    expect(container.textContent).toContain(`Next processing: ${renderedDate}`)
    expect(container.textContent).toContain(`Last processed: ${renderedDate}`)
    expect(container.textContent).not.toContain("&#x2F;")
    expect(container.querySelector("b")).toBeNull()
  })
  it("使用服务端已发布范围，未发布规则不推断命中数", async () => {
    await act(async () =>
      root.render(<LocalAutomationFeedback ownerId="owner" editor={editor} ruleId="draft" />),
    )
    expect(container.textContent).toContain('"covered":1')
    expect(container.textContent).toContain("automation.feedback.rule_unpublished")
    await act(async () =>
      root.render(<LocalAutomationFeedback ownerId="owner" editor={editor} ruleId="rule" />),
    )
    expect(container.textContent).toContain('"processed":3')
    expect(container.textContent).toContain("实际来源")
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "automation.model.change")!
        .click(),
    )
    expect(mocks.settings).toHaveBeenCalledWith("ai")
  })
  it("服务不可用保持可行动提示，切账号不显示旧反馈", async () => {
    let finish!: (value: unknown) => void
    mocks.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await act(async () => root.render(<LocalAutomationFeedback ownerId="old" editor={editor} />))
    mocks.status.mockRejectedValue(new Error("offline"))
    await act(async () => root.render(<LocalAutomationFeedback ownerId="new" editor={editor} />))
    await act(async () => finish(status))
    expect(container.textContent).toContain("automation.feedback.load_error")
    expect(container.textContent).not.toContain('"covered":1')
  })
})
