import type { EntryModel } from "@follow/store/entry/types"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { LoadedEntryRef } from "./use-list-load-processing"
import { listedProcessingEntries, useListLoadProcessing } from "./use-list-load-processing"

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  local: true,
  entries: {} as Record<string, EntryModel>,
  listener: null as null | ((state: { whoami: { id: string } }) => void),
}))
vi.mock("@follow/store/entry/store", () => ({
  entryActions: { getFlattenMapEntries: () => mocks.entries },
}))
vi.mock("@follow/store/user/store", () => ({
  useUserStore: {
    subscribe: (listener: typeof mocks.listener) => {
      mocks.listener = listener
      return () => {
        if (mocks.listener === listener) mocks.listener = null
      }
    },
  },
}))
vi.mock("~/modules/ai-chat/local-provider", () => ({
  getOneTimeToken: vi.fn(),
  isLocalFoloHost: () => mocks.local,
}))
vi.mock("~/modules/action/processing-client", () => ({
  createProcessingClient: () => ({ notifyListLoaded: mocks.notify }),
}))

const makeEntry = (id: string, read: boolean | null = false): EntryModel => ({
  id,
  guid: id,
  title: `条目 ${id}`,
  feedId: "1",
  read,
  publishedAt: new Date("2026-10-04T10:00:00Z"),
  insertedAt: new Date("2026-10-04T10:00:00Z"),
  content: "不能把这个正文直接提交给模型。",
  description: "列表摘要",
  url: null,
})
const refs = (ids: string[]): LoadedEntryRef[] =>
  ids.map((entryId) => ({ entryId, sourceKey: "feed/1" }))
function Fixture({
  ids,
  owner = "owner",
  enabled = true,
  version = 1,
}: {
  ids: LoadedEntryRef[]
  owner?: string
  enabled?: boolean
  version?: number
}) {
  useListLoadProcessing({ refs: ids, owner, enabled, loadVersion: version })
  return null
}

describe("列表加载自动化触发", () => {
  let root: Root
  let container: HTMLDivElement
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"))
    mocks.notify.mockReset().mockResolvedValue({ accepted: 1, trigger: null })
    mocks.local = true
    mocks.entries = { a: makeEntry("a"), b: makeEntry("b") }
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  const render = async (
    ids: LoadedEntryRef[],
    options: { owner?: string; enabled?: boolean; version?: number } = {},
  ) => {
    await act(async () => root.render(<Fixture ids={ids} {...options} />))
  }
  const load = async () => {
    await act(async () => vi.advanceTimersByTimeAsync(400))
  }

  it("成功加载后只排队一次，渲染与翻页重叠不重复提交旧条目", async () => {
    await render(refs(["a"]))
    await load()
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.notify.mock.calls[0]![0][0]).toMatchObject({
      id: "a",
      sourceKey: "feed/1",
      read: false,
    })
    expect(mocks.notify.mock.calls[0]![0][0]).not.toHaveProperty("content")
    await render(refs(["a"]))
    await load()
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    await render(refs(["a", "b"]))
    await load()
    expect(mocks.notify.mock.calls[1]![0].map((entry: { id: string }) => entry.id)).toEqual(["b"])
  })

  it("实际重新加载会提交最新读态，让后台检查新的规则版本", async () => {
    await render(refs(["a"]))
    await load()
    mocks.entries.a = makeEntry("a", true)
    await render(refs(["a"]), { version: 2 })
    await load()
    expect(mocks.notify).toHaveBeenCalledTimes(2)
    expect(mocks.notify.mock.calls[1]![0][0].read).toBe(true)
  })

  it("快速切换列表只提交最终加载结果", async () => {
    await render(refs(["a"]))
    await act(async () => vi.advanceTimersByTimeAsync(200))
    await render(refs(["b"]))
    await load()
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.notify.mock.calls[0]![0][0].id).toBe("b")
  })

  it("关闭、非本机站点、未登录时不触发", async () => {
    await render(refs(["a"]), { enabled: false })
    await load()
    mocks.local = false
    await render(refs(["a"]))
    await load()
    mocks.local = true
    await render(refs(["a"]), { owner: "" })
    await load()
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it("账号切换立即中止旧请求，新账号不复用旧账号冷却", async () => {
    let signal: AbortSignal | undefined
    mocks.notify.mockImplementationOnce((_entries, requestSignal: AbortSignal) => {
      signal = requestSignal
      return new Promise<void>(() => {})
    })
    await render(refs(["a"]))
    await load()
    mocks.listener?.({ whoami: { id: "other" } })
    expect(signal?.aborted).toBe(true)
    await render(refs(["a"]), { owner: "other" })
    await load()
    expect(mocks.notify).toHaveBeenCalledTimes(2)
  })

  it("大页分批，失败不自循环且下次加载可重试", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `entry-${index}`)
    mocks.entries = Object.fromEntries(ids.map((id) => [id, makeEntry(id)]))
    mocks.notify.mockRejectedValueOnce(new Error("network"))
    await render(refs(ids))
    await load()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    await render(refs(ids), { version: 2 })
    await load()
    expect(mocks.notify.mock.calls.slice(1).map((call) => call[0].length)).toEqual([100, 1])
  })

  it("只序列化有效原文身份，保持未知读态并拒绝生成源", () => {
    mocks.entries.a = makeEntry("a", null)
    mocks.entries.b = { ...makeEntry("b"), title: null, url: "/relative" }
    const packets = listedProcessingEntries(
      [...refs(["a", "a", "b", "missing"]), { entryId: "b", sourceKey: "generated:stories" }],
      mocks.entries,
    )
    expect(packets).toHaveLength(2)
    expect(packets[0]!.read).toBeNull()
    expect(packets[1]).toMatchObject({ id: "b", title: "", url: null })
  })
})
