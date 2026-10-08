import type { RuleSet } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { LocalAutomationPreferences } from "./local-automation-preferences"
import type { EffectiveProcessing, ProcessingEditor, RuleActivation } from "./processing-client"

const mocks = vi.hoisted(() => ({
  client: {
    loadSchedule: vi.fn(),
    activateGlobal: vi.fn(),
    saveSchedule: vi.fn(),
    activateRule: vi.fn(),
    save: vi.fn(),
    publish: vi.fn(),
  },
  changed: vi.fn(),
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("./processing-client", () => ({ createProcessingClient: () => mocks.client }))
vi.mock("./local-automation-events", () => ({ notifyLocalAutomationChanged: mocks.changed }))
vi.mock("./processing-condition-editor", () => ({
  processingButtonClass: "",
  processingInputClass: "",
}))
vi.mock("./processing-export-controls", () => ({ ProcessingExportControls: () => null }))

const config = (markdown: string): RuleSet => ({
  formatVersion: 4,
  ownerId: "owner",
  global: { version: 1, markdown },
  rules: [
    {
      id: "unreviewed-draft",
      name: "尚未审核的模板",
      ownerId: "owner",
      enabled: true,
      version: 1,
      order: 0,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "ai_transform", prompt: "保留原文事实" }],
    },
  ],
})
const editorFor = (markdown: string): ProcessingEditor => ({
  revision: 2,
  config: config(markdown),
  sources: [],
  sourceInventoryKnown: true,
  items: [],
  releases: [],
  capabilities: { automaticProcessing: true },
  subscriptionTags: { formatVersion: 1, revision: 0, tags: [] },
  sourceTags: [],
  listMemberships: [],
})
const effectiveFor = (markdown: string): EffectiveProcessing => ({
  revision: 2,
  releaseVersion: 1,
  config: { ...config(markdown), rules: [] },
  sources: [],
  sourceInventoryKnown: true,
  subscriptionTags: { formatVersion: 1, revision: 0, tags: [] },
  sourceTags: [],
  listMemberships: [],
})

describe("公共要求草稿独立启用", () => {
  let root: Root
  let container: HTMLDivElement
  const onSaved = vi.fn()
  const onDirty = vi.fn()
  const onBusy = vi.fn()
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.client.loadSchedule.mockResolvedValue({ revision: 0, config: null })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async (editor: ProcessingEditor, effective: EffectiveProcessing | null) => {
    await act(async () => {
      root.render(
        <LocalAutomationPreferences
          editor={editor}
          effective={effective}
          onSaved={onSaved}
          onDirty={onDirty}
          onBusy={onBusy}
          migrationRequired={false}
          onHistory={vi.fn()}
        />,
      )
    })
  }
  const saveButton = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "automation.editor.save_global",
    )!

  it("展示持久化G00草稿，仅启用公共正文并传回完整发布结果", async () => {
    const markdown = "原有私人要求\n\nG00：区分事实、来源观点与推断。"
    const editor = editorFor(markdown)
    // 真实响应同时保留其它草稿与当前生效规则，父组件需要两份配置来更新编辑器。
    const result: RuleActivation = {
      revision: 3,
      config: editor.config,
      effectiveConfig: { ...editor.config, rules: [] },
      release: {
        version: 2,
        draftRevision: 3,
        activationSeq: 10,
        scope: { mode: "future" },
        targetInputIds: [],
        createdAt: "2026-10-03T10:00:00Z",
      },
      schedule: { revision: 0, config: null },
    }
    mocks.client.activateGlobal.mockResolvedValue(result)
    await render(editor, effectiveFor("旧生效要求"))
    expect(container.querySelector("textarea")?.value).toBe(markdown)
    expect(onDirty.mock.calls.every(([dirty]) => dirty === false)).toBe(true)
    expect(saveButton().disabled).toBe(false)

    await act(async () => saveButton().click())
    expect(mocks.client.activateGlobal).toHaveBeenCalledTimes(1)
    expect(mocks.client.activateGlobal).toHaveBeenCalledWith(
      markdown,
      2,
      expect.any(String),
      expect.any(AbortSignal),
      undefined,
    )
    expect(onSaved).toHaveBeenCalledWith(result)
    expect(onSaved.mock.calls[0]?.[0]).toBe(result)
    expect(saveButton().disabled).toBe(true)
    expect(onDirty.mock.calls.every(([dirty]) => dirty === false)).toBe(true)
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
    expect(mocks.client.save).not.toHaveBeenCalled()
    expect(mocks.client.publish).not.toHaveBeenCalled()
    expect(mocks.client.saveSchedule).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
  })

  it("列表触发开关纳入草稿保护并独立保存，不发布未审核规则", async () => {
    const config = {
      scope: { mode: "rules" },
      sourceKeys: ["feed/1"],
      historySince: "2026-10-01T00:00:00Z",
      timeZone: "Asia/Shanghai",
      enabled: true,
      times: ["08:00"],
      pollIntervalMinutes: null,
      readyBy: null,
      runOnListLoad: true,
    }
    mocks.client.loadSchedule.mockResolvedValueOnce({ revision: 2, config })
    mocks.client.saveSchedule.mockResolvedValueOnce({
      revision: 3,
      config: { ...config, runOnListLoad: false },
    })
    await render(editorFor("已保存要求"), effectiveFor("已保存要求"))
    const label = [...container.querySelectorAll("label")].find(
      (item) => item.textContent === "processing.run.on_list_load",
    )!
    const checkbox = label.querySelector("input")!
    expect(checkbox.checked).toBe(true)
    await act(async () => checkbox.click())
    expect(onDirty).toHaveBeenCalledWith(true)
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "automation.editor.save_schedule",
    )!
    await act(async () => button.click())
    expect(mocks.client.saveSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ runOnListLoad: false, enabled: true, scope: { mode: "rules" } }),
      2,
      expect.any(AbortSignal),
    )
    expect(checkbox.checked).toBe(false)
  })

  it("原生公共设置复用关注清单，关注修改单独启用且保护草稿", async () => {
    const attention = {
      enabled: true,
      watchlist: [{ id: "watch-1", name: "Folo", aliases: ["Follow"] }],
      nearDeadlineHours: 48,
    }
    const editor = editorFor("已生效要求")
    editor.config.global.attention = attention
    const effective = effectiveFor("已生效要求")
    effective.config!.global.attention = attention
    const changedAttention = { ...attention, enabled: false }
    const result: RuleActivation = {
      revision: 3,
      config: {
        ...editor.config,
        global: { ...editor.config.global, attention: changedAttention },
      },
      effectiveConfig: {
        ...effective.config!,
        global: { ...effective.config!.global, attention: changedAttention },
      },
      release: {
        version: 2,
        draftRevision: 3,
        activationSeq: 10,
        scope: { mode: "future" },
        targetInputIds: [],
        createdAt: "2026-10-03T10:00:00Z",
      },
      schedule: { revision: 0, config: null },
    }
    mocks.client.activateGlobal.mockResolvedValueOnce(result)
    await render(editor, effective)
    expect(container.textContent).toContain("processing.attention.title")
    expect(container.querySelector<HTMLInputElement>('input[maxlength="100"]')?.value).toBe("Folo")
    expect(saveButton().disabled).toBe(true)
    const enabled = [...container.querySelectorAll("label")]
      .find((item) => item.textContent === "processing.attention.enabled")!
      .querySelector("input")!
    await act(async () => enabled.click())
    expect(onDirty).toHaveBeenCalledWith(true)
    await act(async () => saveButton().click())
    expect(mocks.client.activateGlobal).toHaveBeenCalledWith(
      "已生效要求",
      2,
      expect.any(String),
      expect.any(AbortSignal),
      changedAttention,
    )
    expect(saveButton().disabled).toBe(true)
    expect(mocks.client.saveSchedule).not.toHaveBeenCalled()
    expect(mocks.client.publish).not.toHaveBeenCalled()
  })

  it("分类模式切换保留原计划范围、启用状态、时点与首次启用水位", async () => {
    const config = {
      scope: { mode: "fixed" as const, sourceKeys: ["feed/1"] },
      sourceKeys: ["feed/1"],
      historySince: "2026-10-01T00:00:00Z",
      timeZone: "Asia/Shanghai",
      enabled: false,
      times: ["08:00"],
      pollIntervalMinutes: 15,
      readyBy: { leadMinutes: 30 },
      runOnListLoad: false,
      classification: { mode: "new_content" as const, enabledAt: "2026-10-08T01:02:03Z" },
    }
    mocks.client.loadSchedule.mockResolvedValueOnce({ revision: 2, config })
    mocks.client.saveSchedule.mockResolvedValueOnce({
      revision: 3,
      config: { ...config, classification: { ...config.classification, mode: "list_loaded" } },
    })
    await render(editorFor("已保存要求"), effectiveFor("已保存要求"))
    const select = container.querySelector("select")!
    expect(select.value).toBe("new_content")
    await act(async () => {
      select.value = "list_loaded"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(onDirty).toHaveBeenCalledWith(true)
    const save = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "automation.editor.save_schedule",
    )!
    await act(async () => save.click())
    expect(mocks.client.saveSchedule).toHaveBeenCalledWith(
      { ...config, classification: { ...config.classification, mode: "list_loaded" } },
      2,
      expect.any(AbortSignal),
    )
    expect(select.value).toBe("list_loaded")
    expect(save.disabled).toBe(true)
    expect(mocks.client.activateGlobal).not.toHaveBeenCalled()
  })

  it("草稿等于实际生效正文时无需重复启用，未发布时仍可启用", async () => {
    const editor = editorFor("已保存要求")
    await render(editor, effectiveFor("已保存要求"))
    expect(saveButton().disabled).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(editor, null)
    expect(saveButton().disabled).toBe(false)
    expect(mocks.client.activateGlobal).not.toHaveBeenCalled()
  })
})
