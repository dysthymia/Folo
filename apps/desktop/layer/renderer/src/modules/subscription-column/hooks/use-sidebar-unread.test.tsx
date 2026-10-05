import { FeedViewType } from "@follow/constants"
import { useSubscriptionStore } from "@follow/store/subscription/store"
import type { SubscriptionModel } from "@follow/store/subscription/types"
import { useUnreadById } from "@follow/store/unread/hooks"
import { useUnreadStore } from "@follow/store/unread/store"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useSidebarUnreadByIds, useSidebarUnreadByView } from "./use-sidebar-unread"

const { settingMock } = vi.hoisted(() => ({ settingMock: vi.fn(() => false) }))
vi.mock("~/atoms/settings/general", () => ({ useGeneralSettingKey: settingMock }))

const subscription = (
  id: string,
  overrides: Partial<SubscriptionModel> = {},
): SubscriptionModel => ({
  feedId: id,
  listId: null,
  inboxId: null,
  userId: "user",
  view: FeedViewType.Articles,
  isPrivate: false,
  hideFromTimeline: null,
  title: id,
  category: "AI",
  createdAt: null,
  type: "feed",
  ...overrides,
})

describe("sidebar timeline unread counts", () => {
  const initialSubscriptions = useSubscriptionStore.getState()
  const initialUnread = useUnreadStore.getState()
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const ids = ["visible", "hidden"]

  function Counts() {
    const group = useSidebarUnreadByIds(ids)
    const view = useSidebarUnreadByView(FeedViewType.All)
    const hidden = useUnreadById("hidden")
    return <span>{`${group}/${view}/${hidden}`}</span>
  }

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    settingMock.mockReturnValue(false)
    useSubscriptionStore.setState({
      ...initialSubscriptions,
      data: {
        visible: subscription("visible"),
        hidden: subscription("hidden", { hideFromTimeline: true }),
      },
      feedIdByView: { ...initialSubscriptions.feedIdByView, [FeedViewType.All]: new Set(ids) },
    })
    useUnreadStore.setState({ data: { visible: 24, hidden: 74 } })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useSubscriptionStore.setState(initialSubscriptions, true)
    useUnreadStore.setState(initialUnread, true)
  })

  it("excludes the hidden 74 from the group and view but retains the source count", async () => {
    // 复现真实问题：98 条未读中只有 24 条属于时间线可见来源。
    await act(async () => root.render(<Counts />))
    expect(container.textContent).toBe("24/24/74")
  })

  it("updates immediately when a subscription is restored or its unread count changes", async () => {
    await act(async () => root.render(<Counts />))
    await act(async () => {
      useSubscriptionStore.setState({
        data: { visible: subscription("visible"), hidden: subscription("hidden") },
      })
    })
    expect(container.textContent).toBe("98/98/74")
    await act(async () => useUnreadStore.setState({ data: { visible: 20, hidden: 74 } }))
    expect(container.textContent).toBe("94/94/74")
  })

  it("follows the private-subscription timeline setting without changing source counts", async () => {
    useSubscriptionStore.setState({
      data: {
        visible: subscription("visible"),
        hidden: subscription("hidden", { isPrivate: true }),
      },
    })
    await act(async () => root.render(<Counts />))
    expect(container.textContent).toBe("98/98/74")
    settingMock.mockReturnValue(true)
    await act(async () => root.render(<Counts />))
    expect(container.textContent).toBe("24/24/74")
  })

  it("resolves inbox visibility settings from the subscription key", async () => {
    useSubscriptionStore.setState({
      data: {
        "inbox/mailbox": subscription("mailbox", {
          feedId: null,
          inboxId: "mailbox",
          type: "inbox",
          hideFromTimeline: true,
        }),
      },
    })
    useUnreadStore.setState({ data: { mailbox: 5, other: 2 } })
    function InboxCount() {
      return <span>{useSidebarUnreadByIds(["mailbox", "other"])}</span>
    }
    await act(async () => root.render(<InboxCount />))
    expect(container.textContent).toBe("2")
  })
})
