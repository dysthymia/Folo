import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, it } from "vitest"

import { useFeedStore } from "../feed/store"
import type { FeedModel } from "../feed/types"
import { useSubscriptionStore } from "../subscription/store"
import type { SubscriptionModel } from "../subscription/types"
import {
  entryProcessingRoleActions,
  getEntryProcessingRoleRelatedEntries,
  isEntryHiddenByProcessingRole,
  resolveEntryProcessingRole,
  useEntryProcessingRoleStore,
} from "./processing-role"
import { useSemanticDedupeStore } from "./semantic-dedupe"
import { useEntryStore } from "./store"
import type { EntryModel } from "./types"

const emptyEntryIdByView = () => ({
  [FeedViewType.All]: new Set<string>(),
  [FeedViewType.Articles]: new Set<string>(),
  [FeedViewType.Audios]: new Set<string>(),
  [FeedViewType.Notifications]: new Set<string>(),
  [FeedViewType.Pictures]: new Set<string>(),
  [FeedViewType.SocialMedia]: new Set<string>(),
  [FeedViewType.Videos]: new Set<string>(),
})

const createEntry = ({
  id,
  publishedAt = "2026-06-19T11:00:00.000Z",
  title,
}: {
  id: string
  publishedAt?: string
  title: string
}) =>
  ({
    description: `${title} description`,
    feedId: "feed-1",
    guid: `${id}-guid`,
    id,
    insertedAt: new Date(publishedAt),
    publishedAt: new Date(publishedAt),
    read: false,
    title,
    url: `https://example.com/${id}`,
  }) as EntryModel

const createSubscription = (category: string | null): SubscriptionModel => ({
  category,
  createdAt: null,
  feedId: "feed-1",
  hideFromTimeline: false,
  inboxId: null,
  isPrivate: false,
  listId: null,
  title: null,
  type: "feed",
  userId: "user-1",
  view: FeedViewType.Articles,
})

const seedEntries = (entries: EntryModel[]) => {
  useEntryStore.setState((state) => ({
    ...state,
    data: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    entryIdSet: new Set(entries.map((entry) => entry.id)),
  }))
}

const seedLocalDuplicateDecision = ({
  hideEntryId,
  keepEntryId,
}: {
  hideEntryId: string
  keepEntryId: string
}) => {
  const pairKey = [hideEntryId, keepEntryId].sort().join("::")

  useSemanticDedupeStore.setState({
    decisions: {
      [pairKey]: {
        confidence: 0.96,
        duplicate: true,
        entryIds: [keepEntryId, hideEntryId],
        hideEntryId,
        keepEntryId,
        pairKey,
        reason: null,
        updatedAt: "2026-06-19T12:00:00.000Z",
      },
    },
    revision: 1,
  })
}

