// @vitest-environment jsdom
import type { AutomationRule, RuleSet } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LocalAutomationSettings } from "./local-automation-settings"

const mocks = vi.hoisted(() => ({
  client: {
    load: vi.fn(),
    loadEffective: vi.fn(),
    activateRule: vi.fn(),
    deleteRule: vi.fn(),
    previewUpgrade: vi.fn(),
    upgradeRules: vi.fn(),
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
  vi.clearAllMocks()
  mocks.legacy = []
  mocks.mirror.mockReset()
  const body = config()
  mocks.client.load.mockResolvedValue({
    revision: 2,
    config: body,
    sources: [],
    subscriptionTags: { tags: [] },
    sourceTags: [],
    listMemberships: [],
    items: [],
    releases: [],
  })
  mocks.client.loadEffective.mockResolvedValue({ revision: 2, config: body, releaseVersion: 2 })
  mocks.client.previewUpgrade.mockResolvedValue({
    required: false,
    supported: true,
    expectedRevision: 2,
    expectedScheduleRevision: 0,
    sourceCount: 0,
    affectedRules: [],
  })
  mocks.client.activateRule.mockImplementation(async (next: AutomationRule) => ({
    revision: 3,
    config: { ...body, rules: [...body.rules.filter((item) => item.id !== next.id), next] },
    effectiveConfig: { ...body, rules: [next] },
    release: { version: 3 },
    schedule: { config: null },
  }))
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
  it("preserves the legacy source boundary before allowing new activation", async () => {
    mocks.client.previewUpgrade.mockResolvedValue({
      required: true,
      supported: true,
      expectedRevision: 2,
      expectedScheduleRevision: 1,
      sourceCount: 22,
      affectedRules: [{ id: "first", name: "First" }],
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
