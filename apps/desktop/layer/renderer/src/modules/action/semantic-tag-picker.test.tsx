import type { AutomationRule, ConditionSet, SemanticTagId } from "@follow/information-core"
import zh from "@locales/app/zh-CN.json"
import * as React from "react"
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LocalRuleActions } from "./local-rule-actions"
import { ProcessingConditionEditor } from "./processing-condition-editor"
import { SemanticTagPicker } from "./semantic-tag-picker"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; count?: number }) =>
      ((zh as Record<string, string>)[key] ?? key)
        .replace("{{name}}", values?.name ?? "")
        .replace("{{count}}", String(values?.count ?? "")),
  }),
}))

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const show = async (element: React.ReactNode) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(element))
  return container
}
const click = async (element: HTMLElement) => act(async () => element.click())
const option = (id: SemanticTagId) =>
  document.querySelector<HTMLElement>(`[cmdk-item][data-value="${id}"]`)!

function ControlledPicker({ changed }: { changed: (value: SemanticTagId[]) => void }) {
  const [value, setValue] = useState<SemanticTagId[]>([])
  return (
    <SemanticTagPicker
      value={value}
      onChange={(next) => {
        setValue(next)
        changed(next)
      }}
    />
  )
}

describe("Notion 式语义标签多选", () => {
  it("连续多选无需组合键，菜单保持打开，标签可逐项取消或清空", async () => {
    const changed = vi.fn()
    const container = await show(<ControlledPicker changed={changed} />)
    await click(container.querySelector("button")!)
    await click(option("topic:ai"))
    await click(option("topic:product"))
    expect(changed).toHaveBeenLastCalledWith(["topic:ai", "topic:product"])
    expect(document.querySelector("[cmdk-root]")).not.toBeNull()
    expect(option("topic:ai").getAttribute("aria-label")).toBe("取消选择 AI")
    await click(option("topic:ai"))
    expect(changed).toHaveBeenLastCalledWith(["topic:product"])
    await act(async () =>
      document
        .querySelector("[cmdk-input]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
    expect(document.querySelector("[cmdk-root]")).toBeNull()
    await click(container.querySelector<HTMLButtonElement>('[aria-label="移除 产品"]')!)
    expect(changed).toHaveBeenLastCalledWith([])
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="语义标签"]')!)
    await click(option("topic:blockchain"))
    await click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "清空选择",
      )!,
    )
    expect(changed).toHaveBeenLastCalledWith([])
    expect(document.querySelector("[cmdk-root]")).not.toBeNull()
  })

  it("按别名搜索并用 Enter 选择，空结果不创建未经定义的标签", async () => {
    const changed = vi.fn()
    const container = await show(<ControlledPicker changed={changed} />)
    await click(container.querySelector("button")!)
    const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    await act(async () => {
      setValue.call(input, "ＡＩ")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    // 搜索匹配名称和别名，AI 本身与 blockchain 的英文别名都可能匹配。
    expect(option("topic:ai")).not.toBeNull()
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    )
    expect(changed).toHaveBeenCalledWith(["topic:ai"])
    await act(async () => {
      setValue.call(input, "没有这样的标签")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(document.querySelectorAll("[cmdk-item]")).toHaveLength(0)
    expect(document.body.textContent).toContain("没有匹配的标签")
  })

  it("编辑条件只改变标签集合，保留运算符和置信度", async () => {
    const changed = vi.fn()
    function ConditionDraft() {
      const [value, setValue] = useState<ConditionSet>({
        anyOf: [
          {
            allOf: [
              {
                field: "entry_tag",
                operator: "not_contains_any",
                value: ["topic:ai"],
                minConfidence: 0.9,
              },
            ],
          },
        ],
      })
      return (
        <ProcessingConditionEditor
          sources={[]}
          value={value}
          onChange={(next) => {
            setValue(next)
            changed(next)
          }}
        />
      )
    }
    const container = await show(<ConditionDraft />)
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="语义标签"]')!)
    await click(option("form:tutorial"))
    expect(changed).toHaveBeenLastCalledWith({
      anyOf: [
        {
          allOf: [
            {
              field: "entry_tag",
              operator: "not_contains_any",
              value: ["topic:ai", "form:tutorial"],
              minConfidence: 0.9,
            },
          ],
        },
      ],
    })
    const selects = container.querySelectorAll("select")
    expect(selects).toHaveLength(3)
    expect(Array.from(selects).every((select) => !select.multiple)).toBe(true)
  })

  it("统一规则编辑器调整分类标签时保留其他动作", async () => {
    const changed = vi.fn()
    const actions: AutomationRule["actions"] = [
      { type: "ai_classify", tagIds: ["topic:ai"] },
      { type: "local_filter", mode: "silence" },
    ]
    const container = await show(
      <LocalRuleActions
        actions={actions}
        onChange={changed}
        sources={[]}
        tags={[]}
        listMemberships={[]}
      />,
    )
    expect(container.textContent).toContain(zh["processing.type.ai_classify"])
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="语义标签"]')!)
    await click(option("topic:product"))
    expect(changed).toHaveBeenLastCalledWith([
      { type: "ai_classify", tagIds: ["topic:ai", "topic:product"] },
      { type: "local_filter", mode: "silence" },
    ])
  })
})
