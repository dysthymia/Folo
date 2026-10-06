import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { useProcessingEntryOverride } from "./processing-entry-override"

const mocks = vi.hoisted(() => ({
  owner: "owner",
  load: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("~/modules/information/processing-reader-client", () => ({
  loadEntryOverrides: mocks.load,
  readingRequest: mocks.write,
  mutationSchemas: { override: {} },
}))
vi.mock("~/modules/information/processing-role-client", () => ({
  refreshServiceProcessingRoles: mocks.refresh,
}))

const cleanups: Array<() => Promise<void>> = []
beforeAll(() => {
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.resetAllMocks()
  mocks.owner = "owner"
})

const show = async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let result!: ReturnType<typeof useProcessingEntryOverride>
  const Probe = () => {
    result = useProcessingEntryOverride()
    return null
  }
  const render = async () => {
    await act(async () => root.render(<Probe />))
  }
  await render()
  cleanups.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  return { current: () => result, render }
}

describe("组成员的人工恢复", () => {
  it("已知版本直接提交单成员覆盖，不查询全库，随后刷新角色", async () => {
    const probe = await show()
    await act(async () => {
      expect(await probe.current().setMode(2, "restore", 7)).toBe(true)
    })
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.write).toHaveBeenCalledWith(
      "processing/entries/2/override",
      {},
      expect.any(AbortSignal),
      { mode: "restore", expectedRevision: 7 },
    )
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it("账号切换后取消在途恢复，晚返回结果不能刷新新账号角色", async () => {
    let resolve!: () => void
    mocks.write.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done
      }),
    )
    const probe = await show()
    let pending!: Promise<boolean>
    await act(async () => {
      pending = probe.current().setMode(2, "restore", 7)
    })
    const signal = mocks.write.mock.calls[0]![2] as AbortSignal
    mocks.owner = "other"
    await probe.render()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      resolve()
      expect(await pending).toBe(false)
    })
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
