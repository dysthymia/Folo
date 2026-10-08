// @vitest-environment jsdom
import type { SemanticEntity } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useProcessingEntryResult } from "~/modules/information/processing-entry-result-client"

import { EntrySemanticTagList, EntrySemanticTags } from "./entry-semantic-tags"

vi.mock("~/modules/information/processing-entry-result-client", () => ({
  useProcessingEntryResult: vi.fn(),
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "semantic.tag.topic:blockchain": "区块链",
        "semantic.tag.topic:ai": "AI",
        "semantic.tag.topic:product": "产品",
        "semantic.tag.event:product_launch": "产品发布",
      })[key] ?? key,
  }),
}))
// 折叠内容只在展开后挂载，避免测试把隐藏标签误认为列表可见。
vi.mock("@follow/components/ui/popover/index.js", () => ({
  Popover: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverContent: () => null,
}))

const entity = (name: string, parentName: string | null = null): SemanticEntity => ({
  kind: parentName ? "product" : "organization",
  name,
  parentName,
  aliases: [],
  confidence: 0.98,
  evidenceIds: ["e1"],
})
const mounts: Array<() => Promise<void>> = []
async function render(element: React.ReactElement) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  mounts.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  return container
}
afterEach(async () => {
  for (const unmount of mounts.splice(0)) await unmount()
  vi.clearAllMocks()
})

describe("EntrySemanticTagList", () => {
  it("组合领域产品并保留事件与完整实体名称", async () => {
    const host = await render(
      <EntrySemanticTagList
        tags={["topic:blockchain", "topic:product", "event:product_launch"]}
        entities={[entity("MagicBlock Validator", "MagicBlock"), entity("Revolut")]}
        showAll
      />,
    )
    expect(host.textContent).toContain("区块链-产品")
    expect(host.textContent).toContain("产品发布")
    expect(host.textContent).toContain("MagicBlock Validator")
    expect(host.textContent).not.toContain("MagicBlock MagicBlock")
    expect(host.textContent).toContain("Revolut")
    expect(host.textContent).not.toContain("organization:")
    expect(host.querySelector(".truncate")).toBeNull()
    expect(host.querySelector("button")).toBeNull()
  })

  it("旧投影兼容且列表不增加逐实体请求，折叠主实体而展开保留全部", async () => {
    const result = {
      itemId: "entry",
      sourceKey: "feed/source",
      sourceId: "feed/source",
      inputSeq: 1,
      decisionId: "decision",
      contentVersion: "v1",
      releaseVersion: 1,
      semanticTags: ["topic:ai", "topic:product"] as const,
      semanticEntities: [entity("Revolut"), entity("Validator", "MagicBlock"), entity("Third")],
    }
    vi.mocked(useProcessingEntryResult).mockReturnValue(result)
    const host = await render(<EntrySemanticTags entryId="entry" />)
    expect(host.textContent).toContain("AI-产品")
    expect(host.textContent).toContain("MagicBlock Validator")
    expect(host.textContent).not.toContain("Third")
    expect(host.querySelector("button")?.textContent).toBe("+1")
    expect(useProcessingEntryResult).toHaveBeenCalledWith("entry")
    const all = await render(<EntrySemanticTagList entities={result.semanticEntities} showAll />)
    expect(all.textContent).toContain("Third")
    const empty = await render(<EntrySemanticTagList />)
    expect(empty.textContent).toBe("")
  })
})
