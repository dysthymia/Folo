import * as React from "react"
import { act, useLayoutEffect } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { StoryReadingActions } from "./StoryReadingActions"

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  request: vi.fn(),
  originalMode: vi.fn(),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("jotai", () => ({ useSetAtom: () => mocks.originalMode }))
vi.mock("~/modules/entry-column/atoms/processing-timeline", () => ({
  timelineContentModeAtom: {},
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { revision?: number; count?: number }) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}))
vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    onClick,
  }: {
    to: string
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  ),
}))
vi.mock("./processing-reader-client", () => ({
  readingRequest: mocks.request,
  readingStorySchema: {},
  mutationSchemas: { split: {} },
}))

function preview(title = "当前材料") {
  return {
    storyId: "old-story",
    status: "active" as const,
    expectedRevision: 7,
    inputSeqs: [11, 19],
    members: [11, 19].map((inputSeq) => ({
      inputSeq,
      sourceKey: "feed:source",
      itemId: `entry-${inputSeq}`,
      title: `${title}-${inputSeq}`,
      url: null,
      current: true,
      withdrawn: false,
    })),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("综述拆分预览和旧链接保护", () => {
  let root: Root
  let container: HTMLDivElement
  let commits: Array<{ owner: string; text: string }>
  const Probe = ({ storyId = "old-story", unavailable = false }) => {
    // 在layout阶段检查首帧，不能依赖effect事后清理旧账号材料。
    useLayoutEffect(() => {
      commits.push({ owner: mocks.owner, text: container.textContent ?? "" })
    })
    return <StoryReadingActions storyId={storyId} unavailable={unavailable} />
  }
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.originalMode.mockReset()
    mocks.owner = "owner-a"
    commits = []
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async (props: { storyId?: string; unavailable?: boolean } = {}) => {
    await act(async () => root.render(<Probe {...props} />))
  }
  const button = (key: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === key)
  const click = async (key: string) => {
    const target = button(key)
    expect(target).toBeDefined()
    await act(async () => target!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  }

  it("预览和取消只发GET，不提前拆分或改变读态", async () => {
    mocks.request.mockResolvedValue(preview())
    await render()
    await click("processing.digest.split_preview")
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0]?.[0]).toBe("stories/old-story/split-preview")
    // readingRequest无body才是GET；预览不能夹带写请求。
    expect(mocks.request.mock.calls[0]?.[3]).toBeUndefined()
    expect(container.textContent).toContain("当前材料-11")
    await click("processing.digest.split_cancel")
    expect(button("processing.digest.split_confirm")).toBeUndefined()
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it("确认只提交预览冻结的revision和成员，groups明确为空", async () => {
    mocks.request
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ kind: "split", splitInto: [], independentInputSeqs: [11, 19] })
    await render()
    await click("processing.digest.split_preview")
    expect(container.textContent).toContain('"revision":7')
    await click("processing.digest.split_confirm")
    expect(mocks.request.mock.calls[1]?.[0]).toBe("stories/old-story/split")
    expect(mocks.request.mock.calls[1]?.[3]).toEqual({
      expectedRevision: 7,
      groups: [],
      independentInputSeqs: [11, 19],
    })
    expect(mocks.request.mock.calls[2]?.[0]).toBe("stories/old-story")
    expect(mocks.request.mock.calls[2]?.[3]).toBeUndefined()
    expect(button("processing.digest.split_confirm")).toBeUndefined()
    expect(container.textContent).toContain("processing.digest.split_notice")
  })

  it("修复中的旧版本仍列出历史和撤回材料，不伪装为当前成员", async () => {
    const frozen = preview()
    frozen.members[0]!.current = false
    frozen.members[1]!.withdrawn = true
    mocks.request
      .mockResolvedValueOnce({ kind: "repairing" })
      .mockResolvedValueOnce({ ...frozen, status: "repairing" })
    await render({ unavailable: true })
    expect(container.textContent).toContain("processing.digest.repairing")
    await click("processing.digest.split_preview")
    expect(container.querySelectorAll("li")).toHaveLength(2)
    expect(container.textContent?.match(/processing.digest.historical_material/g)).toHaveLength(2)
    expect(button("processing.digest.split_confirm")).toBeDefined()
    expect(mocks.request.mock.calls.every((call) => call[3] === undefined)).toBe(true)
  })

  it("旧合并和拆分链接显示明确去向，missing提供原文入口", async () => {
    mocks.request.mockResolvedValueOnce({ kind: "merged", mergedInto: "new story" })
    await render({ unavailable: true })
    expect(container.textContent).toContain("processing.digest.merged_notice")
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/events?story=new%20story")
    expect(container.textContent).not.toContain("processing.digest.repairing")
    expect(button("processing.digest.split_preview")).toBeUndefined()
    mocks.request.mockResolvedValueOnce({
      kind: "split",
      splitInto: ["child-a", "child-b"],
      independentInputSeqs: [11],
    })
    await render({ storyId: "split-story", unavailable: true })
    expect(container.textContent).toContain("processing.digest.split_notice")
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/events?story=child-a",
      "/events?story=child-b",
      "/timeline/all/all",
    ])
    mocks.request.mockResolvedValueOnce({ kind: "missing" })
    await render({ storyId: "missing-story", unavailable: true })
    expect(container.textContent).toContain("processing.digest.independent_notice")
    expect(container.textContent).not.toContain("processing.digest.loading")
    expect(container.textContent).not.toContain("processing.digest.repairing")
    expect(button("processing.digest.split_preview")).toBeUndefined()
    await act(async () =>
      container.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    )
    expect(mocks.originalMode).toHaveBeenCalledWith("original")
  })

  it("换账号后忽略取消的旧预览和确认响应不能泄露或触发后续请求", async () => {
    const oldPreview = deferred<ReturnType<typeof preview>>()
    mocks.request.mockReturnValueOnce(oldPreview.promise)
    await render()
    await click("processing.digest.split_preview")
    const previewSignal = mocks.request.mock.calls[0]?.[2] as AbortSignal
    mocks.owner = "owner-b"
    await render()
    expect(previewSignal.aborted).toBe(true)
    await act(async () => oldPreview.resolve(preview("账号A私人材料")))
    expect(container.textContent).not.toContain("账号A私人材料")
    expect(button("processing.digest.split_confirm")).toBeUndefined()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(
      commits
        .filter((item) => item.owner === "owner-b")
        .every((item) => !item.text.includes("账号A私人材料")),
    ).toBe(true)

    // 已发出的写操作不能撤销，但旧响应绝不能继续读取旧账号去向或覆盖新账号。
    mocks.request.mockResolvedValueOnce(preview("账号B材料"))
    await click("processing.digest.split_preview")
    const oldWrite = deferred<{ ok: boolean }>()
    mocks.request.mockReturnValueOnce(oldWrite.promise)
    await click("processing.digest.split_confirm")
    const writeSignal = mocks.request.mock.calls[2]?.[2] as AbortSignal
    mocks.owner = "owner-c"
    await render()
    expect(writeSignal.aborted).toBe(true)
    await act(async () => oldWrite.resolve({ ok: true }))
    expect(mocks.request).toHaveBeenCalledTimes(3)
    expect(container.textContent).not.toContain("账号B材料")
    expect(button("processing.digest.split_confirm")).toBeUndefined()
  })

  it("预览失败收起确认入口，不保留上一次的可写冻结材料", async () => {
    mocks.request
      .mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new Error("preview failed"))
    await render()
    await click("processing.digest.split_preview")
    expect(button("processing.digest.split_confirm")).toBeDefined()
    await click("processing.digest.split_preview")
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "processing.reader.error.request",
    )
    expect(button("processing.digest.split_confirm")).toBeUndefined()
    expect(container.textContent).not.toContain("当前材料-11")
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.request.mock.calls.every((call) => call[3] === undefined)).toBe(true)
  })

  it("当前独立但冻结Story仍修复中可GET预览，合并和拆分去向不可再预览", async () => {
    mocks.request
      .mockResolvedValueOnce({ kind: "independent", story: { status: "repairing" } })
      .mockResolvedValueOnce({ ...preview(), status: "repairing" })
    await render({ unavailable: true })
    expect(container.textContent).toContain("processing.digest.independent_notice")
    await click("processing.digest.split_preview")
    expect(mocks.request.mock.calls[1]?.[0]).toBe("stories/old-story/split-preview")
    expect(mocks.request.mock.calls[1]?.[3]).toBeUndefined()
    expect(container.querySelectorAll("li")).toHaveLength(2)
    // 当前只剩单篇的判断不能抹掉冻结版本的两篇历史材料。
    expect(button("processing.digest.split_confirm")).toBeDefined()

    for (const resolution of [
      { kind: "merged", mergedInto: "new-story", story: { status: "repairing" } },
      { kind: "split", splitInto: [], independentInputSeqs: [11], story: { status: "repairing" } },
    ]) {
      mocks.request.mockResolvedValueOnce(resolution)
      await render({ storyId: `${resolution.kind}-story`, unavailable: true })
      expect(button("processing.digest.split_preview")).toBeUndefined()
      expect(button("processing.digest.split_confirm")).toBeUndefined()
    }
    expect(mocks.request).toHaveBeenCalledTimes(4)
    expect(mocks.request.mock.calls.every((call) => call[3] === undefined)).toBe(true)
  })

  it("材料HTTPS链接可点击，脚本协议和带凭据链接只显示标题", async () => {
    const frozen = preview()
    const urls = [
      "https://example.org/article?id=11",
      "javascript:alert(1)",
      "https://username:password@example.org/private",
    ]
    mocks.request.mockResolvedValueOnce({
      ...frozen,
      inputSeqs: [11, 19, 23],
      members: urls.map((url, index) => ({
        ...frozen.members[0],
        inputSeq: [11, 19, 23][index],
        title: `链接材料-${index}`,
        url,
      })),
    })
    await render()
    await click("processing.digest.split_preview")
    const members = [...container.querySelectorAll("li")]
    expect(members).toHaveLength(3)
    const link = members[0]?.querySelector("a")
    expect(link?.getAttribute("href")).toBe(urls[0])
    expect(link?.textContent).toBe("链接材料-0")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toContain("noopener")
    // 危险URL不能进入DOM的href，但材料标题仍需保留供人工识别。
    for (const member of members.slice(1)) {
      expect(member.querySelector("[href]")).toBeNull()
      expect(member.textContent).toContain("链接材料-")
    }
    expect(container.querySelectorAll("a")).toHaveLength(1)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
})
