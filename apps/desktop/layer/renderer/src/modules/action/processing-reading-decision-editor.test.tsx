// @vitest-environment jsdom
import { semanticTagIds } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

import { ProcessingActionEditor } from "./processing-action-editor"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./processing-preset-picker", () => ({ ProcessingPresetPicker: () => null }))

describe("reading decision editor", () => {
  it("分类动作可单独添加并选择标签，不混入阅读或综述动作", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()
    const render = async (actions: Parameters<typeof ProcessingActionEditor>[0]["actions"]) =>
      act(async () =>
        root.render(
          <ProcessingActionEditor
            actions={actions}
            onChange={onChange}
            sources={[]}
            tags={[]}
            listMemberships={[]}
          />,
        ),
      )
    await render([])
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "processing.add_classify",
    )!
    await act(async () => add.click())
    const actions = onChange.mock.lastCall![0]
    expect(actions).toHaveLength(1)
    expect(actions[0].type).toBe("ai_classify")
    expect(actions[0].tagIds).toEqual([...semanticTagIds])
    await render(actions)
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="processing.semantic_picker.remove"]',
    )!
    await act(async () => remove.click())
    expect(onChange.mock.lastCall![0][0].tagIds).toEqual(semanticTagIds.slice(1))
    await act(async () => root.unmount())
    container.remove()
  })
  it("分别编辑可见性和参与综述，清除显式值保留继承语义", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()
    await act(async () =>
      root.render(
        <ProcessingActionEditor
          actions={[
            { type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" },
          ]}
          onChange={onChange}
          sources={[]}
          tags={[]}
          listMemberships={[]}
        />,
      ),
    )
    const [visibility, aggregation] = container.querySelectorAll("select")
    expect(visibility!.value).toBe("hide")
    expect(aggregation!.value).toBe("deny")
    await act(async () => {
      visibility!.value = ""
      visibility!.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith([
      { type: "reading_decision", aggregationEligibility: "deny" },
    ])
    await act(async () => {
      aggregation!.value = "allow"
      aggregation!.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith([
      { type: "reading_decision", visibility: "hide", aggregationEligibility: "allow" },
    ])
    await act(async () => root.unmount())
    container.remove()
  })
})
