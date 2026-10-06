import type {
  EntryProcessingRelatedEntry,
  EntryProcessingRole,
} from "@follow/store/entry/processing-role"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ReadingRequestError } from "~/modules/information/processing-reader-client"

import { MergedEntriesBadge } from "./merged-entries-badge"
import { clearDuplicateGroupCache } from "./processing-duplicates-cache"
import type { DuplicateGroup } from "./processing-duplicates-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))
const mocks = vi.hoisted(() => ({
  owner: "owner",
  role: null as EntryProcessingRole | null,
  revision: "1:0",
  cachedEntries: [] as EntryProcessingRelatedEntry[],
  load: vi.fn(),
  restore: vi.fn(),
  restoreFailed: false,
  navigate: vi.fn(),
}))
vi.mock("@follow/store/entry/processing-role", () => ({
  useEntryProcessingRole: () => mocks.role,
  useEntryProcessingRoleRelatedEntries: () => mocks.cachedEntries,
  useEntryProcessingRolesRevision: () => mocks.revision,
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./processing-duplicates-client", () => ({ loadDuplicateGroup: mocks.load }))
vi.mock("./processing-entry-override", () => ({
  useProcessingEntryOverride: () => ({
    setMode: mocks.restore,
    busy: false,
    failed: mocks.restoreFailed,
  }),
}))
vi.mock("../action/processing-condition-editor", () => ({ processingButtonClass: "" }))
vi.mock("~/components/ui/datetime", () => ({ RelativeTime: () => null }))
vi.mock("~/components/ui/modal/stacked/hooks", () => ({
  useModalStack: () => ({ present: vi.fn() }),
}))
vi.mock("~/modules/information/processing-entry-result-client", () => ({
  useProcessingEntryResult: () => null,
}))
vi.mock("~/modules/information/ProcessingEntryExplanation", () => ({
  ProcessingEntryExplanation: () => null,
}))
vi.mock("~/modules/information/ProcessingEntryResultPanel", () => ({
  ProcessingEntryResultPanel: () => null,
}))
vi.mock("~/modules/information/StoryDigestPanel", () => ({ StoryDigestPanel: () => null }))

const group = (ids = ["b", "c"], fingerprint = "a".repeat(64)): DuplicateGroup => ({
  representative: {
    itemId: "a",
    inputSeq: 1,
    contentVersion: "v1",
    title: "代表",
    sourceTitle: "来源",
    publishedAt: null,
    url: null,
    reason: null,
    canRestore: false,
    overrideRevision: 0,
  },
  members: ids.map((id, index) => ({
    itemId: id,
    inputSeq: index + 2,
    contentVersion: "v1",
    title: `原文 ${id}`,
    sourceTitle: "来源",
    publishedAt: null,
    url: `https://example.test/${id}`,
    reason: "全部事实已被代表覆盖",
    canRestore: true,
    overrideRevision: 7,
  })),
  total: ids.length,
  offset: 0,
  nextOffset: null,
  fingerprint,
})

describe("重复角标与组明细", () => {
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
    clearDuplicateGroupCache()
    mocks.revision = "1:0"
    mocks.cachedEntries = []
    mocks.owner = "owner"
    mocks.restoreFailed = false
    mocks.role = {
      kind: "keeper",
      source: "service",
      inputSeq: 1,
      reason: null,
      relatedEntryIds: ["b", "c"],
    }
    mocks.load.mockResolvedValue(group())
    mocks.restore.mockResolvedValue(true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
    container.remove()
  })
  const render = async () => {
    await act(async () =>
      root.render(
        <div onClick={mocks.navigate}>
          <MergedEntriesBadge entryId="a" />
        </div>,
      ),
    )
  }
  const click = async (element: Element) => {
    await act(async () =>
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
    )
  }
  const open = async () => {
    await render()
    await click(container.querySelector("button")!)
  }
  const button = (key: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent === key)!

  it("悬停立即预览本地内容且不请求，点击才读取完整详情", async () => {
    vi.useFakeTimers()
    mocks.cachedEntries = [
      { id: "b", title: "本地报道", feedTitle: "本地来源", publishedAt: null, url: null },
    ]
    await render()
    await act(async () => {
      container
        .querySelector("button")!
        .dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(document.body.textContent).toContain("本地报道")
    expect(document.body.textContent).toContain("processing.duplicates.preview_hint")
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it("首屏请求未完成也展示已有报道，完成后再次打开复用明细", async () => {
    mocks.cachedEntries = [
      { id: "b", title: "本地报道", feedTitle: "本地来源", publishedAt: null, url: null },
    ]
    let resolve!: (value: DuplicateGroup) => void
    mocks.load.mockReturnValueOnce(
      new Promise<DuplicateGroup>((done) => {
        resolve = done
      }),
    )
    await open()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("本地报道")
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "processing.duplicates.loading",
    )
    expect(button("processing.reader.override.restore")).toBeUndefined()
    await act(async () => resolve(group()))
    await click(container.querySelector("button")!)
    await click(container.querySelector("button")!)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("原文 b")
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it("首次点击立即展开已同步理由，权限请求未完成也能阅读且不能恢复", async () => {
    mocks.cachedEntries = [
      {
        id: "b",
        title: "本地报道",
        feedTitle: "本地来源",
        publishedAt: null,
        url: null,
        reason: "已同步的完整覆盖理由",
      },
    ]
    let resolve!: (value: DuplicateGroup) => void
    mocks.load.mockReturnValueOnce(
      new Promise<DuplicateGroup>((done) => {
        resolve = done
      }),
    )
    await open()
    const explanation = document.querySelector("details")!
    expect(explanation.textContent).toContain("已同步的完整覆盖理由")
    explanation.open = true
    expect(button("processing.reader.override.restore")).toBeUndefined()
    await act(async () => resolve(group()))
    expect(document.querySelector("details")).toBe(explanation)
    expect(explanation.open).toBe(true)
    expect(explanation.textContent).toContain("全部事实已被代表覆盖")
    expect(button("processing.reader.override.restore")).toBeDefined()
  })

  it("关系版本变化或账号切换后重新读取，不复用旧详情", async () => {
    await open()
    await click(container.querySelector("button")!)
    mocks.revision = "2:0"
    mocks.role = { ...mocks.role!, relatedEntryIds: ["d"] }
    mocks.load.mockResolvedValueOnce(group(["d"]))
    await render()
    await click(container.querySelector("button")!)
    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("原文 d")
    mocks.owner = "other"
    await render()
    await click(container.querySelector("button")!)
    expect(mocks.load).toHaveBeenCalledTimes(3)
  })

  it("其他文章引起全局版本变化时保留当前组缓存", async () => {
    await open()
    mocks.revision = "2:0"
    mocks.role = structuredClone(mocks.role)
    await render()
    expect(mocks.load).toHaveBeenCalledTimes(1)
    await click(container.querySelector("button")!)
    await click(container.querySelector("button")!)
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("原文 b")
  })

  it("明细缓存到期重新读取，更新期间仍显示本地报道", async () => {
    vi.useFakeTimers()
    mocks.cachedEntries = [
      { id: "b", title: "本地报道", feedTitle: "本地来源", publishedAt: null, url: null },
    ]
    await open()
    await click(container.querySelector("button")!)
    await act(async () => vi.advanceTimersByTimeAsync(60_001))
    mocks.load.mockReturnValueOnce(new Promise<DuplicateGroup>(() => {}))
    await click(container.querySelector("button")!)
    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("本地报道")
  })

  it("不依赖本地条目缓存计数，去除自身和重复身份，点击后才读取且不打开条目", async () => {
    mocks.role!.relatedEntryIds = ["b", "c", "b", "a"]
    await render()
    expect(container.textContent).toBe("+2")
    expect(mocks.load).not.toHaveBeenCalled()
    await click(container.querySelector("button")!)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("原文 b")
    expect(document.querySelectorAll("details")).toHaveLength(2)
    expect(mocks.load).toHaveBeenCalledWith(1, expect.any(AbortSignal), undefined)
    expect(mocks.navigate).not.toHaveBeenCalled()
    await click(document.querySelector("summary")!)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it("综述计数沿用完整服务端材料数，merged 条目不误显 +N", async () => {
    mocks.role = { ...mocks.role!, kind: "story", storyId: "story", materialCount: 26 }
    await render()
    expect(container.textContent).toBe("processing.badge.story26")
    mocks.role = { ...mocks.role!, kind: "merged", storyId: undefined }
    await render()
    expect(container.textContent).toBe("")
  })

  it("逐条恢复携带已读取覆盖版本，失败保留列表并允许重试，成功重读组", async () => {
    mocks.restore.mockResolvedValueOnce(false)
    await open()
    await click(button("processing.reader.override.restore"))
    expect(mocks.restore).toHaveBeenCalledWith(2, "restore", 7)
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain("原文 b")
    mocks.load.mockResolvedValueOnce(group(["c"]))
    await click(button("processing.reader.override.restore"))
    expect(document.body.textContent).not.toContain("原文 b")
    expect(document.body.textContent).toContain("原文 c")
  })

  it("分页失败可重试；组版本冲突会刷新首屏而不是追加旧成员", async () => {
    const first = { ...group(["b"]), total: 2, nextOffset: 1 }
    mocks.load
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new ReadingRequestError("request"))
    await open()
    await click(button("processing.duplicates.more"))
    expect(document.body.textContent).toContain("processing.duplicates.failed")
    expect(document.body.textContent).toContain("原文 b")
    mocks.load
      .mockRejectedValueOnce(new ReadingRequestError("conflict"))
      .mockResolvedValueOnce(group(["d"], "b".repeat(64)))
    await click(button("processing.duplicates.retry"))
    expect(mocks.load).toHaveBeenNthCalledWith(3, 1, expect.any(AbortSignal), {
      offset: 1,
      expectedFingerprint: first.fingerprint,
    })
    expect(document.body.textContent).toContain("原文 d")
    expect(document.body.textContent).not.toContain("原文 b")
  })

  it("账号切换中止加载，忽略晚返回的旧账号内容", async () => {
    let resolve!: (value: DuplicateGroup) => void
    mocks.load.mockReturnValueOnce(
      new Promise<DuplicateGroup>((done) => {
        resolve = done
      }),
    )
    await open()
    const signal = mocks.load.mock.calls[0]![1] as AbortSignal
    mocks.owner = "other"
    await render()
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(group()))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain("原文 b")
  })

  it("本地缓存缺失成员保留占位，末位恢复后面板留在原处显示完成", async () => {
    mocks.role = { ...mocks.role!, source: "local-dedupe", inputSeq: undefined }
    await open()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(
      document
        .querySelector('[role="dialog"]')
        ?.textContent?.match(/processing.duplicates.unavailable/g),
    ).toHaveLength(2)
    await click(container.querySelector("button")!)
    mocks.role = { ...mocks.role!, source: "service", inputSeq: 1 }
    await render()
    await click(container.querySelector("button")!)
    mocks.restore.mockImplementationOnce(async () => {
      mocks.role = null
      await render()
      return true
    })
    await click(button("processing.reader.override.restore"))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "processing.duplicates.complete",
    )
  })
})
