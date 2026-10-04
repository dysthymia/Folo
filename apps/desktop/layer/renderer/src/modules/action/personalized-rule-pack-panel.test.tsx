import { appendPersonalizedRulePack, createPersonalizedRulePack } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { PersonalizedRulePackPanel } from "./personalized-rule-pack-panel"
import type { ProcessingEditor } from "./processing-client"

const { save } = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ""}`,
  }),
}))
vi.mock("../ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("./processing-condition-editor", () => ({ processingButtonClass: "button" }))
vi.mock("./processing-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./processing-client")>()),
  createProcessingClient: () => ({ save }),
}))
// 旧草稿已有领域规则，新标签只出现在实时目录中；不会靠新增规则掩盖范围修复。
function fixture(): ProcessingEditor {
  const tags = [{ id: "old-ai", name: "AI-产品工具" }]
  const config = appendPersonalizedRulePack(
    {
      formatVersion: 4,
      ownerId: "owner",
      global: { markdown: "私人全局", version: 1 },
      rules: [],
    },
    createPersonalizedRulePack({ ownerId: "owner", tagCatalog: tags }),
  )
  const rule = config.rules.find((item) => item.id === "personalized:R40")!
  rule.enabled = false
  rule.actions = [{ type: "ai_transform", prompt: "私人 Prompt" }]
  return {
    revision: 4,
    config,
    sources: [],
    items: [],
    releases: [],
    capabilities: { automaticProcessing: true },
    sourceTags: [],
    listMemberships: [],
    subscriptionTags: {
      formatVersion: 1,
      revision: 2,
      tags: [...tags, { id: "new-ai", name: "AI-研究前沿" }].map((tag) => ({
        ...tag,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      })),
    },
  }
}

describe("已有个性化规则的条件差异草稿", () => {
  let root: Root, container: HTMLDivElement
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    save
      .mockReset()
      .mockImplementation(async (config, revision) => ({ config, revision: revision + 1 }))
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const saveButton = () =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("draft"),
    )!

  it("差异默认不勾选，选择后可保存新真实标签范围并保留私人内容与禁用状态", async () => {
    const editor = fixture(),
      onSaved = vi.fn()
    await act(async () =>
      root.render(
        <PersonalizedRulePackPanel editor={editor} onSaved={onSaved} onClose={vi.fn()} />,
      ),
    )
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.checked).toBe(false)
    expect(saveButton().disabled).toBe(true)
    expect(container.textContent).toContain("new-ai")
    expect(container.textContent).toContain("automation.pack.condition_added")
    await act(async () => checkbox.click())
    await act(async () => saveButton().click())
    expect(save).toHaveBeenCalledTimes(1)
    const [saved, revision] = save.mock.calls[0]! as [
      ProcessingEditor["config"],
      number,
      AbortSignal,
    ]
    const previous = editor.config.rules.find((rule) => rule.id === "personalized:R40")!
    const changed = saved.rules.find((rule) => rule.id === previous.id)!
    expect({ ...changed, when: previous.when, version: previous.version }).toEqual(previous)
    expect(changed.when).toEqual({
      anyOf: [
        { allOf: [{ field: "subscription_tag", operator: "in", value: ["old-ai", "new-ai"] }] },
      ],
    })
    expect(saved.global).toEqual(editor.config.global)
    expect(revision).toBe(4)
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it("复杂私人条件只能预览并提示原编辑器调整，切换草稿清除旧差异选择", async () => {
    const editor = fixture()
    const render = (next: ProcessingEditor) =>
      root.render(<PersonalizedRulePackPanel editor={next} onSaved={vi.fn()} onClose={vi.fn()} />)
    await act(async () => render(editor))
    await act(async () => container.querySelector<HTMLInputElement>("input")!.click())
    expect(saveButton().disabled).toBe(false)
    await act(async () => render({ ...editor, revision: editor.revision + 1 }))
    expect(container.querySelector<HTMLInputElement>("input")!.checked).toBe(false)
    expect(saveButton().disabled).toBe(true)
    const complex = structuredClone(editor)
    complex.config.rules.find((rule) => rule.id === "personalized:R40")!.when = { all: true }
    await act(async () => render(complex))
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true)
    expect(container.textContent).toContain("automation.pack.condition_manual_edit")
    expect(saveButton().disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })
})
