import * as React from "react"
import { act, useLayoutEffect } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { StoryDigest } from "./processing-reader-client"
import { StoryDigestPanel } from "./StoryDigestPanel"

const mocks = vi.hoisted(() => ({ owner: "owner-a", load: vi.fn() }))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("~/components/ui/datetime", () => ({ RelativeTime: () => null }))
vi.mock("./StoryReadingActions", () => ({ StoryReadingActions: () => <div>综述去向入口</div> }))
vi.mock("./processing-reader-client", () => ({
  loadStoryDigest: mocks.load,
  ReadingRequestError: class extends Error {
    kind = "request"
  },
}))

function ready(body: string): StoryDigest {
  return {
    status: "ready",
    storyId: "same-story",
    revision: 2,
    title: "标题",
    body,
    updatedAt: "2026-10-03T00:00:00Z",
    sourceCount: 2,
    sources: [],
    sentences: [],
    uncitedSentenceCount: 0,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("综述正文首帧及人工撤回保护", () => {
  let root: Root
  let container: HTMLDivElement
  let commits: Array<{ owner: string; text: string }>
  const Probe = () => {
    // 记录commit后的layout阶段，确保保护先于异步effect清空正文。
    useLayoutEffect(() => {
      commits.push({ owner: mocks.owner, text: container.textContent ?? "" })
    })
    return <StoryDigestPanel storyId="same-story" embedded />
  }
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.owner = "owner-a"
    mocks.load.mockResolvedValue(ready("账号A私人正文"))
    commits = []
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async () => {
    await act(async () => root.render(<Probe />))
  }

  it("同一个Story深链换账号的首帧不显示旧私人正文", async () => {
    await render()
    expect(container.textContent).toContain("账号A私人正文")
    const next = deferred<StoryDigest>()
    mocks.load.mockReturnValueOnce(next.promise)
    mocks.owner = "owner-b"
    await render()
    expect(
      commits
        .filter((commit) => commit.owner === "owner-b")
        .every((commit) => !commit.text.includes("账号A私人正文")),
    ).toBe(true)
    expect(container.textContent).not.toContain("账号A私人正文")
    await act(async () => next.resolve(ready("账号B正文")))
    expect(container.textContent).toContain("账号B正文")
  })

  it("旧账号忽略取消仍晚返回的响应不能覆盖新正文", async () => {
    const old = deferred<StoryDigest>()
    mocks.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ready("账号B正文"))
    await render()
    const signal = mocks.load.mock.calls[0]?.[1] as AbortSignal
    mocks.owner = "owner-b"
    await render()
    expect(signal.aborted).toBe(true)
    await act(async () => old.resolve(ready("账号A私人正文")))
    expect(container.textContent).toContain("账号B正文")
    expect(container.textContent).not.toContain("账号A私人正文")
  })

  it("深链人工撤回立即收起ready正文，重读missing后不复活旧引文", async () => {
    await render()
    expect(container.textContent).toContain("账号A私人正文")
    const next = deferred<StoryDigest>()
    mocks.load.mockReturnValueOnce(next.promise)
    await act(async () => window.dispatchEvent(new Event("processing-reading-invalidated")))
    expect(container.textContent).not.toContain("账号A私人正文")
    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(mocks.load.mock.calls[1]?.[2]).toBeUndefined()
    await act(async () =>
      next.resolve({
        status: "missing",
        storyId: "same-story",
        revision: null,
        title: null,
        body: null,
        updatedAt: null,
        sourceCount: 0,
        sources: [],
        sentences: [],
        uncitedSentenceCount: 0,
      }),
    )
    expect(container.textContent).not.toContain("账号A私人正文")
    expect(container.textContent).toContain("综述去向入口")
  })
})
