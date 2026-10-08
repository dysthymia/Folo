import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { ProcessingEntryResult } from "~/modules/information/processing-entry-result-match"

import { EntryProcessingStatusIcon } from "./processing-status-icon"

const mocks = vi.hoisted(() => ({
  processed: true as boolean | null,
  result: null as ProcessingEntryResult | null,
  present: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("~/modules/ai-chat/local-provider", () => ({ isLocalFoloHost: () => true }))
vi.mock("~/components/ui/modal/stacked/hooks", () => ({
  useModalStack: () => ({ present: mocks.present }),
}))
vi.mock("~/modules/information/processing-entry-result-client", () => ({
  useProcessingEntryResult: () => mocks.result,
  useProcessingEntryStatus: () => mocks.processed,
}))
vi.mock("~/modules/information/ProcessingEntryResultPanel", () => ({
  ProcessingEntryResultPanel: () => null,
}))

describe("条目 AI 状态图标", () => {
  let root: Root
  let container: HTMLDivElement
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.processed = true
    mocks.result = null
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async () => {
    await act(async () =>
      root.render(
        <div onClick={mocks.navigate}>
          <EntryProcessingStatusIcon entryId="entry" />
        </div>,
      ),
    )
  }

  it("点击状态图标打开当前决定的结果弹窗，且不触发文章导航", async () => {
    mocks.result = {
      itemId: "entry",
      sourceKey: "feed/source",
      sourceId: "feed/source",
      inputSeq: 7,
      decisionId: "decision",
      contentVersion: "version",
      releaseVersion: 10,
    }
    await render()
    const button = container.querySelector("button")!
    expect(button.getAttribute("aria-label")).toContain("processing.result.view")
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    await act(async () => button.dispatchEvent(click))
    expect(click.defaultPrevented).toBe(true)
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.present).toHaveBeenCalledTimes(1)
    const modal = mocks.present.mock.calls[0]![0]
    expect(modal.content().props).toMatchObject({
      inputSeq: 7,
      decisionId: "decision",
      contentVersion: "version",
    })
  })

  it("尚未处理时保留状态提示，不提供失效的详情按钮", async () => {
    mocks.processed = false
    await render()
    expect(container.querySelector("button")).toBeNull()
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "processing.status.no_completed_result",
    )
    expect(mocks.present).not.toHaveBeenCalled()
  })
})
