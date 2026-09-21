import type { RuleSet } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { ProcessingEditor } from "./processing-client"
import { ProcessingReleasePanel } from "./processing-release-panel"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}))

vi.mock("../ai-chat/local-provider", () => ({
  getOneTimeToken: vi.fn(),
}))

const historicalRule = {
  id: "rule-1",
  ownerId: "owner",
  name: "旧规则",
  enabled: true,
  order: 0,
  version: 1,
  executionLocation: "processing_service" as const,
  when: { all: true } as const,
  actions: [{ type: "ai_transform" as const, prompt: "旧指令" }],
}
const historicalConfig: RuleSet = {
  formatVersion: 4,
  ownerId: "owner",
  global: { version: 1, markdown: "旧全局 Prompt" },
  rules: [historicalRule],
}
const currentConfig: RuleSet = {
  ...historicalConfig,
  global: { version: 2, markdown: "当前全局 Prompt" },
  rules: [
    { ...historicalRule, name: "当前规则", version: 2 },
    { ...historicalRule, id: "rule-2", name: "新增规则", order: 1 },
  ],
}
const releases: ProcessingEditor["releases"] = [
  {
    version: 1,
    draftRevision: 1,
    activationSeq: 4,
    scope: { mode: "future" },
    targetInputIds: [1, 2],
    createdAt: "2026-09-18T00:00:00.000Z",
  },
]

describe("ProcessingReleasePanel", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it("按服务端口径展示四类发布影响", async () => {
    const client = {
      previewRelease: vi.fn().mockResolvedValue({
        scope: { mode: "future" },
        targetInputIds: [1, 2, 3],
        impact: {
          newAssignments: 1,
          recalculated: 2,
          queuedUnchanged: 4,
          historicalUnchanged: 5,
        },
      }),
      loadRelease: vi.fn(),
    }
    await act(async () => {
      root!.render(
        <ProcessingReleasePanel
          config={currentConfig}
          releases={releases}
          scope={{ mode: "future" }}
          client={client}
        />,
      )
    })

    expect(client.previewRelease).toHaveBeenCalledWith({ mode: "future" }, expect.any(AbortSignal))
    expect(container!.textContent).toContain("processing.release_preview.target:3")
    expect(container!.textContent).toContain("processing.release_preview.new_assignments:1")
    expect(container!.textContent).toContain("processing.release_preview.recalculated:2")
    expect(container!.textContent).toContain("processing.release_preview.queued_unchanged:4")
    expect(container!.textContent).toContain("processing.release_preview.historical_unchanged:5")
  })

  it("等价 scope 不重复预览，切到空选择时立即结束加载", async () => {
    const client = {
      previewRelease: vi.fn(() => new Promise<never>(() => {})),
      loadRelease: vi.fn(),
    }
    await act(async () => {
      root!.render(
        <ProcessingReleasePanel
          config={currentConfig}
          releases={releases}
          scope={{ mode: "future" }}
          client={client}
        />,
      )
    })
    expect(container!.textContent).toContain("processing.release_preview.loading")

    await act(async () => {
      root!.render(
        <ProcessingReleasePanel
          config={currentConfig}
          releases={releases}
          scope={{ mode: "future" }}
          client={client}
        />,
      )
    })
    expect(client.previewRelease).toHaveBeenCalledTimes(1)

    await act(async () => {
      root!.render(
        <ProcessingReleasePanel
          config={currentConfig}
          releases={releases}
          scope={{ mode: "selected", inputIds: [] }}
          client={client}
        />,
      )
    })
    expect(container!.textContent).not.toContain("processing.release_preview.loading")
  })

  it("只读加载历史版本并对比全局 Prompt 和规则", async () => {
    const client = {
      previewRelease: vi.fn().mockResolvedValue({
        scope: { mode: "future" },
        targetInputIds: [],
        impact: {
          newAssignments: 0,
          recalculated: 0,
          queuedUnchanged: 0,
          historicalUnchanged: 0,
        },
      }),
      loadRelease: vi.fn().mockResolvedValue({ release: releases[0], config: historicalConfig }),
    }
    await act(async () => {
      root!.render(
        <ProcessingReleasePanel
          config={currentConfig}
          releases={releases}
          scope={{ mode: "future" }}
          client={client}
        />,
      )
    })
    const releaseButton = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("v1"),
    )!
    await act(async () => releaseButton.click())

    expect(client.loadRelease).toHaveBeenCalledWith(1, expect.any(AbortSignal))
    expect(container!.textContent).toContain("旧全局 Prompt")
    expect(container!.textContent).toContain("当前全局 Prompt")
    expect(container!.textContent).toContain("processing.release_history.status.changed")
    expect(container!.textContent).toContain("processing.release_history.status.added")
    expect(container!.textContent).not.toContain("processing.release_history.restore")
  })
})
