import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { InformationPage } from "./InformationPage"

const now = "2026-09-21T00:00:00.000Z"

const snapshotFixture = (ownerId: string) => ({
  ownerId,
  sources: [{ key: "s1", kind: "feed", id: "s1", title: "Source", view: 0, category: null }],
  items: [
    { id: "i1", sourceKey: "s1", title: "Item", url: "https://example.com", publishedAt: now },
  ],
  jobs: [],
  results: [
    {
      id: "r1",
      itemId: "i1",
      sourceKey: "s1",
      title: "RESULT_TITLE_UNIQUE",
      model: "m",
      material: "source_text",
      createdAt: now,
      payload: { summary: "summary", points: [], entryId: "e1" },
    },
  ],
})

const mocks = vi.hoisted(() => ({
  loadInformationSnapshot: vi.fn(),
  loadInformationAISettings: vi.fn(),
  saveInformationAISettings: vi.fn(),
  loadReadingSnapshot: vi.fn(),
  loadReadingSnapshotPage: vi.fn(),
  refreshReadingSnapshot: vi.fn(),
  loadEntryOverrides: vi.fn(),
  loadResearchPack: vi.fn(),
  readingRequest: vi.fn(),
}))

vi.mock("./session", () => ({
  InformationLoadError: class InformationLoadError extends Error {
    constructor(readonly kind: string) {
      super(kind)
    }
  },
  loadInformationSnapshot: mocks.loadInformationSnapshot,
  loadInformationAISettings: mocks.loadInformationAISettings,
  saveInformationAISettings: mocks.saveInformationAISettings,
}))

vi.mock("~/lib/auth", () => ({
  oneTimeToken: { generate: vi.fn().mockResolvedValue({ token: "t" }) },
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
vi.mock("./XSearchPanel", () => ({ XSearchPanel: () => null }))
vi.mock("./InformationIntegration", () => ({ InformationIntegration: () => null }))
vi.mock("./ProcessingDiagnostics", () => ({ ProcessingDiagnostics: () => null }))
vi.mock("../action/processing-condition-editor", () => ({ processingButtonClass: "btn" }))

let nextOwner = "owner-A"

const render = async () => {
  mocks.loadInformationSnapshot.mockImplementation(async () => snapshotFixture(nextOwner))
  mocks.loadInformationAISettings.mockResolvedValue({
    provider: "qianwen",
    model: "m",
    hasApiKey: false,
  })
  mocks.loadReadingSnapshot.mockResolvedValue({
    snapshot: { id: "snap-1", cutoffAt: now, maxSeq: 0, createdAt: now, latestAvailable: true },
  })
  mocks.loadReadingSnapshotPage.mockResolvedValue({
    snapshot: { id: "snap-1", cutoffAt: now, maxSeq: 0, createdAt: now, latestAvailable: true },
    view: "smart",
    offset: 0,
    limit: 50,
    total: 0,
    items: [],
  })
  mocks.loadEntryOverrides.mockResolvedValue(new Map())
  mocks.readingRequest.mockResolvedValue({ id: "x" })

  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<InformationPage />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { container, root }
}

const setVisibility = async (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

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

describe("InformationPage", () => {
  it("no longer renders the old duplicate results list on the main path", async () => {
    const { root } = await render()
    // 快照带有 results，但旧的行内 <article> 结果列表已从主路径撤掉。
    expect(document.body.textContent).not.toContain("RESULT_TITLE_UNIQUE")
    await act(async () => {
      root.unmount()
    })
  })

  it("re-initializes the reader when the account changes", async () => {
    nextOwner = "owner-A"
    const { root } = await render()
    expect(mocks.loadReadingSnapshot).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain("owner-A")
    expect(document.body.textContent).not.toContain("owner-B")

    // 回到前台时账号变化：应替换快照、重新初始化阅读器（重新挂载）。
    nextOwner = "owner-B"
    await setVisibility("hidden")
    await setVisibility("visible")

    expect(document.body.textContent).toContain("owner-B")
    expect(document.body.textContent).not.toContain("owner-A")
    // 阅读器因 key（ownerId）变化而重新挂载，初次加载被再次调用。
    expect(mocks.loadReadingSnapshot).toHaveBeenCalledTimes(2)

    await act(async () => {
      root.unmount()
    })
  })

  it("keeps the reader mounted when returning to the same account", async () => {
    nextOwner = "owner-A"
    const { root } = await render()
    expect(mocks.loadReadingSnapshot).toHaveBeenCalledTimes(1)

    // 同账号回前台：核验通过，不替换快照、不重新挂载阅读器。
    await setVisibility("hidden")
    await setVisibility("visible")

    expect(mocks.loadReadingSnapshot).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain("owner-A")

    await act(async () => {
      root.unmount()
    })
  })
})
