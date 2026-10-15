// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { DecisionsSettingsSection } from "./DecisionsSettingsSection"

const settings = {
  enabled: false,
  classificationEnabled: true,
  mode: "observe",
  threshold: 0.95,
  maxInputChars: 12000,
  maxRequestsPerRun: 20,
  dedupeObservation: { enabled: false, mode: "observe", maxPairsPerTrigger: 8 },
  hasApiKey: false,
  model: "openai/gpt-6-luna-decisions",
  endpoint: "https://openrouter.ai/api/alpha/decisions",
}
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), audit: vi.fn() }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))
vi.mock("~/modules/ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("~/modules/action/processing-client", () => ({
  createProcessingClient: () => ({
    loadDecisionsSettings: mocks.load,
    saveDecisionsSettings: mocks.save,
    loadDecisionsAudit: mocks.audit,
  }),
}))
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue(settings)
  mocks.save.mockResolvedValue({ ...settings, enabled: true, hasApiKey: true })
  mocks.audit.mockResolvedValue({ records: [] })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function inputValue(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
// 新增复核开关独立保存，不能因选择 Decisions 就默认追加另一个付费模型。
it("saves the generation recheck only after selecting its explicit checkbox", async () => {
  mocks.load.mockResolvedValue({ ...settings, enabled: true, hasApiKey: true })
  await act(async () => root.render(<DecisionsSettingsSection />))
  const label = [...container.querySelectorAll("label")].find(
    (item) => item.textContent === "automation.decisions.dedupe_fallback",
  )!
  const checkbox = label.querySelector<HTMLInputElement>("input")!
  expect(checkbox.checked).toBe(false)
  await act(async () => checkbox.click())
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "automation.decisions.save",
  )!
  await act(async () => save.click())
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      dedupeObservation: expect.objectContaining({ generationFallback: true }),
    }),
    expect.any(AbortSignal),
  )
})
it("defaults to disabled observation and submits only explicit Decisions settings, then clears the key", async () => {
  await act(async () => root.render(<DecisionsSettingsSection />))
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(checkbox.checked).toBe(false)
  expect(container.querySelectorAll<HTMLSelectElement>("select")[0]!.value).toBe("generation")
  expect(container.querySelectorAll<HTMLSelectElement>("select")[1]!.value).toBe("observe")
  expect(mocks.save).not.toHaveBeenCalled()
  await act(async () => checkbox.click())
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "automation.decisions.save",
  )!
  expect(save.disabled).toBe(true)
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!
  await inputValue(key, "fixture-private-key")
  await act(async () => save.click())
  expect(mocks.save).toHaveBeenCalledWith(
    {
      enabled: true,
      classificationEnabled: true,
      mode: "observe",
      threshold: 0.95,
      maxInputChars: 12000,
      maxRequestsPerRun: 20,
      dedupeObservation: { enabled: false, mode: "observe", maxPairsPerTrigger: 8 },
      apiKey: "fixture-private-key",
    },
    expect.any(AbortSignal),
  )
  expect(key.value).toBe("")
})
it.each(["generation", "observe", "apply"])(
  "saves %s dedupe independently of the tag model choice",
  async (choice) => {
    mocks.load.mockResolvedValue({ ...settings, enabled: true, hasApiKey: true })
    await act(async () => root.render(<DecisionsSettingsSection />))
    const classification =
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!
    const dedupe = container.querySelector<HTMLSelectElement>("select")!
    await act(async () => classification.click())
    await act(async () => {
      dedupe.value = choice
      dedupe.dispatchEvent(new Event("change", { bubbles: true }))
    })
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "automation.decisions.save",
    )!
    await act(async () => save.click())
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        classificationEnabled: false,
        mode: "observe",
        dedupeObservation: {
          enabled: choice !== "generation",
          mode: choice === "apply" ? "apply" : "observe",
          maxPairsPerTrigger: 8,
        },
      }),
      expect.any(AbortSignal),
    )
  },
)
it("distinguishes unknown billing from known zero and exposes raw probability audit", async () => {
  const record = {
    inputSeq: 42,
    contentVersion: "v1",
    generation: 1,
    attempted: true,
    status: "success",
    code: null,
    model: settings.model,
    provider: "OpenAI",
    usage: { input_tokens: 10, output_tokens: 0 },
    tagIds: ["topic:ai"],
    answers: { tag_0: { type: "noul", noul: 0.98 } },
  }
  mocks.audit.mockResolvedValue({
    records: [
      record,
      { ...record, inputSeq: 43, usage: { input_tokens: 10, output_tokens: 0, cost: 0 } },
    ],
  })
  await act(async () => root.render(<DecisionsSettingsSection />))
  expect(container.textContent).toContain('"requests":2')
  expect(container.textContent).toContain('"unknown":1')
  expect(container.textContent).toContain('"noul": 0.98')
})
it("audit failure does not block disabling settings and does not display zero-cost success", async () => {
  mocks.load.mockResolvedValue({ ...settings, enabled: true, hasApiKey: true })
  mocks.audit.mockRejectedValue(new Error("offline audit"))
  mocks.save.mockResolvedValue({ ...settings, enabled: false, hasApiKey: true })
  await act(async () => root.render(<DecisionsSettingsSection />))
  expect(container.textContent).toContain("automation.decisions.audit_error")
  expect(container.textContent).not.toContain("automation.decisions.cost")
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await act(async () => checkbox.click())
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "automation.decisions.save",
  )!
  await act(async () => save.click())
  expect(mocks.save.mock.calls[0]![0]).toMatchObject({ enabled: false })
  expect(mocks.save.mock.calls[0]![0]).not.toHaveProperty("apiKey")
  expect(container.textContent).toContain("automation.decisions.saved")
})
it("invalid limits are explained and failed saves clear the key without claiming success", async () => {
  await act(async () => root.render(<DecisionsSettingsSection />))
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "automation.decisions.save",
  )!
  const limit = container.querySelector<HTMLInputElement>('input[type="number"][max="100"]')!
  await inputValue(limit, "1.5")
  expect(save.disabled).toBe(true)
  expect(container.textContent).toContain("automation.decisions.invalid_numbers")
  await inputValue(limit, "5")
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!
  await inputValue(key, "offline-key")
  mocks.save.mockRejectedValue(new Error("transport failure"))
  await act(async () => save.click())
  expect(container.textContent).toContain("automation.decisions.save_error")
  expect(container.textContent).not.toContain("automation.decisions.saved")
  expect(key.value).toBe("")
})

