import type { RuleSet } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ProcessingSetting } from "./processing-setting"

const { clientMock, ProcessingRequestErrorMock } = vi.hoisted(() => {
  class ProcessingRequestErrorMock extends Error {
    constructor(
      public readonly kind: "authorization" | "conflict" | "referenced" | "invalid" | "request",
    ) {
      super(kind)
    }
  }

  return {
    clientMock: {
      load: vi.fn(),
      save: vi.fn(),
      preview: vi.fn(),
      loadSchedule: vi.fn(),
      loadInputs: vi.fn(),
      loadRuns: vi.fn(),
      startRun: vi.fn(),
    },
    ProcessingRequestErrorMock,
  }
})

vi.mock("./processing-client", () => ({
  createProcessingClient: () => clientMock,
  ProcessingRequestError: ProcessingRequestErrorMock,
}))

vi.mock("~/lib/auth", () => ({
  oneTimeToken: { generate: vi.fn() },
}))

vi.mock("../ai-chat/local-provider", () => ({
  getOneTimeToken: vi.fn(async () => "one-time-token"),
}))

vi.mock("~/components/ui/modal/stacked/hooks", () => ({
  useDialog: () => ({ ask: vi.fn() }),
}))

vi.mock("./use-unsaved-blocker", () => ({
  useUnSavedBlocker: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 测试保留翻译 key，便于通过 aria-label 和按钮文字定位真实控件。
    t: (key: string) => key,
  }),
}))

const ruleSet: RuleSet = {
  formatVersion: 4,
  ownerId: "owner-1",
  global: { markdown: "global", version: 1 },
  rules: [
    {
      id: "rule-1",
      ownerId: "owner-1",
      name: "Rule 1",
      enabled: true,
      order: 0,
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "ai_transform", prompt: "summarize" }],
    },
  ],
}

const editor = {
  revision: 11,
  config: ruleSet,
  sources: [
    { key: "feed:1", kind: "feed" as const, id: "1", title: "Feed", view: 0, category: null },
  ],
  items: [
    {
      id: "entry-1",
      sourceKey: "feed:1",
      title: "Entry",
      url: "https://example.com/entry-1",
      publishedAt: "2026-09-12T00:00:00.000Z",
    },
  ],
  releases: [],
  capabilities: { automaticProcessing: false },
  subscriptionTags: { revision: 4, tags: [{ id: "tag-1", name: "Important" }] },
  sourceTags: [{ sourceKey: "feed:1", tagIds: ["tag-1"] }],
}

const preview = {
  material: "source_text" as const,
  matches: [{ ruleId: "rule-1", state: "match" as const }],
  pendingRuleIds: [],
  blocksFinalPresentation: false,
  policy: {},
  display: {},
  transformations: [{ ruleId: "rule-1", prompt: "summarize" }],
  shadowed: [],
}

const schedule = {
  revision: 3,
  config: {
    sourceKeys: ["feed:1"],
    historySince: "2026-09-01T00:00:00.000Z",
    timeZone: "Asia/Shanghai",
    enabled: true,
    times: ["08:00", "12:00", "15:00", "20:00", "23:00"],
    pollIntervalMinutes: null,
    readyBy: null,
  },
}

const currentRelease = {
  version: 2,
  draftRevision: editor.revision,
  activationSeq: 20,
  scope: { mode: "future" as const },
  targetInputIds: [],
  createdAt: "2026-09-12T00:00:00.000Z",
}

const findButton = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === label,
  )

const getReactProps = <T extends object>(element: HTMLElement): T => {
  const key = Object.keys(element).find((item) => item.startsWith("__reactProps"))
  if (!key) throw new Error("React props not found")
  return (element as unknown as Record<string, T>)[key] as T
}

const setTextValue = async <T extends HTMLInputElement | HTMLTextAreaElement>(
  element: T,
  value: string,
) => {
  const prototype =
    element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
  if (!descriptor?.set) throw new Error("value setter not found")
  await act(async () => {
    descriptor.set!.call(element, value)
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }))
    getReactProps<{ onChange?: (event: { target: T }) => void }>(element).onChange?.({
      target: element,
    })
  })
}

