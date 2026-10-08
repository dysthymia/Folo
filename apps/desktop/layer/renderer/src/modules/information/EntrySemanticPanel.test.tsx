// @vitest-environment jsdom
import { semanticTagDefinition } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import zh from "../../../../../../../locales/app/zh-CN.json"
import { EntrySemanticPanel } from "./EntrySemanticPanel"
import type { EntrySemanticProfile } from "./processing-semantic-client"
import { loadEntrySemantics, saveEntrySemanticOverride } from "./processing-semantic-client"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      [key, ...Object.values(values ?? {})].join(" "),
  }),
}))
vi.mock("./processing-semantic-client", () => ({
  loadEntrySemantics: vi.fn(),
  saveEntrySemanticOverride: vi.fn(),
}))

const profile: EntrySemanticProfile = {
  schemaVersion: 2,
  contentVersion: "v2",
  materialDigest: "material",
  definitionDigest: "definition",
  assessedTagIds: ["topic:ai"],
  assessments: [
    {
      tagId: "topic:ai",
      definitionVersion: 1,
      state: "present",
      confidence: 0.9,
      reason: "AI methods",
      evidenceIds: ["e1"],
    },
  ],
  evidence: { e1: "Original evidence" },
  coverage: "partial",
}
const response = {
  profile,
  assessments: profile.assessments,
  overrideRevision: 2,
  decisionId: "decision",
}
afterEach(() => vi.clearAllMocks())
const show = async (semanticProfile: EntrySemanticProfile = profile) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(<EntrySemanticPanel profile={semanticProfile} inputSeq={1} contentVersion="v2" />),
  )
  return { container, root }
}
const click = async (button: HTMLButtonElement) => act(async () => button.click())

describe("EntrySemanticPanel", () => {
  it("实体显示类别、所属、别名、置信度和正文证据，无实体旧画像无需请求", async () => {
    const { container, root } = await show({
      ...profile,
      entityVersion: 1,
      entities: [
        {
          kind: "product",
          name: "MagicBlock Validator",
          parentName: "MagicBlock",
          aliases: ["Validator"],
          confidence: 0.98,
          evidenceIds: ["e1", "missing"],
        },
      ],
    })
    expect(container.textContent).toContain("MagicBlock Validator")
    expect(container.textContent).toContain("semantic.entity.kind.product")
    expect(container.textContent).toContain("semantic.entity.parent MagicBlock")
    expect(container.textContent).toContain("semantic.entity.aliases Validator")
    expect(container.textContent).toContain("semantic.entity.confidence 98")
    expect(container.textContent).toContain("Original evidence")
    expect(container.textContent).toContain("semantic.evidence_unavailable")
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false)
    expect(loadEntrySemantics).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    container.remove()
  })

  it("显示未评估为未知以及证据，只在纠错时读取人工修订", async () => {
    vi.mocked(loadEntrySemantics).mockResolvedValue(response)
    vi.mocked(saveEntrySemanticOverride).mockResolvedValue({ ...response, overrideRevision: 3 })
    const { container, root } = await show()
    expect(container.textContent).toContain("semantic.not_assessed")
    expect(container.textContent).toContain("semantic.state.unknown")
    expect(container.textContent).toContain("Original evidence")
    expect(loadEntrySemantics).not.toHaveBeenCalled()
    await click(container.querySelector("button")!)
    await click(container.querySelectorAll("button")[1]!)
    expect(saveEntrySemanticOverride).toHaveBeenCalledWith(
      1,
      "v2",
      2,
      "form:pure_entertainment",
      "present",
      expect.any(AbortSignal),
    )
    expect(container.textContent).toContain("semantic.correct_saved")
    await act(async () => root.unmount())
    container.remove()
  })

  it("旧正文不能覆盖新版语义，冲突后不盲目重复保存", async () => {
    vi.mocked(loadEntrySemantics).mockResolvedValue({
      ...response,
      profile: { ...profile, contentVersion: "v3" },
    })
    const { container, root } = await show()
    await click(container.querySelector("button")!)
    expect(container.querySelectorAll("button")[1]!.disabled).toBe(true)
    expect(container.textContent).toContain("semantic.correct_error")
    vi.mocked(loadEntrySemantics).mockResolvedValue(response)
    vi.mocked(saveEntrySemanticOverride).mockRejectedValue(new Error("conflict"))
    await click(container.querySelector("button")!)
    await click(container.querySelectorAll("button")[1]!)
    expect(container.querySelectorAll("button")[1]!.disabled).toBe(true)
    expect(container.textContent).not.toContain("semantic.correct_saved")
    await act(async () => root.unmount())
    container.remove()
  })
})

// 同一标签的界面说明与模型定义保持一致，避免将转账误解为资金流统计。
it("资金流的中文详情说明与模型定义一致", () => {
  expect(zh["semantic.definition.event:fund_flow"]).toBe(
    semanticTagDefinition("event:fund_flow")?.description,
  )
})
