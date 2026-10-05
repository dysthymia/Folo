// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LocalProcessingModelSection } from "./LocalProcessingModelSection"

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  catalog: vi.fn(),
  invalidate: vi.fn(),
  owner: "owner",
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}))
vi.mock("~/modules/ai-chat/local-provider", () => ({
  getOneTimeToken: vi.fn(),
  isLocalFoloHost: () => true,
}))
vi.mock("~/modules/action/processing-client", () => ({
  createProcessingClient: () => ({
    loadModelSettings: mocks.load,
    saveModelSettings: mocks.save,
    loadModelCatalog: mocks.catalog,
  }),
}))
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.owner = "owner"
  mocks.load.mockResolvedValue({ provider: "qianwen", model: "actual-model", hasApiKey: false })
  mocks.save.mockResolvedValue({ provider: "qianwen", model: "actual-model", hasApiKey: true })
  mocks.catalog.mockResolvedValue({
    models: [
      {
        id: "codex-one",
        displayName: "Codex One",
        description: "",
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      },
    ],
    source: "rpc",
    fetchedAt: "2026-10-04T00:00:00.000Z",
    stale: false,
    available: true,
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
// 按真实标签定位字段，避免增加地址输入框后用字段顺序误验模型值。
const control = <T extends HTMLElement>(key: string) =>
  [...container.querySelectorAll("label")]
    .find((label) => label.querySelector("span")?.textContent === key)!
    .querySelector("input,select") as T
async function inputValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value)
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    )
  })
}
const saveButton = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "information.model_settings.save",
  )!
