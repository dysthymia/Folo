// @vitest-environment jsdom
import type { AutomationRule, RuleSet } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LocalAutomationSettings } from "./local-automation-settings"

const mocks = vi.hoisted(() => ({
  client: {
    loadEditor: vi.fn(),
    load: vi.fn(),
    loadEffective: vi.fn(),
    loadAutomationStatus: vi.fn(),
    activateRule: vi.fn(),
    deleteRule: vi.fn(),
    previewUpgrade: vi.fn(),
    upgradeRules: vi.fn(),
    save: vi.fn(),
    activateRules: vi.fn(),
    reorderRules: vi.fn(),
  },
  legacy: [] as unknown[],
  disable: vi.fn(),
  mirror: vi.fn(),
  ask: vi.fn(),
  t: (key: string) => key,
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: "owner" }) }))
vi.mock("@follow/store/action/local-hooks", () => ({
  useLocalActionHydration: vi.fn(),
  useLocalActionRules: () => mocks.legacy,
}))
vi.mock("@follow/store/action/local-store", () => ({
  localActionSyncService: { disablePublishedMigrationTargets: mocks.disable },
}))
vi.mock("@follow/store/action/published-local-filters", () => ({
  setPublishedLocalFilters: mocks.mirror,
}))
vi.mock("~/components/ui/modal/stacked/hooks", () => ({ useDialog: () => ({ ask: mocks.ask }) }))
vi.mock("./use-unsaved-blocker", () => ({ useUnSavedBlocker: vi.fn() }))
vi.mock("../ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("./processing-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./processing-client")>()
  return { ...actual, createProcessingClient: () => mocks.client }
})
vi.mock("./processing-trial-panel", () => ({ ProcessingTrialPanel: () => <div>trial</div> }))
vi.mock("./local-automation-preferences", () => ({
  LocalAutomationPreferences: () => <div>preferences</div>,
}))
vi.mock("./local-automation-feedback", () => ({
  LocalAutomationFeedback: () => <div>feedback</div>,
}))

const rule = (id: string, name: string): AutomationRule => ({
  id,
  name,
  ownerId: "owner",
  enabled: true,
  version: 1,
  order: id === "first" ? 0 : 1,
  executionLocation: "processing_service",
  when: { all: true },
  actions: [{ type: "ai_transform", prompt: "keep facts" }],
})
const config = (): RuleSet => ({
  formatVersion: 4,
  ownerId: "owner",
  global: { markdown: "", version: 1 },
  rules: [rule("first", "First"), rule("second", "Second")],
})
// 统一首屏响应夹具，独立接口保持为空，以捕捉页面重新退回多次鉴权的回归。
const editorSnapshot = () => ({
  editor: {
    revision: 2,
    config: config(),
    sources: [],
    subscriptionTags: { tags: [] },
    sourceTags: [],
    listMemberships: [],
    items: [],
    releases: [],
  },
  effective: { revision: 2, config: config(), releaseVersion: 2 },
  upgrade: {
    required: false,
    supported: true,
    expectedRevision: 2,
    expectedScheduleRevision: 0,
    sourceCount: 0,
    affectedRules: [],
  },
})
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const click = async (text: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent?.trim() === text,
  )
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
}
const chooseAction = async (value: string) =>
  act(async () => {
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="automation.action.add"]',
    )!
    select.value = value
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
const selectRow = async (name: string) =>
  act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("nav button"))
      .find((button) => button.textContent?.startsWith(name))!
      .click()
  })
