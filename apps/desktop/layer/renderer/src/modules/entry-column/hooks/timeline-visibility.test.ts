import { FeedViewType } from "@follow/constants"
import type { EntryModel } from "@follow/store/entry/types"
import { isEntryHiddenBySubscriptions } from "@follow/store/entry/visibility"
import type { SubscriptionModel } from "@follow/store/subscription/types"
import { describe, expect, it } from "vitest"

const createSubscription = (
  id: string,
  options: Pick<SubscriptionModel, "hideFromTimeline" | "isPrivate">,
): SubscriptionModel => ({
  feedId: id,
  listId: null,
  inboxId: null,
  userId: "user",
  view: FeedViewType.Articles,
  type: "feed",
  category: null,
  createdAt: null,
  title: null,
  ...options,
})

const createEntry = (
  options: Pick<EntryModel, "feedId" | "inboxHandle" | "sources">,
): Pick<EntryModel, "feedId" | "inboxHandle" | "sources"> => options

describe("isEntryHiddenBySubscriptions", () => {
  it("hides entries when every subscription source is hidden from timeline", () => {
    const subscriptions = new Map([
      ["feed-a", createSubscription("feed-a", { hideFromTimeline: true, isPrivate: false })],
    ])

    expect(
      isEntryHiddenBySubscriptions({
        entry: createEntry({ feedId: "feed-a", inboxHandle: null, sources: null }),
        getSubscription: (id) => subscriptions.get(id),
      }),
    ).toBe(true)
  })

  it("keeps entries that still have a visible subscription source", () => {
    const subscriptions = new Map([
      ["feed-a", createSubscription("feed-a", { hideFromTimeline: true, isPrivate: false })],
      ["list-a", createSubscription("list-a", { hideFromTimeline: false, isPrivate: false })],
    ])

    expect(
      isEntryHiddenBySubscriptions({
        entry: createEntry({ feedId: "feed-a", inboxHandle: null, sources: ["list-a"] }),
        getSubscription: (id) => subscriptions.get(id),
      }),
    ).toBe(false)
  })

  it("only applies private-subscription filtering when requested", () => {
    const subscriptions = new Map([
      ["feed-a", createSubscription("feed-a", { hideFromTimeline: false, isPrivate: true })],
    ])
    const entry = createEntry({ feedId: "feed-a", inboxHandle: null, sources: null })

    expect(
      isEntryHiddenBySubscriptions({
        entry,
        excludePrivate: false,
        getSubscription: (id) => subscriptions.get(id),
      }),
    ).toBe(false)
    expect(
      isEntryHiddenBySubscriptions({
        entry,
        excludePrivate: true,
        getSubscription: (id) => subscriptions.get(id),
      }),
    ).toBe(true)
  })
})
