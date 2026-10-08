// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { EntryEventsPanel } from "./EntryEventsPanel"
import {
  correctProcessingEvent,
  loadEntryEvents,
  loadEventDetail,
  loadEventMembers,
  searchProcessingEvents,
} from "./processing-event-client"
import { ReadingRequestError } from "./processing-reader-client"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { number?: number }) =>
      values?.number ? `${key}:${values.number}` : key,
  }),
}))
vi.mock("./StoryDigestPanel", () => ({
  StoryDigestPanel: ({ storyId }: { storyId: string }) => <div>{storyId}</div>,
}))
vi.mock("./processing-reader-client", () => ({
  ReadingRequestError: class extends Error {
    constructor(readonly kind: string) {
      super(kind)
    }
  },
}))
vi.mock("./processing-event-client", () => ({
  eventRoles: ["reports", "analysis_of", "tutorial_for", "mentions"],
  loadEntryEvents: vi.fn(),
  loadEventDetail: vi.fn(),
  loadEventMembers: vi.fn(),
  searchProcessingEvents: vi.fn(),
  correctProcessingEvent: vi.fn(),
}))

const event = {
  id: "evt_alpha",
  title: "Event Alpha",
  aliases: ["Alternate name"],
  status: "confirmed" as const,
  revision: 1,
  mergedInto: null,
  splitInto: [],
}
const member = {
  inputSeq: 1,
  sourceKey: "feed/source1",
  itemId: "article1",
  title: "Original report",
  url: "https://report.example.test/article1",
  publishedAt: "2026-10-06T00:00:00Z",
  contentVersion: "v1",
  decisionId: "decision1",
  mentionId: "mention1",
  role: "reports" as const,
  isPrimary: true,
  state: "confirmed" as const,
  evidence: ["Original evidence"],
}
const analysis = {
  ...member,
  inputSeq: 2,
  sourceKey: "feed/source2",
  mentionId: "mention2",
  title: "Related analysis",
  role: "analysis_of" as const,
  url: "https://analysis.example.test/article2",
}
const tutorial = {
  ...member,
  inputSeq: 3,
  mentionId: "mention3",
  title: "Related tutorial",
  role: "tutorial_for" as const,
  url: "javascript:alert(1)",
}
const anchor = {
  inputSeq: 1,
  contentVersion: "v1",
  decisionId: "decision1",
  events: [
    {
      event,
      mentionId: member.mentionId,
      role: member.role,
      isPrimary: true,
      state: member.state,
      evidence: member.evidence,
    },
  ],
}
const snapshotId = "11111111-1111-4111-8111-111111111111"
const correctionId = "22222222-2222-4222-8222-222222222222"
beforeEach(() => {
  vi.mocked(loadEntryEvents).mockResolvedValue(anchor)
  vi.mocked(loadEventDetail).mockResolvedValue({ event, stories: [] })
  vi.mocked(loadEventMembers).mockResolvedValue({
    snapshotId,
    rows: [member, analysis],
    total: 3,
    nextOffset: 2,
  })
})
afterEach(() => vi.resetAllMocks())
const show = async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(<EntryEventsPanel inputSeq={1} contentVersion="v1" decisionId="decision1" />),
  )
  return {
    container,
    root,
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}
const click = async (container: HTMLElement, text: string) =>
  act(async () =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === text)!.click(),
  )
const open = async (container: HTMLElement) =>
  act(async () => container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click())