beforeEach(() => {
  window.history.replaceState(null, "", "/action")
  vi.clearAllMocks()
  mocks.legacy = []
  mocks.mirror.mockReset()
  const body = config()
  mocks.client.loadEditor.mockResolvedValue(editorSnapshot())
  mocks.client.save.mockImplementation(async (config: RuleSet) => ({ revision: 3, config }))
  mocks.client.activateRule.mockImplementation(async (next: AutomationRule) => ({
    revision: 3,
    config: { ...body, rules: [...body.rules.filter((item) => item.id !== next.id), next] },
    effectiveConfig: { ...body, rules: [next] },
    release: { version: 3 },
    schedule: { config: null },
  }))
  mocks.client.reorderRules.mockImplementation(async (ids: string[]) => {
    const reordered = ids.map((id, order) => ({
      ...body.rules.find((rule) => rule.id === id)!,
      order,
    }))
    return {
      revision: 3,
      config: { ...body, rules: reordered },
      effectiveConfig: { ...body, rules: reordered },
      release: { version: 3 },
      schedule: { config: null },
    }
  })
  mocks.disable.mockReturnValue({ switched: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const render = () =>
  act(async () => {
    root.render(<LocalAutomationSettings />)
  })

describe("single local automation editor", () => {
  it("首屏一次请求即可显示规则，无需等待三个独立读取", async () => {
    await render()
    expect(container.textContent).toContain("First")
    expect(container.textContent).not.toContain("automation.editor.loading")
    expect(mocks.client.loadEditor).toHaveBeenCalledTimes(1)
    expect(mocks.client.load).not.toHaveBeenCalled()
    expect(mocks.client.loadEffective).not.toHaveBeenCalled()
    expect(mocks.client.previewUpgrade).not.toHaveBeenCalled()
  })
  it("来源规则ID入口准确定位，失效ID不会转而编辑第一条", async () => {
    window.history.replaceState(null, "", "/action?ruleId=second")
    await render()
    expect(container.querySelector('nav button[aria-current="true"]')?.textContent).toContain(
      "Second",
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    window.history.replaceState(null, "", "/action?ruleId=missing")
    await render()
    expect(container.querySelector('nav button[aria-current="true"]')).toBeNull()
    expect(container.textContent).toContain("automation.editor.error_invalid")
  })
  it("模板草稿与待发布修改显示真实生效状态，排序只提交有效规则ID", async () => {
    mocks.client.loadEditor.mockResolvedValue({
      ...editorSnapshot(),
      effective: {
        revision: 2,
        config: { ...config(), rules: [{ ...config().rules[0]!, enabled: false }] },
        releaseVersion: 2,
      },
    })
    await render()
    expect(container.textContent).toContain("automation.feedback.state_pending")
    expect(container.textContent).toContain("automation.feedback.current_disabled")
    await selectRow("Second")
    expect(container.textContent).toContain("automation.feedback.state_draft")
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "automation.feedback.move_up",
      )?.disabled,
    ).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    mocks.client.loadEditor.mockResolvedValue(editorSnapshot())
    await render()
    await selectRow("Second")
    await click("automation.feedback.move_up")
    expect(mocks.client.reorderRules.mock.calls[0]?.[0]).toEqual(["second", "first"])
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
  })
  it("previews personalized templates and only saves drafts with real tag bindings", async () => {
    await render()
    await click("automation.pack.title")
    expect(mocks.client.save).not.toHaveBeenCalled()
    expect(container.textContent).toContain("automation.pack.missing_tags")
    expect(container.textContent).toContain("automation.pack.omitted")
    await click("automation.pack.add_draft")
    const saved = mocks.client.save.mock.calls[0]![0] as RuleSet
    // 缺真实标签时仅加入跨领域去噪和唯一同事件规则，已有私人规则完整保留。
    expect(saved.rules.map((rule) => rule.id)).toEqual([
      "first",
      "second",
      "personalized:R10",
      "personalized:R90",
    ])
    expect(saved.rules.slice(0, 2)).toEqual(config().rules)
    expect(saved.global.markdown).toContain("空投")
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
    expect(container.textContent).toContain("automation.pack.saved_draft")
  })
  it("preserves the legacy source boundary before allowing new activation", async () => {
    mocks.client.loadEditor.mockResolvedValue({
      ...editorSnapshot(),
      upgrade: {
        required: true,
        supported: true,
        expectedRevision: 2,
        expectedScheduleRevision: 1,
        sourceCount: 22,
        affectedRules: [{ id: "first", name: "First" }],
      },
    })
    await render()
    expect(container.textContent).toContain("automation.editor.upgrade_scope")
    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "automation.editor.save",
    )!
    expect(save.disabled).toBe(true)
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
  })
  it("edits and publishes only the selected rule", async () => {
    await render()
    expect(container.querySelectorAll("textarea")).toHaveLength(1)
    await selectRow("Second")
    await click("automation.editor.save")
    expect(mocks.client.activateRule.mock.calls[0]![0].id).toBe("second")
    expect(mocks.client.activateRule.mock.calls[0]![1]).toBe(2)
    expect(mocks.disable).not.toHaveBeenCalled()
  })
  it("creates AI rules from the main create button without another service form", async () => {
    await render()
    await click("automation.editor.create")
    expect(container.querySelector("textarea")).toBeNull()
    await chooseAction("summary")
    await click("automation.editor.save")
    expect(mocks.client.activateRule.mock.calls[0]![0].actions[0].type).toBe("ai_transform")
    expect(mocks.client.activateRule.mock.calls[0]![0].id).not.toBe("first")
    expect(container.textContent).not.toContain("processing.global")
  })
  it("adds AI to existing local rules and switches only after publication and mirror persistence", async () => {
    mocks.legacy = [
      {
        localId: "stable-local",
        name: "Old local",
        index: 0,
        condition: [],
        result: { block: true },
      },
    ]
    await render()
    await selectRow("Old local")
    await chooseAction("summary")
    await click("automation.editor.save")
    const saved = mocks.client.activateRule.mock.calls[0]![0]
    expect(saved.id).toBe("local-stable-local")
    expect(saved.actions.map((action: AutomationRule["actions"][number]) => action.type)).toEqual([
      "local_filter",
      "ai_transform",
    ])
    expect(mocks.disable).toHaveBeenCalledWith("owner", [
      expect.objectContaining({ localId: "stable-local" }),
    ])
    expect(mocks.client.activateRule.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disable.mock.invocationCallOrder[0]!,
    )
    expect(mocks.mirror.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disable.mock.invocationCallOrder[0]!,
    )
  })
  it("keeps the old local rule when offline cache persistence fails", async () => {
    mocks.legacy = [
      {
        localId: "stable-local",
        name: "Old local",
        index: 0,
        condition: [],
        result: { silence: true },
      },
    ]
    mocks.mirror.mockImplementation(() => {
      throw new Error("quota")
    })
    await render()
    await selectRow("Old local")
    await click("automation.editor.save")
    expect(mocks.disable).not.toHaveBeenCalled()
    expect(container.textContent).toContain("automation.editor.error_migration")
  })
  it("protects unsaved edits when switching rules", async () => {
    await render()
    await chooseAction("block")
    await click("automation.editor.create")
    expect(mocks.ask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "automation.editor.discard_title" }),
    )
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
  })
  it("retains unsupported legacy conditions without widening their scope", async () => {
    mocks.legacy = [
      {
        localId: "regex",
        name: "Regex",
        index: 0,
        condition: [[{ field: "entry_title", operator: "regex", value: "a+" }]],
        result: { block: true },
      },
    ]
    await render()
    await selectRow("Regex")
    expect(container.textContent).toContain("automation.editor.unsupported")
    expect(container.querySelector('a[href*="legacy=local"]')).toBeTruthy()
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
  })
})

