import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { GeneratedEntryControls } from "./GeneratedEntryControls"

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  overrides: vi.fn(),
  request: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("./ProcessingEntryExplanation", () => ({ ProcessingEntryExplanation: () => null }))
vi.mock("./processing-reader-client", () => ({
  loadEntryOverrides: mocks.overrides,
  readingRequest: mocks.request,
  mutationSchemas: { override: {} },
}))
vi.mock("./processing-role-client", () => ({ refreshServiceProcessingRoles: mocks.refresh }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("原条目纠错账号隔离", () => {
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
    mocks.owner = "owner-a"
    mocks.overrides.mockResolvedValue(new Map([[8, { override: { revision: 2 } }]]))
    mocks.request.mockResolvedValue({})
    mocks.refresh.mockResolvedValue(undefined)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async () => {
    await act(async () => root.render(<GeneratedEntryControls inputSeq={8} />))
  }
  const click = async (mode: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === `processing.reader.override.${mode}`,
    )!
    await act(async () => button.click())
  }

  it("账号在版本读取期间改变时，不向新账号继续提交覆盖", async () => {
    const read = deferred<Map<number, { override: { revision: number } }>>()
    mocks.overrides.mockReturnValueOnce(read.promise)
    await render()
    await click("restore")
    const signal = mocks.overrides.mock.calls[0]?.[0] as AbortSignal
    mocks.owner = "owner-b"
    await render()
    expect(signal.aborted).toBe(true)
    await act(async () => read.resolve(new Map([[8, { override: { revision: 2 } }]])))
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect([...container.querySelectorAll("button")].every((button) => !button.disabled)).toBe(true)
  })

  it("覆盖提交的旧响应晚到时，不刷新新账号角色或显示失败", async () => {
    const post = deferred<object>()
    mocks.request.mockReturnValueOnce(post.promise)
    await render()
    await click("hide")
    expect(mocks.request.mock.calls[0]?.[0]).toBe("processing/entries/8/override")
    expect(mocks.request.mock.calls[0]?.[3]).toEqual({ mode: "hide", expectedRevision: 2 })
    mocks.owner = "owner-b"
    await render()
    await act(async () => post.resolve({}))
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("未换账号时沿用实际revision提交并刷新角色", async () => {
    await render()
    await click("automatic")
    expect(mocks.request.mock.calls[0]?.[3]).toEqual({ mode: "automatic", expectedRevision: 2 })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
})
