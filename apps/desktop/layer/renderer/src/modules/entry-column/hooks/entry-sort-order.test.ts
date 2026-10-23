import { FeedViewType } from "@follow/constants"
import { describe, expect, test } from "vitest"

import { getEffectiveRouteEntrySortOrder, isTimelineEntrySortScope } from "./entry-sort-order"

describe("desktop entry sort scope", () => {
  test.each(["feed-1", "folder-news", "feed-1,feed-2", "list-list-1"])(
    "allows oldest-first unread sorting for %s timeline sources",
    (feedId) => {
      expect(
        getEffectiveRouteEntrySortOrder({
          sortOrder: "asc",
          unreadOnly: true,
          feedId,
        }),
      ).toBe("asc")
    },
  )

  test.each([
    ["all-content", { feedId: "feed-1", unreadOnly: false }],
    ["inbox", { inboxId: "inbox-1", unreadOnly: true }],
    ["collection", { feedId: "collections", isCollection: true, unreadOnly: true }],
    ["preview", { feedId: "feed-1", isPreview: true, unreadOnly: true }],
  ] as const)("forces %s sources to newest-first", (_name, scope) => {
    expect(
      getEffectiveRouteEntrySortOrder({
        sortOrder: "asc",
        ...scope,
      }),
    ).toBe("desc")
  })

  test("shows the control only for non-preview timeline scopes", () => {
    expect(isTimelineEntrySortScope({ feedId: "list-list-1" })).toBe(true)
    expect(isTimelineEntrySortScope({ inboxId: "inbox-1" })).toBe(false)
    expect(isTimelineEntrySortScope({ isCollection: true })).toBe(false)
    expect(isTimelineEntrySortScope({ feedId: "feed-1", isPreview: true })).toBe(false)
  })
})

// 聚合邮件和双流固定倒序，指定订阅与非邮件视图仍保留正序能力。
describe("desktop aggregate pagination direction", () => {
  test.each([undefined, "all"])("normalizes aggregate feed %s", (feedId) => {
    for (const view of [FeedViewType.All, FeedViewType.Articles]) {
      const scope = { feedId, view, hasInboxSubscriptions: true }
      expect(isTimelineEntrySortScope(scope)).toBe(false)
      expect(
        getEffectiveRouteEntrySortOrder({ ...scope, sortOrder: "asc", unreadOnly: true }),
      ).toBe("desc")
    }
  })

  test.each([
    { feedId: "feed-1" },
    { feedId: "folder-news" },
    { listId: "list-1" },
    { view: FeedViewType.Pictures },
    { hasInboxSubscriptions: false },
  ])("preserves ascending support for scoped sources %o", (scope) => {
    expect(
      getEffectiveRouteEntrySortOrder({
        hasInboxSubscriptions: true,
        ...scope,
        sortOrder: "asc",
        unreadOnly: true,
      }),
    ).toBe("asc")
  })

  test("native timeline fixes both sorting and its control to descending", () => {
    const scope = { feedId: "feed-1", nativeTimeline: true }
    expect(isTimelineEntrySortScope(scope)).toBe(false)
    expect(getEffectiveRouteEntrySortOrder({ ...scope, sortOrder: "asc", unreadOnly: true })).toBe(
      "desc",
    )
  })
})