describe("原AI设置中的实际执行配置", () => {
  it("读取真实后台模型，保存密钥后清空输入并刷新本机对话缓存", async () => {
    await act(async () => root.render(<LocalProcessingModelSection />))
    expect(container.textContent).toContain("automation.model.boundary")
    expect(control<HTMLInputElement>("information.model_settings.model").value).toBe("actual-model")
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "test-key",
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "information.model_settings.save")!
        .click(),
    )
    expect(mocks.save).toHaveBeenCalledWith(
      { provider: "qianwen", model: "actual-model", apiKey: "test-key" },
      expect.any(AbortSignal),
    )
    expect(input.value).toBe("")
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["localAISettings"] })
  })
  it("切账号取消旧保存，迟到结果不覆盖新账号模型", async () => {
    let finish!: (value: unknown) => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await act(async () => root.render(<LocalProcessingModelSection />))
    mocks.owner = "second-owner"
    mocks.load.mockResolvedValue({ provider: "codex", model: "second-model", hasApiKey: false })
    await act(async () => root.render(<LocalProcessingModelSection />))
    await act(async () => finish({ provider: "qianwen", model: "old-model", hasApiKey: true }))
    expect(control<HTMLSelectElement>("automation.model.codex_model").value).toBe("second-model")
  })

  it("选择 Codex 列表模型后只在显式保存时提交模型，不附加 API 密钥和地址", async () => {
    mocks.save.mockResolvedValue({ provider: "codex", model: "codex-one", hasApiKey: false })
    await act(async () => root.render(<LocalProcessingModelSection />))
    expect(mocks.catalog).not.toHaveBeenCalled()
    await inputValue(control<HTMLSelectElement>("automation.model.source"), "codex")
    expect(control<HTMLSelectElement>("automation.model.codex_model").value).toBe("codex-one")
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
    await act(async () => saveButton().click())
    expect(mocks.save).toHaveBeenCalledWith(
      { provider: "codex", model: "codex-one", reasoningEffort: "low" },
      expect.any(AbortSignal),
    )
  })

  it("新目录模型可选，保存推理强度且换模型时只保留受支持的强度", async () => {
    const full = ["low", "medium", "high", "xhigh", "max", "ultra"]
    mocks.load.mockResolvedValue({ provider: "codex", model: "gpt-6.1-sol", hasApiKey: false })
    mocks.catalog.mockResolvedValue({
      models: [
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ].map((id) => ({
        id,
        displayName: id,
        description: "",
        defaultReasoningEffort: "medium",
        reasoningEfforts: id === "gpt-6-luna" ? full.slice(0, -1) : full,
      })),
      source: "rpc",
      stale: false,
      available: true,
      fetchedAt: "2026-10-04T00:00:00Z",
    })
    mocks.save.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({ ...input, hasApiKey: false }),
    )
    await act(async () => root.render(<LocalProcessingModelSection />))
    const models = control<HTMLSelectElement>("automation.model.codex_model")
    expect(models.options).toHaveLength(8)
    const effort = control<HTMLSelectElement>("automation.model.reasoning_effort")
    // 旧配置未选过强度时沿用 low；用户明确选择 ultra 后才提交。
    expect(effort.value).toBe("low")
    await inputValue(effort, "ultra")
    expect(mocks.save).not.toHaveBeenCalled()
    await act(async () => saveButton().click())
    expect(mocks.save).toHaveBeenLastCalledWith(
      { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "ultra" },
      expect.any(AbortSignal),
    )
    await inputValue(models, "gpt-6-luna")
    expect([...effort.options].map((option) => option.value)).not.toContain("ultra")
    expect(effort.value).toBe("medium")
    await act(async () => saveButton().click())
    expect(mocks.save).toHaveBeenLastCalledWith(
      { provider: "codex", model: "gpt-6-luna", reasoningEffort: "medium" },
      expect.any(AbortSignal),
    )
  })

  it("保存强度已不受目录模型支持时要求重新选择，不能静默替换", async () => {
    mocks.load.mockResolvedValue({
      provider: "codex",
      model: "codex-one",
      reasoningEffort: "ultra",
      hasApiKey: false,
    })
    await act(async () => root.render(<LocalProcessingModelSection />))
    expect(control<HTMLSelectElement>("automation.model.reasoning_effort").value).toBe("ultra")
    expect(container.textContent).toContain("automation.model.effort_unavailable")
    expect(saveButton().disabled).toBe(true)
    await inputValue(control<HTMLSelectElement>("automation.model.reasoning_effort"), "low")
    expect(saveButton().disabled).toBe(false)
  })

  it("换自定义地址不能复用千问旧密钥，补充新密钥后提交归一化地址", async () => {
    mocks.load.mockResolvedValue({ provider: "qianwen", model: "actual-model", hasApiKey: true })
    mocks.save.mockResolvedValue({
      provider: "openai-compatible",
      model: "custom-one",
      baseUrl: "https://models.example.test/v1",
      hasApiKey: true,
    })
    await act(async () => root.render(<LocalProcessingModelSection />))
    expect(saveButton().disabled).toBe(false)
    await inputValue(
      control<HTMLInputElement>("automation.model.base_url"),
      "https://models.example.test/v1/",
    )
    await inputValue(control<HTMLInputElement>("information.model_settings.model"), "custom-one")
    expect(saveButton().disabled).toBe(true)
    await inputValue(control<HTMLInputElement>("information.model_settings.api_key"), "custom-key")
    await act(async () => saveButton().click())
    expect(mocks.save).toHaveBeenCalledWith(
      {
        provider: "openai-compatible",
        model: "custom-one",
        baseUrl: "https://models.example.test/v1",
        apiKey: "custom-key",
      },
      expect.any(AbortSignal),
    )
    expect(control<HTMLInputElement>("information.model_settings.api_key").value).toBe("")
  })

  it("目录失败不影响已有自定义配置，来回切换保留模型与地址草稿", async () => {
    mocks.load.mockResolvedValue({ provider: "qianwen", model: "actual-model", hasApiKey: true })
    mocks.catalog.mockRejectedValue(new Error("unavailable"))
    await act(async () => root.render(<LocalProcessingModelSection />))
    await inputValue(control<HTMLInputElement>("information.model_settings.model"), "custom-draft")
    await inputValue(control<HTMLSelectElement>("automation.model.source"), "codex")
    expect(container.textContent).toContain("automation.model.catalog_unavailable")
    expect(saveButton().disabled).toBe(true)
    await inputValue(control<HTMLSelectElement>("automation.model.source"), "custom")
    expect(control<HTMLInputElement>("information.model_settings.model").value).toBe("custom-draft")
    expect(saveButton().disabled).toBe(false)
    await act(async () => saveButton().click())
    expect(mocks.save).toHaveBeenCalledWith(
      { provider: "qianwen", model: "custom-draft" },
      expect.any(AbortSignal),
    )
  })
})