describe("去重入口授权边界", () => {
  it.each(["when", "scope"] as const)(
    "编辑 %s 的分类条件不会崩溃，补全前阻止发布，补全后恢复预览",
    async (target) => {
      window.history.replaceState(null, "", "/action?scope=processing_service&dedupe=1")
      mocks.client.loadAutomationStatus.mockResolvedValue({
        rules: [{ ruleId: "first", sourceKeys: ["feed/allowed"] }],
      })
      const body = config()
      mocks.client.loadEditor.mockResolvedValue({
        ...editorSnapshot(),
        editor: {
          revision: 2,
          config: body,
          sources: [
            {
              key: "feed/allowed",
              id: "allowed",
              kind: "feed",
              title: "Allowed",
              view: 0,
              category: "AI",
            },
          ],
          sourceInventoryKnown: true,
          subscriptionTags: { tags: [] },
          sourceTags: [],
          listMemberships: [],
          items: [
            {
              id: "entry",
              sourceKey: "feed/allowed",
              title: "Article",
              url: null,
              publishedAt: "2026-10-04T00:00:00Z",
            },
          ],
          releases: [],
        },
      })
      await render()
      const fieldIndex = target === "when" ? 0 : 1
      if (target === "scope") {
        // 从 ALL 切换也会创建空文本草稿，必须先保持编辑状态而非调用严格匹配器。
        await act(async () => {
          const select = container.querySelectorAll<HTMLSelectElement>(
            '[aria-label="processing.match_mode"]',
          )[1]!
          select.value = "conditions"
          select.dispatchEvent(new Event("change", { bubbles: true }))
        })
        expect(container.textContent).toContain("automation.dedupe.preview_incomplete")
      }
      await act(async () => {
        const field = container.querySelectorAll<HTMLSelectElement>(
          '[aria-label="processing.field_label"]',
        )[fieldIndex]!
        field.value = "category_ref"
        field.dispatchEvent(new Event("change", { bubbles: true }))
      })
      expect(container.textContent).toContain("automation.dedupe.preview_incomplete")
      expect(container.textContent).not.toContain("processing.category_identity_repair")
      await click("automation.editor.save")
      expect(container.textContent).toContain("automation.editor.error_invalid")
      expect(mocks.client.activateRule).not.toHaveBeenCalled()

      await act(async () => {
        const category = Array.from(
          container.querySelectorAll<HTMLSelectElement>('[aria-label="processing.value"]'),
        ).find((select) => select.options[0]?.textContent?.includes("processing.choose"))!
        category.value = JSON.stringify({ view: 0, name: "AI" })
        category.dispatchEvent(new Event("change", { bubbles: true }))
      })
      expect(container.textContent).not.toContain("automation.dedupe.preview_incomplete")
      await click("automation.editor.save")
      const saved = mocks.client.activateRule.mock.calls[0]![0] as AutomationRule
      const conditions =
        target === "when"
          ? saved.when
          : saved.actions.find((action) => action.type === "ai_dedupe")!.scope
      expect(conditions).toEqual({
        anyOf: [
          { allOf: [{ field: "category_ref", operator: "eq", value: { view: 0, name: "AI" } }] },
        ],
      })
      expect(saved.enabled).toBe(false)
    },
  )
  it("只创建授权来源内的禁用草稿且不写设置或规则", async () => {
    window.history.replaceState(null, "", "/action?scope=processing_service&dedupe=1")
    mocks.client.loadAutomationStatus.mockResolvedValue({
      rules: [{ ruleId: "first", sourceKeys: ["feed/allowed"] }],
    })
    await act(async () => root.render(<LocalAutomationSettings />))
    const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(input?.checked).toBe(false)
    expect(container.textContent).toContain("automation.dedupe.preview")
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
    expect(mocks.client.save).not.toHaveBeenCalled()
  })
  it("无授权来源时明确说明，不扩大为全源", async () => {
    window.history.replaceState(null, "", "/action?scope=processing_service&dedupe=1")
    mocks.client.loadAutomationStatus.mockResolvedValue({ rules: [] })
    await act(async () => root.render(<LocalAutomationSettings />))
    expect(container.textContent).toContain("automation.editor.error_dedupe_scope")
    expect(mocks.client.activateRule).not.toHaveBeenCalled()
  })
})