describe("ProcessingSetting", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    clientMock.load.mockResolvedValue(editor)
    clientMock.save.mockResolvedValue({ revision: 12, config: ruleSet })
    clientMock.preview.mockResolvedValue(preview)
    clientMock.loadSchedule.mockResolvedValue(schedule)
    clientMock.loadInputs.mockResolvedValue({ inputs: [] })
    clientMock.loadRuns.mockResolvedValue({ runs: [] })
    clientMock.startRun.mockResolvedValue({ id: "run-1" })
    clientMock.load.mockClear()
    clientMock.save.mockClear()
    clientMock.preview.mockClear()
    clientMock.loadSchedule.mockClear()
    clientMock.loadInputs.mockClear()
    clientMock.loadRuns.mockClear()
    clientMock.startRun.mockClear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  const render = async () => {
    await act(async () => {
      root!.render(<ProcessingSetting onDirty={vi.fn()} />)
    })
  }

  it("submits the edited draft with the loaded revision", async () => {
    await render()
    const global = container!.querySelector<HTMLTextAreaElement>("textarea")!
    await setTextValue(global, "user supplied global instructions")

    const save = findButton(container!, "processing.save")!
    expect(save.disabled).toBe(false)
    await act(async () => save.click())

    expect(clientMock.save).toHaveBeenCalledTimes(1)
    expect(clientMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        global: { markdown: "user supplied global instructions", version: 1 },
      }),
      11,
      expect.any(AbortSignal),
    )
  })

  it("keeps an invalid empty condition explicit and disables saving", async () => {
    await render()
    const mode = container!.querySelector<HTMLSelectElement>(
      "select[aria-label='processing.match_mode']",
    )!

    mode.value = "conditions"
    await act(async () => mode.dispatchEvent(new Event("change", { bubbles: true })))

    expect(mode.value).toBe("conditions")
    expect(findButton(container!, "processing.save")?.disabled).toBe(true)
    expect(clientMock.save).not.toHaveBeenCalled()
  })

  it("previews the selected entry without a publish or model submission", async () => {
    await render()
    const sample = container!.querySelector<HTMLSelectElement>(
      "select[aria-label='processing.sample']",
    )!
    sample.value = JSON.stringify(["feed:1", "entry-1"])
    await act(async () => sample.dispatchEvent(new Event("change", { bubbles: true })))
    await act(async () => findButton(container!, "processing.run_preview")?.click())

    expect(clientMock.preview).toHaveBeenCalledWith(
      expect.not.objectContaining({ model: expect.anything(), publish: expect.anything() }),
      "feed:1",
      "entry-1",
      expect.any(AbortSignal),
    )
    expect(clientMock.save).not.toHaveBeenCalled()
    expect(container!.querySelector("[aria-live='polite']")).not.toBeNull()
  })

  it("刷新后使用当前 revision 的持久化发布记录恢复立即运行资格", async () => {
    clientMock.load.mockResolvedValue({ ...editor, releases: [currentRelease] })

    await render()

    const run = findButton(container!, "processing.run.now")!
    expect(run.disabled).toBe(false)
    // 回归只验证按钮资格，不能创建真实或重复任务。
    expect(clientMock.startRun).not.toHaveBeenCalled()
  })

  it.each([
    ["没有发布记录", []],
    ["只有旧 revision 的发布记录", [{ ...currentRelease, draftRevision: editor.revision - 1 }]],
  ])("当前 revision 未发布（%s）时仍禁用立即运行", async (_name, releases) => {
    clientMock.load.mockResolvedValue({ ...editor, releases })

    await render()

    expect(findButton(container!, "processing.run.now")?.disabled).toBe(true)
    expect(clientMock.startRun).not.toHaveBeenCalled()
  })

  it("当前 revision 已发布时仍由未保存草稿和计划阻止立即运行", async () => {
    clientMock.load.mockResolvedValue({ ...editor, releases: [currentRelease] })
    await render()

    const global = container!.querySelector<HTMLTextAreaElement>("textarea")!
    await setTextValue(global, "unsaved global instructions")
    expect(findButton(container!, "processing.run.now")?.disabled).toBe(true)

    await setTextValue(global, ruleSet.global.markdown)
    const runSettings = container!.querySelector<HTMLElement>(
      "section[aria-label='processing.run.settings']",
    )!
    const timeZone = runSettings.querySelector<HTMLInputElement>("input:not([type])")!
    await setTextValue(timeZone, "UTC")
    expect(findButton(container!, "processing.run.now")?.disabled).toBe(true)
    expect(clientMock.startRun).not.toHaveBeenCalled()
  })

  it("shows a conflict while retaining the user's input after save fails", async () => {
    await render()
    const name = container!.querySelector<HTMLInputElement>("input[aria-label='processing.name']")!
    await setTextValue(name, "Edited rule name")
    clientMock.save.mockRejectedValueOnce(new ProcessingRequestErrorMock("conflict"))

    await act(async () => findButton(container!, "processing.save")?.click())

    expect(container!.querySelector("[role='alert']")?.textContent).toBe(
      "processing.error.conflict",
    )
    expect(
      container!.querySelector<HTMLInputElement>("input[aria-label='processing.name']")?.value,
    ).toBe("Edited rule name")
  })
})
