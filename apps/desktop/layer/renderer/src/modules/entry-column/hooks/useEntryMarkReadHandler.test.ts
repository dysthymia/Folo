import { unreadSyncService } from "@follow/store/unread/store"
import type { Range } from "@tanstack/react-virtual"
import { act, createElement } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { batchMarkRead, useEntryMarkReadHandler } from "./useEntryMarkReadHandler"

const settings = vi.hoisted(() => ({ scrollMarkUnread: true, renderMarkUnread: false }))
vi.mock("~/atoms/settings/general", () => ({
  useGeneralSettingKey: (key: keyof typeof settings) => settings[key],
}))
vi.mock("~/hooks/biz/useRouteParams", () => ({
  useRouteParamsSelector: () => 0,
}))

vi.mock("@follow/store/unread/store", () => ({
  unreadSyncService: {
    queueEntriesAsRead: vi.fn(),
  },
}))

describe("batchMarkRead", () => {
  it("queues ids without requiring entries to exist in the local store", () => {
    batchMarkRead(["entry-1", "entry-2"])

    expect(unreadSyncService.queueEntriesAsRead).toHaveBeenCalledWith(["entry-1", "entry-2"])
  })
})

describe("混合列表的滚动标记已读", () => {
  let root: Root
  let container: HTMLDivElement
  let handlers: ReturnType<typeof useEntryMarkReadHandler>
  const markRangeAsRead = vi.fn()
  const range: Range = { startIndex: 0, endIndex: 2, overscan: 5, count: 4 }

  beforeAll(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    settings.scrollMarkUnread = true
    container = document.createElement("div")
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async (pauseScrollMarkRead = false, projected = true) => {
    const Probe = () => {
      handlers = useEntryMarkReadHandler(projected ? [] : ["one", "two", "three"], {
        pauseScrollMarkRead,
        markRangeAsRead: projected ? markRangeAsRead : undefined,
      })
      return null
    }
    await act(async () => root.render(createElement(Probe)))
  }

  it("将离开视口的行范围交给阅读投影，不把 Story 当作官方条目", async () => {
    await render()
    handlers.handleScrollMarkRead?.(range, true)
    expect(markRangeAsRead).toHaveBeenCalledWith(range)
    expect(unreadSyncService.queueEntriesAsRead).not.toHaveBeenCalled()
  })

  it("没有滚动交互或处于刷新保护期时不提交读态", async () => {
    await render()
    handlers.handleScrollMarkRead?.(range, false)
    expect(markRangeAsRead).not.toHaveBeenCalled()
    await render(true)
    handlers.handleScrollMarkRead?.(range, true)
    expect(markRangeAsRead).not.toHaveBeenCalled()
  })

  it("关闭设置时不提供滚动标记处理器", async () => {
    settings.scrollMarkUnread = false
    await render()
    expect(handlers.handleScrollMarkRead).toBeUndefined()
    expect(markRangeAsRead).not.toHaveBeenCalled()
  })

  it("原始列表继续仅批量标记已离开视口的条目", async () => {
    await render(false, false)
    handlers.handleScrollMarkRead?.(range, true)
    expect(unreadSyncService.queueEntriesAsRead).toHaveBeenCalledWith(["one", "two"])
    expect(markRangeAsRead).not.toHaveBeenCalled()
  })
})
