import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { ProcessingPresetPicker } from "./processing-preset-picker"

const { askMock } = vi.hoisted(() => ({ askMock: vi.fn() }))

vi.mock("../../components/ui/modal/stacked/hooks", () => ({
  useDialog: () => ({ ask: askMock }),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 测试保留翻译 key，确保比较区域和错误提示可被稳定断言。
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ""}`,
  }),
}))

const setValue = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set
  expect(setter).toBeDefined()
  await act(async () => {
    setter!.call(element, value)
    element.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("ProcessingPresetPicker", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    document.body.innerHTML = ""
    root = null
    container = null
    vi.clearAllMocks()
  })

  it("只在 Apply 时应用模板，参数变化只更新比较预览", async () => {
    const onApply = vi.fn()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ProcessingPresetPicker
          targets={["ai_transform"]}
          currentPrompt="当前私人 Prompt"
          onApply={onApply}
        />,
      )
    })

    const selects = container.querySelectorAll("select")
    await setValue(selects[1]!, "P01")
    expect(onApply).not.toHaveBeenCalled()
    expect(selects[1]!.selectedOptions[0]!.textContent).toContain("v1")
    expect(container.textContent).toContain("processing.preset_current")
    expect(container.textContent).toContain("当前私人 Prompt")
    expect(container.textContent).toContain("processing.preset_preview_version")

    const parameter = container.querySelector('input[type="number"]') as HTMLInputElement
    await setValue(parameter, "0")
    expect(container.textContent).toContain("processing.preset_invalid_parameters")
    expect(container.textContent).toContain("当前私人 Prompt")
    expect(onApply).not.toHaveBeenCalled()

    await setValue(parameter, "120")
    expect(container.textContent).toContain("120")
    expect(container.textContent).toContain("当前私人 Prompt")
    expect(onApply).not.toHaveBeenCalled()

    const applyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("processing.preset_apply"),
    ) as HTMLButtonElement
    await act(async () => {
      applyButton.click()
    })
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        presetRef: { id: "P01", version: 1 },
        prompt: expect.stringMatching(/^当前私人 Prompt\n\n/),
        patch: expect.objectContaining({ prompt: expect.stringMatching(/^当前私人 Prompt\n\n/) }),
      }),
    )
  })

  it("替换非空 Prompt 时二次确认，并展示保存版本到目录版本的升级", async () => {
    const onApply = vi.fn()
    const catalog = [
      {
        id: "P01" as const,
        version: 2,
        name: "新版",
        description: "新版说明",
        suggestedConditions: "范围",
        target: "ai_transform" as const,
        parameters: [],
        prompt: "新版模板",
      },
    ]
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ProcessingPresetPicker
          targets={["ai_transform"]}
          currentPrompt="私人 Prompt"
          currentPreset={{ id: "P01", version: 1 }}
          catalog={catalog}
          onApply={onApply}
        />,
      )
    })

    expect(container.textContent).toContain("processing.preset_upgrade_available")
    const mode = container.querySelectorAll("select")[2]!
    await setValue(mode, "replace")
    const applyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("processing.preset_apply"),
    )!
    await act(async () => applyButton.click())
    expect(onApply).not.toHaveBeenCalled()
    expect(askMock).toHaveBeenCalledTimes(1)
    await act(async () => askMock.mock.calls[0]![0].onConfirm())
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        presetRef: { id: "P01", version: 2 },
        prompt: "新版模板",
        patch: expect.objectContaining({ prompt: "新版模板" }),
      }),
    )
  })
})
