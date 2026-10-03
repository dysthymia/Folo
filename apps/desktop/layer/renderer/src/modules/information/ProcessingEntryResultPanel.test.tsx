// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { readingRequest } from "./processing-reader-client"
import { ProcessingEntryResultPanel } from "./ProcessingEntryResultPanel"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./processing-reader-client", () => ({ readingRequest: vi.fn() }))

const request = vi.mocked(readingRequest)
afterEach(() => request.mockReset())

const entry = {
  seq: 2,
  sourceKey: "feed/a",
  itemId: "entry-a",
  contentVersion: "v2",
  decisionId: "decision-2",
  decision: {
    status: "keep",
    title: "AI 标题",
    summary: "AI 摘要",
    reason: "命中规则",
  },
}

const show = async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ProcessingEntryResultPanel
        inputSeq={2}
        sourceKey="feed/a"
        itemId="entry-a"
        contentVersion="v2"
        decisionId="decision-2"
      />,
    )
  })
  return { container, root }
}

describe("ProcessingEntryResultPanel", () => {
  it("loads the decision lazily and shows only the generated result", async () => {
    request.mockResolvedValueOnce({ entry })
    const { container, root } = await show()
    expect(request).toHaveBeenCalledWith(
      "processing/entries/2",
      expect.anything(),
      expect.anything(),
    )
    expect(container.textContent).toContain("AI 标题")
    expect(container.textContent).toContain("AI 摘要")
    await act(async () => root.unmount())
    container.remove()
  })

  it("does not show a stale decision after the index changes", async () => {
    request.mockResolvedValueOnce({ entry: { ...entry, decisionId: "old-decision" } })
    const { container, root } = await show()
    expect(container.textContent).toContain("processing.result.unavailable")
    expect(container.textContent).not.toContain("AI 摘要")
    await act(async () => root.unmount())
    container.remove()
  })
})