describe("entry processing role", () => {
  beforeEach(() => {
    useEntryStore.setState({
      data: {},
      entryIdByCategory: {},
      entryIdByFeed: {},
      entryIdByInbox: {},
      entryIdByList: {},
      entryIdByView: emptyEntryIdByView(),
      entryIdSet: new Set(),
    })
    useFeedStore.setState({
      feeds: {
        "feed-1": {
          id: "feed-1",
          siteUrl: "https://example.com",
          title: "BlockBeats",
          type: "feed",
          url: "https://example.com/rss.xml",
        } as FeedModel,
      },
    })
    useSubscriptionStore.setState({
      categories: emptyEntryIdByView(),
      categoryOpenStateByView: {
        [FeedViewType.All]: {},
        [FeedViewType.Articles]: {},
        [FeedViewType.Audios]: {},
        [FeedViewType.Notifications]: {},
        [FeedViewType.Pictures]: {},
        [FeedViewType.SocialMedia]: {},
        [FeedViewType.Videos]: {},
      },
      data: {
        "feed-1": createSubscription("AI"),
      },
      feedIdByView: emptyEntryIdByView(),
      listIdByView: emptyEntryIdByView(),
      subscriptionIdSet: new Set(["feed-1"]),
    })
    useSemanticDedupeStore.setState({
      decisions: {},
      isHydrated: true,
      ownerKey: "user-1",
      pendingPairKeys: {},
      revision: 0,
      settledEntryIds: {},
    })
    useEntryProcessingRoleStore.setState({ revision: 0, serviceRoles: {} })
  })

  it("leaves entries untouched when no engine decided anything", () => {
    seedEntries([createEntry({ id: "entry-a", title: "Alpha" })])

    expect(resolveEntryProcessingRole("entry-a")).toBeNull()
    expect(isEntryHiddenByProcessingRole("entry-a")).toBe(false)
    expect(getEntryProcessingRoleRelatedEntries("entry-a")).toEqual([])
  })

  it("maps local dedupe roles onto merged and keeper", () => {
    seedEntries([
      createEntry({ id: "entry-a", title: "Alpha outage alert" }),
      createEntry({ id: "entry-b", title: "Alpha outage update" }),
    ])
    seedLocalDuplicateDecision({ hideEntryId: "entry-b", keepEntryId: "entry-a" })

    expect(resolveEntryProcessingRole("entry-b")).toEqual({
      kind: "merged",
      reason: null,
      relatedEntryIds: ["entry-a"],
      source: "local-dedupe",
    })
    expect(isEntryHiddenByProcessingRole("entry-b")).toBe(true)
    expect(resolveEntryProcessingRole("entry-a")).toEqual({
      kind: "keeper",
      reason: null,
      relatedEntryIds: ["entry-b"],
      source: "local-dedupe",
    })
    expect(isEntryHiddenByProcessingRole("entry-a")).toBe(false)
    expect(getEntryProcessingRoleRelatedEntries("entry-a")).toEqual([
      {
        feedTitle: "BlockBeats",
        id: "entry-b",
        publishedAt: new Date("2026-06-19T11:00:00.000Z"),
        title: "Alpha outage update",
        url: "https://example.com/entry-b",
      },
    ])
  })

  it("ignores local dedupe decisions when the local engine is disabled", () => {
    seedEntries([createEntry({ id: "entry-a", title: "Alpha" })])
    seedLocalDuplicateDecision({ hideEntryId: "entry-a", keepEntryId: "entry-b" })

    expect(isEntryHiddenByProcessingRole("entry-a", { localDedupe: false })).toBe(false)
    expect(isEntryHiddenByProcessingRole("entry-a")).toBe(true)
  })

  it("lets service decisions win over the local dedupe", () => {
    seedEntries([
      createEntry({ id: "entry-a", title: "Alpha outage alert" }),
      createEntry({ id: "entry-b", title: "Alpha outage update" }),
    ])
    seedLocalDuplicateDecision({ hideEntryId: "entry-b", keepEntryId: "entry-a" })

    entryProcessingRoleActions.replaceServiceRoles([
      { entryId: "entry-b", kind: "keeper", reason: "规则保留" },
    ])

    expect(resolveEntryProcessingRole("entry-b")).toEqual({
      kind: "keeper",
      reason: "规则保留",
      relatedEntryIds: [],
      source: "service",
    })
    expect(isEntryHiddenByProcessingRole("entry-b")).toBe(false)
  })

  it("carries story identity and merges service related entries", () => {
    seedEntries([
      createEntry({ id: "entry-a", title: "Alpha outage alert" }),
      createEntry({ id: "entry-b", title: "Alpha outage update" }),
    ])

    entryProcessingRoleActions.replaceServiceRoles([
      { entryId: "entry-a", kind: "merged", storyId: "story-1" },
      {
        entryId: "entry-b",
        kind: "story",
        relatedEntryIds: ["entry-a"],
        storyId: "story-1",
        storyTitle: "Alpha 停服综述",
      },
    ])

    expect(resolveEntryProcessingRole("entry-a")).toEqual({
      kind: "merged",
      reason: null,
      relatedEntryIds: [],
      source: "service",
      storyId: "story-1",
    })
    expect(isEntryHiddenByProcessingRole("entry-a")).toBe(true)
    expect(resolveEntryProcessingRole("entry-b")?.storyId).toBe("story-1")
    expect(resolveEntryProcessingRole("entry-b")?.storyTitle).toBe("Alpha 停服综述")
    expect(getEntryProcessingRoleRelatedEntries("entry-b").map((entry) => entry.id)).toEqual([
      "entry-a",
    ])
  })

  it("drops service roles again when they are cleared", () => {
    seedEntries([createEntry({ id: "entry-a", title: "Alpha" })])

    entryProcessingRoleActions.replaceServiceRoles([{ entryId: "entry-a", kind: "hidden" }])
    expect(isEntryHiddenByProcessingRole("entry-a")).toBe(true)

    const revisionBeforeClear = useEntryProcessingRoleStore.getState().revision
    entryProcessingRoleActions.clearServiceRoles()

    expect(isEntryHiddenByProcessingRole("entry-a")).toBe(false)
    expect(useEntryProcessingRoleStore.getState().revision).toBeGreaterThan(revisionBeforeClear)
  })
})