describe("EntryEventsPanel", () => {
  it("跨来源成员按角色分组，无Story仍可读原文，分页保持同一快照", async () => {
    const { container, close } = await show()
    expect(container.textContent).toContain("processing.events.confirmation_note")
    expect(loadEventDetail).not.toHaveBeenCalled()
    await open(container)
    expect(container.textContent).toContain("Related analysis")
    expect(container.textContent).toContain("processing.events.related_independent")
    expect(container.textContent).toContain("processing.events.no_story")
    expect(container.querySelector('a[href="https://report.example.test/article1"]')).not.toBeNull()
    expect(container.textContent).not.toContain("feed/source2")
    vi.mocked(loadEventMembers).mockResolvedValueOnce({
      snapshotId,
      rows: [tutorial],
      total: 3,
      nextOffset: null,
    })
    await click(container, "processing.events.load_more")
    expect(loadEventMembers).toHaveBeenLastCalledWith(
      "evt_alpha",
      { snapshotId, offset: 2, limit: 20 },
      expect.any(AbortSignal),
    )
    expect(container.textContent).toContain("Related tutorial")
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    vi.mocked(loadEventMembers).mockResolvedValueOnce({
      snapshotId,
      rows: [analysis],
      total: 1,
      nextOffset: null,
    })
    await act(async () => {
      const select = container.querySelector("select")!
      select.value = "analysis_of"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(loadEventMembers).toHaveBeenLastCalledWith(
      "evt_alpha",
      { role: "analysis_of", offset: 0, limit: 20 },
      expect.any(AbortSignal),
    )
    expect(container.textContent).not.toContain("Original report")
    await close()
  })
  it("正文或决定更新后不展示旧事件", async () => {
    vi.mocked(loadEntryEvents).mockResolvedValueOnce({ ...anchor, contentVersion: "v2" })
    const { container, root, close } = await show()
    expect(container.textContent).toContain("processing.events.stale_entry")
    expect(container.textContent).not.toContain("Event Alpha")
    await act(async () =>
      root.render(<EntryEventsPanel inputSeq={2} contentVersion="v2" decisionId="decision2" />),
    )
    expect(container.textContent).not.toContain("Event Alpha")
    expect(loadEventDetail).not.toHaveBeenCalled()
    await close()
  })
  it("排除指定mention后刷新最新修订并保留撤销入口", async () => {
    const { container, close } = await show()
    await open(container)
    vi.mocked(correctProcessingEvent).mockImplementationOnce(async () => {
      vi.mocked(loadEventDetail).mockResolvedValue({
        event: { ...event, revision: 2 },
        stories: [],
      })
      vi.mocked(loadEventMembers).mockResolvedValue({
        snapshotId,
        rows: [analysis],
        total: 1,
        nextOffset: null,
      })
      window.dispatchEvent(new Event("processing-reading-invalidated"))
      return { event: { ...event, revision: 2 }, correctionId }
    })
    await click(container, "processing.events.exclude")
    expect(correctProcessingEvent).toHaveBeenCalledWith(
      "evt_alpha",
      { evt_alpha: 1 },
      { type: "exclude", inputSeq: 1, mentionId: "mention1" },
      expect.any(AbortSignal),
    )
    expect(container.textContent).not.toContain("Original report")
    expect(container.textContent).toContain("processing.events.undo")
    vi.mocked(correctProcessingEvent).mockResolvedValueOnce({
      event: { ...event, revision: 3 },
      correctionId,
    })
    await click(container, "processing.events.undo")
    expect(correctProcessingEvent).toHaveBeenLastCalledWith(
      "evt_alpha",
      { evt_alpha: 2 },
      { type: "undo", correctionId },
      expect.any(AbortSignal),
    )
    await close()
  })
  it("重命名使用revision，冲突清除旧成员并要求刷新，不自动重试", async () => {
    const { container, close } = await show()
    await open(container)
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(
        '[aria-label="processing.events.rename_label"]',
      )!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "New title",
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    vi.mocked(correctProcessingEvent).mockRejectedValueOnce(new ReadingRequestError("conflict"))
    await click(container, "processing.events.rename_save")
    expect(correctProcessingEvent).toHaveBeenCalledWith(
      "evt_alpha",
      { evt_alpha: 1 },
      { type: "rename", title: "New title" },
      expect.any(AbortSignal),
    )
    expect(container.textContent).toContain("processing.events.reload_required")
    expect(container.textContent).not.toContain("Original report")
    expect(correctProcessingEvent).toHaveBeenCalledTimes(1)
    await close()
  })
  it("合并后撤销重新核验并提交源及目标全部事件修订", async () => {
    const target = { ...event, id: "evt_beta", title: "Target event", revision: 5 }
    vi.mocked(searchProcessingEvents).mockResolvedValue({
      snapshotId,
      events: [target],
      total: 1,
      nextOffset: null,
    })
    vi.mocked(loadEventDetail).mockImplementation(async (id) => ({
      event: id === target.id ? target : event,
      stories: [],
    }))
    const { container, close } = await show()
    await open(container)
    await act(async () => {
      const select = container.querySelectorAll("select")[2]!
      select.value = "merge"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await click(container, "processing.events.search")
    await click(container, "Target event")
    await click(container, "processing.events.preview_correction")
    vi.mocked(correctProcessingEvent).mockImplementationOnce(async () => {
      vi.mocked(loadEventDetail).mockImplementation(async (id) => ({
        event:
          id === target.id
            ? { ...target, revision: 6 }
            : { ...event, revision: 2, status: "merged", mergedInto: target.id },
        stories: [],
      }))
      window.dispatchEvent(new Event("processing-reading-invalidated"))
      return {
        event: { ...event, revision: 2 },
        correctionId,
        events: [
          { ...event, revision: 2 },
          { ...target, revision: 6 },
        ],
      }
    })
    await click(container, "processing.events.confirm_correction")
    expect(correctProcessingEvent).toHaveBeenLastCalledWith(
      "evt_alpha",
      { evt_alpha: 1, evt_beta: 5 },
      { type: "merge", targetEventId: target.id },
      expect.any(AbortSignal),
    )
    vi.mocked(correctProcessingEvent).mockResolvedValueOnce({
      event: { ...event, revision: 3 },
      correctionId,
    })
    await click(container, "processing.events.undo")
    expect(correctProcessingEvent).toHaveBeenLastCalledWith(
      "evt_alpha",
      { evt_alpha: 2, evt_beta: 6 },
      { type: "undo", correctionId },
      expect.any(AbortSignal),
    )
    await close()
  })

  it("拆分后撤销核验源和两个后继事件修订，不能遗漏新事件", async () => {
    // 此用例使用完整快照；未加载全部成员的拆分禁用由工具面板测试单独覆盖。
    vi.mocked(loadEventMembers).mockResolvedValue({
      snapshotId,
      rows: [member, analysis],
      total: 2,
      nextOffset: null,
    })
    const successors = ["evt_beta", "evt_gamma"].map((id) => ({ ...event, id, revision: 1 }))
    const splitEvent = {
      ...event,
      revision: 2,
      status: "split" as const,
      splitInto: successors.map((item) => item.id),
    }
    const { container, close } = await show()
    await open(container)
    await act(async () => {
      const action = container.querySelectorAll("select")[2]!
      action.value = "split"
      action.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await act(async () => {
      const group = container.querySelectorAll("select")[4]!
      group.value = "1"
      group.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await click(container, "processing.events.preview_correction")
    vi.mocked(correctProcessingEvent).mockImplementationOnce(async () => {
      vi.mocked(loadEventDetail).mockImplementation(async (id) => ({
        event: id === event.id ? splitEvent : successors.find((item) => item.id === id)!,
        stories: [],
      }))
      window.dispatchEvent(new Event("processing-reading-invalidated"))
      return { event: splitEvent, correctionId, events: [splitEvent, ...successors] }
    })
    await click(container, "processing.events.confirm_correction")
    expect(correctProcessingEvent).toHaveBeenLastCalledWith(
      event.id,
      { evt_alpha: 1 },
      {
        type: "split",
        groups: [
          {
            title: "processing.events.split_default:1",
            members: [{ inputSeq: 1, mentionId: "mention1" }],
          },
          {
            title: "processing.events.split_default:2",
            members: [{ inputSeq: 2, mentionId: "mention2" }],
          },
        ],
      },
      expect.any(AbortSignal),
    )
    vi.mocked(correctProcessingEvent).mockResolvedValueOnce({
      event: { ...event, revision: 3 },
      correctionId,
    })
    await click(container, "processing.events.undo")
    expect(correctProcessingEvent).toHaveBeenLastCalledWith(
      event.id,
      { evt_alpha: 2, evt_beta: 1, evt_gamma: 1 },
      { type: "undo", correctionId },
      expect.any(AbortSignal),
    )
    await close()
  })

  it("后继事件同面板打开，Story沿用既有内联阅读器", async () => {
    vi.mocked(loadEventDetail).mockResolvedValueOnce({
      event: { ...event, status: "merged", mergedInto: "evt_beta", splitInto: ["evt_gamma"] },
      stories: [{ id: "story1", title: "Existing summary", revision: 1 }],
    })
    const { container, close } = await show()
    await open(container)
    await click(container, "Existing summary")
    expect(container.textContent).toContain("story1")
    vi.mocked(loadEventDetail).mockResolvedValueOnce({
      event: { ...event, id: "evt_beta", title: "Merged event" },
      stories: [],
    })
    await click(container, "processing.events.open_merged")
    expect(loadEventDetail).toHaveBeenLastCalledWith("evt_beta", expect.any(AbortSignal))
    expect(container.textContent).toContain("Merged event")
    await close()
  })
})