it("dedupe observation is a separate opt-in with its own pair limit and keeps the tag mode", async () => {
  mocks.load.mockResolvedValue({ ...settings, enabled: true, hasApiKey: true, mode: "apply" })
  await act(async () => root.render(<DecisionsSettingsSection />))
  const observation = container.querySelector<HTMLSelectElement>("select")!
  expect(observation.value).toBe("generation")
  await act(async () => {
    observation.value = "observe"
    observation.dispatchEvent(new Event("change", { bubbles: true }))
  })
  const limit = container.querySelector<HTMLInputElement>('input[type="number"][max="24"]')!
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "automation.decisions.save",
  )!
  await inputValue(limit, "25")
  expect(save.disabled).toBe(true)
  await inputValue(limit, "2")
  await act(async () => save.click())
  expect(mocks.save.mock.calls[0]![0]).toMatchObject({
    mode: "apply",
    dedupeObservation: { enabled: true, mode: "observe", maxPairsPerTrigger: 2 },
  })
  expect(mocks.save.mock.calls[0]![0]).not.toHaveProperty("apiKey")
})

it("shows dedupe disagreements separately and combines costs without treating pending usage as free", async () => {
  mocks.audit.mockResolvedValue({
    records: [],
    dedupeRecords: [
      {
        evidenceKey: "hash",
        inputs: [{ seq: 1 }, { seq: 2 }],
        comparison: "disagree",
        attempted: true,
        status: "decided",
        code: null,
        usage: { input_tokens: 10, output_tokens: 0, cost: null },
        assessment: { coverage: "different", confidence: 0.99 },
      },
    ],
  })
  await act(async () => root.render(<DecisionsSettingsSection />))
  expect(container.textContent).toContain('"disagree":1')
  expect(container.textContent).toContain('"unknown":1')
  expect(container.textContent).toContain('"coverage": "different"')
  expect(container.textContent).toContain("automation.decisions.comparison_disagree")
})

// 已保存的 85% 必须显示为合法输入，不能被表单禁用保存。
it("allows saving an 85 percent threshold", async () => {
  mocks.load.mockResolvedValue({ ...settings, enabled: true, hasApiKey: true, threshold: 0.85 })
  await act(async () => root.render(<DecisionsSettingsSection />))
  const label = [...container.querySelectorAll("label")].find(
    (item) => item.textContent === "automation.decisions.threshold",
  )!
  expect(label.querySelector<HTMLInputElement>("input")!.min).toBe("0.85")
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "automation.decisions.save",
  )!
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({ threshold: 0.85 }),
    expect.any(AbortSignal),
  )
})
