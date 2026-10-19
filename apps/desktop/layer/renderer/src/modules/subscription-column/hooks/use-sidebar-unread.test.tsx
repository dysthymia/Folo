import { FeedViewType } from "@follow/constants"
import { useLocalActionStore } from "@follow/store/action/local-store"
import {
  entryProcessingRoleActions,
  useEntryProcessingRoleStore,
} from "@follow/store/entry/processing-role"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { useSubscriptionStore } from "@follow/store/subscription/store"
import type { SubscriptionModel } from "@follow/store/subscription/types"
import { useUnreadById } from "@follow/store/unread/hooks"
import { useUnreadStore } from "@follow/store/unread/store"
import { getDefaultStore } from "jotai"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { timelineContentModeAtom } from "~/modules/entry-column/atoms/processing-timeline"

import { useSidebarUnreadByIds, useSidebarUnreadByView } from "./use-sidebar-unread"

const { settingMock } = vi.hoisted(() => ({ settingMock: vi.fn(() => false) }))
vi.mock("~/atoms/settings/general", () => ({ useGeneralSettingKey: settingMock }))
vi.mock("~/atoms/settings/ai", () => ({ useAISettingKey: () => false }))

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
  const initialEntries = useEntryStore.getState()
  const initialActions = useLocalActionStore.getState()
  const initialRoles = useEntryProcessingRoleStore.getState()
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
    getDefaultStore().set(timelineContentModeAtom, "processed")
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
    useEntryStore.setState(initialEntries, true)
    useLocalActionStore.setState(initialActions, true)
    useEntryProcessingRoleStore.setState(initialRoles, true)
    getDefaultStore().set(timelineContentModeAtom, "processed")
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

  it("数量随规则、AI 角色、原始内容模式和已读状态变化，服务端未读不被改写", async () => {
    const entries = ["keep", "block", "hidden", "merged"].map(
      (id) =>
        ({ id, title: id, feedId: "visible", read: false, publishedAt: new Date() }) as EntryModel,
    )
    useEntryStore.setState({
      data: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
      entryIdByFeed: { visible: new Set(entries.map((entry) => entry.id)) },
    })
    useUnreadStore.setState({ data: { visible: 4, hidden: 74 } })
    useLocalActionStore.setState({
      rules: [
        {
          index: 0,
          name: "屏蔽",
          condition: [[{ field: "entry_title", operator: "eq", value: "block" }]],
          result: { block: true },
        },
      ],
      revision: initialActions.revision + 1,
    })
    entryProcessingRoleActions.replaceServiceRoles([
      { entryId: "hidden", kind: "hidden" },
      { entryId: "merged", kind: "merged" },
    ])
    await act(async () => root.render(<Counts />))
    expect(container.textContent).toBe("1/1/74")

    await act(async () => getDefaultStore().set(timelineContentModeAtom, "original"))
    expect(container.textContent).toBe("3/3/74")
    await act(async () => getDefaultStore().set(timelineContentModeAtom, "processed"))
    await act(async () =>
      entryProcessingRoleActions.replaceServiceRoles([
        { entryId: "hidden", kind: "restored" },
        { entryId: "merged", kind: "merged" },
      ]),
    )
    expect(container.textContent).toBe("2/2/74")
    await act(async () =>
      useLocalActionStore.setState({ rules: [], revision: initialActions.revision + 2 }),
    )
    expect(container.textContent).toBe("3/3/74")
    await act(async () => {
      useEntryStore.setState({
        data: { ...useEntryStore.getState().data, keep: { ...entries[0]!, read: true } },
      })
      useUnreadStore.setState({ data: { visible: 3, hidden: 74 } })
    })
    expect(container.textContent).toBe("2/2/74")
    expect(useUnreadStore.getState().data).toEqual({ visible: 3, hidden: 74 })
  })
})
