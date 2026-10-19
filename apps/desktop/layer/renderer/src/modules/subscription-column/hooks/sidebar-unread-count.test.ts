import type { EntryModel } from "@follow/store/entry/types"
import { describe, expect, it } from "vitest"

import { getFilteredSidebarUnreadCount } from "./sidebar-unread-count"

const entry = (id: string, overrides: Partial<EntryModel> = {}): EntryModel =>
  ({
    id,
    title: id,
    feedId: "feed",
    read: false,
    publishedAt: new Date("2026-10-12T00:00:00Z"),
    ...overrides,
  }) as EntryModel

describe("过滤后的侧栏未读数", () => {
  it("合并所有过滤原因，只扣一次，已读和其他来源不影响计数", () => {
    const result = getFilteredSidebarUnreadCount({
      sourceIds: ["feed", "feed"],
      unread: { feed: 6, other: 20 },
      entries: [
        entry("visible"),
        entry("blocked"),
        entry("hidden"),
        entry("both"),
        entry("read", { read: true }),
        entry("outside", { feedId: "other" }),
      ],
      isBlocked: (id) => ["blocked", "both", "read", "outside"].includes(id),
      isHidden: (id) => ["hidden", "both", "read", "outside"].includes(id),
    })
    expect(result).toBe(3)
  })

  it("保留未加载的未读，不把首屏数量当作全部数量", () => {
    expect(
      getFilteredSidebarUnreadCount({
        sourceIds: ["feed", "unloaded"],
        unread: { feed: 100, unloaded: 7 },
        entries: [entry("visible"), entry("hidden")],
        isBlocked: () => false,
        isHidden: (id) => id === "hidden",
      }),
    ).toBe(106)
  })

  it("按范围和时间顺序去重，独立来源不受其他来源同标题的影响", () => {
    const entries = [
      entry("old", { title: "Same!", publishedAt: new Date("2026-10-11") }),
      entry("new", { title: "same", feedId: "other" }),
      entry("untitled-1", { title: null }),
      entry("untitled-2", { title: null }),
    ]
    const options = {
      entries,
      unread: { feed: 3, other: 1 },
      isBlocked: (id: string) => id === "new",
      isHidden: () => false,
    }
    expect(getFilteredSidebarUnreadCount({ ...options, sourceIds: ["feed"] })).toBe(3)
    // 列表先去重再屏蔽，新条目被屏蔽也不能让旧副本重新占位。
    expect(getFilteredSidebarUnreadCount({ ...options, sourceIds: ["feed", "other"] })).toBe(2)
  })

  it("邮件以 inbox handle 归属，过期缓存不能产生负数或扣掉其他来源", () => {
    expect(
      getFilteredSidebarUnreadCount({
        sourceIds: ["mailbox", "feed"],
        unread: { mailbox: 1, feed: 4 },
        entries: [
          entry("mail-1", { inboxHandle: "mailbox" }),
          entry("mail-2", { inboxHandle: "mailbox" }),
        ],
        isBlocked: () => true,
        isHidden: () => false,
      }),
    ).toBe(4)
  })
})
