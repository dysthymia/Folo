import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ResearchSelectionPanel } from "./ResearchSelectionControls"

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  preview: vi.fn(),
  run: vi.fn(),
  load: vi.fn(),
  history: vi.fn(),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("@follow/store/entry/hooks", () => ({ useEntry: vi.fn() }))
vi.mock("@follow/store/subscription/getter", () => ({ getSubscriptionByEntryId: vi.fn() }))
vi.mock("~/modules/ai-chat/local-provider", () => ({ isLocalFoloHost: () => true }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./research-client", () => ({ loadResearchPacks: mocks.history }))
vi.mock("./research-selection-client", () => ({
  previewResearchSelection: mocks.preview,
  runResearchSelection: mocks.run,
  loadResearchSelection: mocks.load,
}))
vi.mock("./processing-reader-client", () => ({ ReadingRequestError: class extends Error {} }))

const entries = [{ sourceKey: "feed/f1", entryId: "old-read", title: "已读历史材料" }]
const preview = {
  selectionCount: 1,
  totalCharacters: 200,
  estimatedModelCalls: 2,
  canExecute: true,
  missingContext: [],
  materials: [
    {
      materialId: "material:original",
      sourceKey: "feed/f1",
      entryId: "old-read",
      inputSeq: 7,
      title: "历史",
      characters: 200,
    },
  ],
  selectionToken: "11111111-1111-4111-8111-111111111111",
}
const pack = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "completed",
  title: "已完成的历史研究",
  markdown: "# 有原文引用的研究",
  target: { kind: "selection", entries },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("历史选材研究的显式执行与账号隔离", () => {
  let root: Root, container: HTMLDivElement
  const onBusy = vi.fn(),
    onRemove = vi.fn(),
    onClose = vi.fn()
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.owner = "owner-a"
    mocks.history.mockResolvedValue({ packs: [] })
    mocks.preview.mockResolvedValue({ preview })
    mocks.run.mockResolvedValue({ pack })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async (materials = entries) => {
    await act(async () =>
      root.render(
        <ResearchSelectionPanel
          owner={mocks.owner}
          entries={materials}
          onBusy={onBusy}
          onRemove={onRemove}
          onClose={onClose}
        />,
      ),
    )
  }
  const button = (key: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === key)!
  const click = async (key: string) => {
    await act(async () => button(key).click())
  }
  const fill = async () => {
    for (const [index, value] of ["这些历史材料有哪些变化？", "核对原始披露及分歧"].entries()) {
      await act(async () => {
        const textarea = container.querySelectorAll("textarea")[index]!
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          textarea,
          value,
        )
        textarea.dispatchEvent(new Event("input", { bubbles: true }))
        textarea.dispatchEvent(new Event("change", { bubbles: true }))
      })
    }
  }

  it("预览不会运行模型，显式执行携带冻结token和所选原文", async () => {
    await render()
    await fill()
    expect(button("information.selection.run").disabled).toBe(true)
    await click("information.selection.preview")
    expect(mocks.run).not.toHaveBeenCalled()
    expect(button("information.selection.run").disabled).toBe(false)
    await click("information.selection.run")
    expect(mocks.run.mock.calls[0]![0]).toMatchObject({
      target: { kind: "selection", entries: [{ sourceKey: "feed/f1", entryId: "old-read" }] },
      selectionToken: preview.selectionToken,
      idempotencyKey: expect.stringMatching(/^[\w-]{16,80}$/u),
    })
    expect(container.textContent).toContain(pack.markdown)
    expect(button("information.selection.run").disabled).toBe(true)
  })

  it("缺上下文只显示待补提示，不能执行", async () => {
    mocks.preview.mockResolvedValue({
      preview: {
        ...preview,
        canExecute: false,
        estimatedModelCalls: 0,
        missingContext: [
          { sourceKey: "feed/f1", entryId: "old-read", reasons: ["links", "unknown_future"] },
        ],
      },
    })
    await render()
    await fill()
    await click("information.selection.preview")
    expect(container.textContent).toContain("information.selection.missing")
    // 已知原因显示人类文案，未来新增原因也不能泄露内部技术枚举。
    expect(container.textContent).toContain("information.selection.context_links")
    expect(container.textContent).toContain("information.selection.context_unknown")
    expect(container.textContent).not.toContain("unknown_future")
    expect(container.textContent).not.toMatch(/(?:^|\W)links(?:$|\W)/u)
    expect(button("information.selection.run").disabled).toBe(true)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it("传输错误后重试复用幂等key，不再创建另一份付费请求", async () => {
    mocks.run.mockRejectedValueOnce(new Error("network"))
    await render()
    await fill()
    await click("information.selection.preview")
    await click("information.selection.run")
    await click("information.selection.run")
    expect(mocks.run).toHaveBeenCalledTimes(2)
    expect(mocks.run.mock.calls[1]![0].idempotencyKey).toBe(
      mocks.run.mock.calls[0]![0].idempotencyKey,
    )
  })

  it("换账号终止旧请求，晚返回不能显示旧研究", async () => {
    const pending = deferred<{ pack: typeof pack }>()
    mocks.run.mockReturnValueOnce(pending.promise)
    await render()
    await fill()
    await click("information.selection.preview")
    await click("information.selection.run")
    const signal: AbortSignal = mocks.run.mock.calls[0]![1]
    mocks.owner = "owner-b"
    await render()
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve({ pack }))
    expect(container.textContent).not.toContain(pack.markdown)
    expect(container.querySelector("[role=status]")).toBeNull()
  })
})
