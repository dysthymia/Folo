// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { EventCorrectionTools } from "./EventCorrectionTools"
import {
  loadEventDetail,
  loadEventMembers,
  searchProcessingEvents,
} from "./processing-event-client"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { number?: number }) =>
      values?.number ? `${key}:${values.number}` : key,
  }),
}))
vi.mock("./processing-event-client", () => ({
  loadEventDetail: vi.fn(),
  loadEventMembers: vi.fn(),
  searchProcessingEvents: vi.fn(),
}))
const source = {
  id: "evt_a",
  title: "Source event",
  aliases: [],
  status: "confirmed" as const,
  revision: 2,
  mergedInto: null,
  splitInto: [],
}
const target = { ...source, id: "evt_b", title: "Target event", revision: 4 }
const rows = [1, 2].map((inputSeq) => ({
  inputSeq,
  sourceKey: "feed/a",
  itemId: `article${inputSeq}`,
  title: `Article ${inputSeq}`,
  url: null,
  publishedAt: "2026-10-06T00:00:00Z",
  contentVersion: "v1",
  decisionId: `decision${inputSeq}`,
  mentionId: `mention${inputSeq}`,
  role: "reports" as const,
  isPrimary: true,
  state: "confirmed" as const,
  evidence: [`Quote ${inputSeq}`],
}))
const snapshotId = "11111111-1111-4111-8111-111111111111"
const callbacks = { onLoadMore: vi.fn(), onClearFilters: vi.fn(), onCorrect: vi.fn(async () => {}) }
beforeEach(() => {
  vi.mocked(searchProcessingEvents).mockResolvedValue({
    snapshotId,
    events: [source, target],
    total: 2,
    nextOffset: null,
  })
  vi.mocked(loadEventDetail).mockResolvedValue({ event: target, stories: [] })
  vi.mocked(loadEventMembers).mockResolvedValue({
    snapshotId,
    rows: [],
    total: 3,
    nextOffset: null,
  })
})
afterEach(() => vi.resetAllMocks())
const show = async (filtered = false, complete = true) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const render = (key: string, filter: boolean, full: boolean) =>
    root.render(
      <EventCorrectionTools
        key={key}
        source={source}
        rows={rows}
        total={2}
        filtered={filter}
        complete={full}
        busy={false}
        {...callbacks}
      />,
    )
  await act(async () => render("first", filtered, complete))
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label)!
const click = async (container: HTMLElement, label: string) =>
  act(async () => button(container, label).click())
const select = async (element: HTMLSelectElement, value: string) =>
  act(async () => {
    element.value = value
    element.dispatchEvent(new Event("change", { bubbles: true }))
  })
const findTarget = async (container: HTMLElement) => {
  await click(container, "processing.events.search")
  await click(container, "Target event")
}

describe("EventCorrectionTools", () => {
  it("移动必须选择具体成员和目标，经可读预览再用源/目标revision提交", async () => {
    const { container, close } = await show()
    await select(container.querySelectorAll("select")[1]!, JSON.stringify([1, "mention1"]))
    await findTarget(container)
    await click(container, "processing.events.preview_correction")
    expect(container.textContent).toContain("Article 1")
    expect(container.textContent).toContain("Target event")
    expect(callbacks.onCorrect).not.toHaveBeenCalled()
    await click(container, "processing.events.confirm_correction")
    expect(callbacks.onCorrect).toHaveBeenCalledWith(
      { type: "move", inputSeq: 1, mentionId: "mention1", targetEventId: "evt_b" },
      { evt_a: 2, evt_b: 4 },
    )
    await close()
  })
  it("目标搜索分页沿用snapshot，合并预览记录整个来源和目标影响", async () => {
    vi.mocked(searchProcessingEvents).mockResolvedValueOnce({
      snapshotId,
      events: [source],
      total: 2,
      nextOffset: 1,
    })
    const { container, close } = await show()
    await select(container.querySelector("select")!, "merge")
    await click(container, "processing.events.search")
    vi.mocked(searchProcessingEvents).mockResolvedValueOnce({
      snapshotId,
      events: [target],
      total: 2,
      nextOffset: null,
    })
    await click(container, "processing.events.search_more")
    expect(searchProcessingEvents).toHaveBeenLastCalledWith(
      { search: "", offset: 1, limit: 20, snapshotId },
      expect.any(AbortSignal),
    )
    await click(container, "Target event")
    await click(container, "processing.events.preview_correction")
    expect(container.textContent).toContain("processing.events.merge_preview")
    expect(container.textContent).toContain("Article 2")
    await click(container, "processing.events.confirm_correction")
    expect(callbacks.onCorrect).toHaveBeenCalledWith(
      { type: "merge", targetEventId: "evt_b" },
      { evt_a: 2, evt_b: 4 },
    )
    await close()
  })
  it("完整未过滤成员才能拆分，逐mention分到两个非空组并预览后提交", async () => {
    const { container, render, close } = await show(true, false)
    await select(container.querySelector("select")!, "split")
    expect(button(container, "processing.events.preview_correction").disabled).toBe(true)
    await click(container, "processing.events.clear_filters")
    expect(callbacks.onClearFilters).toHaveBeenCalledOnce()
    await act(async () => render("second", false, false))
    await select(container.querySelector("select")!, "split")
    await click(container, "processing.events.load_complete")
    expect(callbacks.onLoadMore).toHaveBeenCalledOnce()
    await act(async () => render("third", false, true))
    await select(container.querySelector("select")!, "split")
    await select(container.querySelectorAll("select")[2]!, "1")
    await click(container, "processing.events.preview_correction")
    await click(container, "processing.events.confirm_correction")
    expect(callbacks.onCorrect).toHaveBeenCalledWith(
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
      { evt_a: 2 },
    )
    await close()
  })
  it("筛选/来源上下文切换取消陈旧目标请求并失效选择和预览", async () => {
    let resolve!: (value: { event: typeof target; stories: [] }) => void
    vi.mocked(loadEventDetail).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { container, render, close } = await show()
    await click(container, "processing.events.search")
    await click(container, "Target event")
    await act(async () => {
      render("different-scope", true, true)
      resolve({ event: target, stories: [] })
    })
    expect(container.textContent).not.toContain("processing.events.selected_target")
    expect(container.textContent).not.toContain("processing.events.preview_title")
    expect(callbacks.onCorrect).not.toHaveBeenCalled()
    await close()
  })
})
