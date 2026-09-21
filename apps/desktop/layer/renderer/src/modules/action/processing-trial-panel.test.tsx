import type { RuleSet } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ProcessingTrialPanel } from "./processing-trial-panel"

const { trial } = vi.hoisted(() => ({ trial: vi.fn() }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("./processing-client", () => ({ createProcessingClient: () => ({ trial }) }))
const config: RuleSet = {
  formatVersion: 4,
  ownerId: "owner",
  global: { version: 1, markdown: "处理要求" },
  rules: [],
}
const output = {
  original: { title: "原文", text: "原文事实" },
  before: null,
  after: { title: "新标题", summary: "新摘要", status: "keep", reason: "保留原因", facts: [] },
  model: "test",
  usage: null,
  aggregation: [],
}

describe("样本 AI 前后对照", () => {
  let root: Root
  let container: HTMLDivElement
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    trial.mockReset()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  it("只有显式点击才试运行，展示已发布/草稿对照与原文", async () => {
    trial.mockResolvedValue(output)
    await act(async () =>
      root.render(<ProcessingTrialPanel config={config} sourceKey="feed/1" entryId="e1" valid />),
    )
    expect(trial).not.toHaveBeenCalled()
    await act(async () => container.querySelector("button")!.click())
    expect(trial.mock.calls[0]?.slice(0, 3)).toEqual([config, "feed/1", "e1"])
    expect(container.textContent).toContain("processing.trial_before")
    expect(container.textContent).toContain("processing.trial_no_before")
    expect(container.textContent).toContain("新标题")
    expect(container.textContent).toContain("原文事实")
  })
  it("换样本取消请求，不展示晚到的旧结果", async () => {
    let resolve: (value: typeof output) => void = () => {}
    trial.mockReturnValue(
      new Promise<typeof output>((done) => {
        resolve = done
      }),
    )
    await act(async () =>
      root.render(<ProcessingTrialPanel config={config} sourceKey="feed/1" entryId="e1" valid />),
    )
    await act(async () => container.querySelector("button")!.click())
    const signal = trial.mock.calls[0]![3] as AbortSignal
    await act(async () =>
      root.render(<ProcessingTrialPanel config={config} sourceKey="feed/1" entryId="e2" valid />),
    )
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(output))
    expect(container.textContent).not.toContain("新标题")
  })
})
