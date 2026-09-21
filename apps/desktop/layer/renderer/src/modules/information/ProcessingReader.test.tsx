import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { ProcessingReader } from "./ProcessingReader"

const now = "2026-09-21T00:00:00.000Z"

const mocks = vi.hoisted(() => ({
  loadReadingSnapshot: vi.fn(),
  refreshReadingSnapshot: vi.fn(),
  loadReadingSnapshotPage: vi.fn(),
  loadEntryOverrides: vi.fn(),
  loadResearchPack: vi.fn(),
  readingRequest: vi.fn(),
}))

vi.mock("./processing-reader-client", () => ({
  loadReadingSnapshot: mocks.loadReadingSnapshot,
  refreshReadingSnapshot: mocks.refreshReadingSnapshot,
  loadReadingSnapshotPage: mocks.loadReadingSnapshotPage,
  loadEntryOverrides: mocks.loadEntryOverrides,
  loadResearchPack: mocks.loadResearchPack,
  readingRequest: mocks.readingRequest,
  mutationSchemas: {},
  readingEntryPresentation: () => ({
    title: "",
    summary: "",
    summaryKey: null,
    aiSummary: null,
    issueCount: 0,
  }),
  readingPendingMessageKey: () => "",
  ReadingRequestError: class ReadingRequestError extends Error {
    constructor(readonly kind: string) {
      super(kind)
    }
  },
}))

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./InformationIntegration", () => ({ InformationIntegration: () => null }))
vi.mock("./ProcessingEntryExplanation", () => ({ ProcessingEntryExplanation: () => null }))
vi.mock("./ProcessingFeedbackPanel", () => ({ ProcessingFeedbackPanel: () => null }))
vi.mock("./ProcessingReadingModeSwitch", () => ({ ProcessingReadingModeSwitch: () => null }))
vi.mock("./ResearchPanel", () => ({ ResearchPanel: () => null }))
vi.mock("../action/processing-condition-editor", () => ({ processingButtonClass: "btn" }))

const snapshot = {
  id: "snap-1",
  cutoffAt: now,
  maxSeq: 0,
  createdAt: now,
  latestAvailable: true,
}

const storyItem = {
  kind: "story",
  state: "ready",
  ordinal: 0,
  story: {
    id: "story-1",
    aggregationRuleId: "r",
    aggregationScopeVersion: "v",
    status: "active",
    currentRevision: 1,
    currentSubstantiveRevision: 0,
    mergedInto: null,
    splitInto: [],
    createdAt: now,
    updatedAt: now,
  },
  revision: 1,
  title: "STORY_TITLE_XYZ",
  body: "b",
  audit: {
    cutoffAt: now,
    maxSeq: 0,
    appliedRelease: null,
    currentDecisionId: null,
    storyRevision: 1,
  },
}

const makePage = (offset: number) => ({
  snapshot,
  view: "smart" as const,
  offset,
  limit: 50,
  total: 100,
  items: [storyItem],
})

const render = async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProcessingReader />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { container, root }
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const setVisibility = async (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const findButton = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(label),
  ) as HTMLButtonElement | undefined

afterEach(async () => {
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

beforeAll(() => {
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

describe("ProcessingReader visibility", () => {
  it("keeps page offset and selected stories across tab hide/show (same account)", async () => {
    mocks.loadReadingSnapshot.mockResolvedValue({ snapshot })
    mocks.loadReadingSnapshotPage.mockImplementation(
      async (_id: unknown, _view: unknown, offset: number) => makePage(offset),
    )
    mocks.loadEntryOverrides.mockResolvedValue(new Map())

    const { container, root } = await render()

    // 初次加载应在第 0 页。
    expect(mocks.loadReadingSnapshotPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      0,
      expect.anything(),
    )

    // 勾选一个 story 作为「所选条目」（selectedStoryIds）。
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).toBeDefined()
    await click(checkbox)
    expect(checkbox.checked).toBe(true)

    // 翻到第 2 页（offset 50）。
    const next = findButton(container, "processing.reader.next")
    expect(next).toBeDefined()
    await click(next!)
    expect(mocks.loadReadingSnapshotPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      50,
      expect.anything(),
    )
    expect(container.textContent).toContain("2 / 2")

    // 隐藏再可见：同账号，回到当前页（offset 50）并保留所选条目。
    await setVisibility("hidden")
    await setVisibility("visible")

    // 回到当前页而非第 0 页。
    expect(mocks.loadReadingSnapshotPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      50,
      expect.anything(),
    )
    expect(container.textContent).toContain("2 / 2")
    // 所选条目（复选框勾选）保持。
    const checkboxAfter = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkboxAfter.checked).toBe(true)

    await act(async () => {
      root.unmount()
    })
  })

  it("does not reset to page 0 when returning to the tab", async () => {
    mocks.loadReadingSnapshot.mockResolvedValue({ snapshot })
    mocks.loadReadingSnapshotPage.mockImplementation(
      async (_id: unknown, _view: unknown, offset: number) => makePage(offset),
    )
    mocks.loadEntryOverrides.mockResolvedValue(new Map())

    const { container, root } = await render()
    await click(findButton(container, "processing.reader.next")!)

    const callsBefore = mocks.loadReadingSnapshotPage.mock.calls.length
    await setVisibility("hidden")
    await setVisibility("visible")
    const callsAfter = mocks.loadReadingSnapshotPage.mock.calls.length

    // 回到前台应重新加载当前页，新增一次 offset=50 的调用，而不是 offset=0。
    expect(callsAfter).toBeGreaterThan(callsBefore)
    const lastCall = mocks.loadReadingSnapshotPage.mock.calls.at(-1)
    expect(lastCall?.[2]).toBe(50)

    await act(async () => {
      root.unmount()
    })
  })
})
