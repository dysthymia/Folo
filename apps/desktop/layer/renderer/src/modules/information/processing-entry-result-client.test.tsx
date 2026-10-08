// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

import {
  useProcessingEntryResult,
  useProcessingEntryStatus,
} from "./processing-entry-result-client"
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
  const result = useProcessingEntryResult("entry")
  return (
    <span>
      {String(status)}
      {result?.semanticTags?.join(",")}
      {result?.semanticEntities?.map((entity) => entity.name).join(",")}
    </span>
  )
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
    .mockResolvedValueOnce({
      ...confirmed,
      results: [
        {
          itemId: "entry",
          sourceKey: "feed/source",
          sourceId: "feed/source",
          inputSeq: 1,
          contentVersion: "v1",
          decisionId: "new",
          releaseVersion: 1,
          semanticTags: ["topic:ai"],
          semanticEntities: [
            {
              kind: "organization",
              name: "Revolut",
              parentName: null,
              aliases: [],
              confidence: 0.99,
              evidenceIds: ["e1"],
            },
          ],
        },
      ],
    })

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
  // 人工纠错无需等待一分钟；状态图标和标签订阅共用一次刷新。
  await act(async () => {
    window.dispatchEvent(new Event("processing-reading-invalidated"))
  })
  expect(host.textContent).toBe("truetopic:aiRevolut")
  expect(mocks.read).toHaveBeenCalledTimes(5)
  // 批量接口的实际 schema 必须保留实体，不能在解析时静默丢弃。
  const schema = mocks.read.mock.calls[4]![1]
  expect(
    schema.parse({
      results: [
        {
          itemId: "entry",
          sourceKey: "feed/source",
          sourceId: "feed/source",
          inputSeq: 1,
          contentVersion: "v1",
          decisionId: "new",
          releaseVersion: 1,
          semanticEntities: [
            {
              kind: "organization",
              name: "Revolut",
              parentName: null,
              aliases: [],
              confidence: 0.99,
              evidenceIds: ["e1"],
            },
          ],
        },
      ],
    }).results[0].semanticEntities[0].name,
  ).toBe("Revolut")
})
