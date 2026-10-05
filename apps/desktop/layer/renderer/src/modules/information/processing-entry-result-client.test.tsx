import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

import { useProcessingEntryStatus } from "./processing-entry-result-client"
import { ReadingRequestError } from "./processing-reader-client"

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
}))

vi.mock("@follow/store/entry/getter", () => ({
  getEntry: () => ({ feedId: "source", sources: [] }),
}))
vi.mock("@follow/store/user/hooks", () => ({
  useWhoami: () => ({ id: "owner" }),
}))
vi.mock("~/modules/ai-chat/local-provider", () => ({
  isLocalFoloHost: () => true,
}))
vi.mock("./processing-reader-client", () => ({
  readingRequest: mocks.read,
  ReadingRequestError: class ReadingRequestError extends Error {
    constructor(readonly kind: string) {
      super(kind)
    }
  },
}))

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)

function Probe() {
  const status = useProcessingEntryStatus("entry")
  return <span>{String(status)}</span>
}

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it("短暂故障保留已确认状态，授权故障后仍能按周期自动恢复", async () => {
  vi.useFakeTimers()
  const confirmed = {
    processed: [{ itemId: "entry", sourceKey: "feed/source", sourceId: "feed/source" }],
    results: [],
  }
  mocks.read
    .mockResolvedValueOnce(confirmed)
    .mockRejectedValueOnce(new ReadingRequestError("request"))
    .mockRejectedValueOnce(new ReadingRequestError("authorization"))
    .mockResolvedValueOnce(confirmed)

  await act(async () => root.render(<Probe />))
  expect(host.textContent).toBe("true")

  await act(async () => vi.advanceTimersByTime(60_000))
  expect(host.textContent).toBe("true")

  await act(async () => vi.advanceTimersByTime(60_000))
  expect(host.textContent).toBe("null")

  // 授权错误不能把 ownerId 清空，否则下一轮定时器无法再发起请求。
  await act(async () => vi.advanceTimersByTime(60_000))
  expect(host.textContent).toBe("true")
  expect(mocks.read).toHaveBeenCalledTimes(4)
})
