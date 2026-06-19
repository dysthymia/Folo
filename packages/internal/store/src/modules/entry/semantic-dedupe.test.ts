import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, it } from "vitest"

import { useFeedStore } from "../feed/store"
import type { FeedModel } from "../feed/types"
import { useSubscriptionStore } from "../subscription/store"
import {
  getSemanticDuplicateCandidates,
  getSemanticDuplicateEntryRole,
  registerSemanticDuplicateEvaluator,
  useSemanticDedupeStore,
} from "./semantic-dedupe"
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
  description,
  id,
  publishedAt = "2026-06-19T11:00:00.000Z",
  title,
}: {
  description: string
  id: string
  publishedAt?: string
  title: string
}) =>
  ({
    description,
    feedId: "feed-1",
    guid: `${id}-guid`,
    id,
    insertedAt: new Date(publishedAt),
    publishedAt: new Date(publishedAt),
    read: false,
    title,
    url: `https://example.com/${id}`,
  }) as EntryModel

describe("semantic duplicate entry marking", () => {
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
      data: {},
      feedIdByView: emptyEntryIdByView(),
      listIdByView: emptyEntryIdByView(),
      subscriptionIdSet: new Set(),
    })
    useSemanticDedupeStore.setState({
      decisions: {},
      isHydrated: true,
      ownerKey: "user-1",
      pendingPairKeys: {},
      revision: 0,
    })
  })

  it("creates candidates with title, feed, and description context", () => {
    const firstEntry = createEntry({
      description: "Iran says vessels crossing the Strait of Hormuz must submit applications.",
      id: "entry-a",
      title: "伊朗宣布霍尔木兹海峡通行新规：须提前48小时提交申请",
    })
    const secondEntry = createEntry({
      description:
        "Ships passing through the Strait of Hormuz must apply at least 48 hours in advance.",
      id: "entry-b",
      title: "伊朗要求船舶通过霍尔木兹海峡须至少提前 48 小时申请",
    })
    const unrelatedEntry = createEntry({
      description: "A different company announced a new model release.",
      id: "entry-c",
      title: "Moonshot AI 发布新模型",
    })

    useEntryStore.setState((state) => ({
      ...state,
      data: {
        [firstEntry.id]: firstEntry,
        [secondEntry.id]: secondEntry,
        [unrelatedEntry.id]: unrelatedEntry,
      },
      entryIdSet: new Set([firstEntry.id, secondEntry.id, unrelatedEntry.id]),
    }))

    const candidates = getSemanticDuplicateCandidates([
      firstEntry.id,
      secondEntry.id,
      unrelatedEntry.id,
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      keepEntryId: firstEntry.id,
      testEntryId: secondEntry.id,
    })
    expect(candidates[0]?.entries[0]).toMatchObject({
      description: firstEntry.description,
      feedTitle: "BlockBeats",
      title: firstEntry.title,
      urlHost: "example.com",
    })
  })

  it("bumps revision when the evaluator changes", () => {
    expect(useSemanticDedupeStore.getState().revision).toBe(0)

    const dispose = registerSemanticDuplicateEvaluator(async () => [])

    expect(useSemanticDedupeStore.getState().revision).toBe(1)

    dispose()

    expect(useSemanticDedupeStore.getState().revision).toBe(2)
  })

  it("marks confident duplicate and kept entries without filtering them", () => {
    useSemanticDedupeStore.setState({
      decisions: {
        "entry-a::entry-b": {
          confidence: 0.92,
          duplicate: true,
          entryIds: ["entry-a", "entry-b"],
          hideEntryId: "entry-b",
          keepEntryId: "entry-a",
          pairKey: "entry-a::entry-b",
          reason: null,
          updatedAt: "2026-06-19T12:00:00.000Z",
        },
        "entry-c::entry-d": {
          confidence: 0.84,
          duplicate: true,
          entryIds: ["entry-c", "entry-d"],
          hideEntryId: "entry-d",
          keepEntryId: "entry-c",
          pairKey: "entry-c::entry-d",
          reason: null,
          updatedAt: "2026-06-19T12:00:00.000Z",
        },
      },
      revision: 1,
    })

    expect(getSemanticDuplicateEntryRole("entry-a")).toBe("keeper")
    expect(getSemanticDuplicateEntryRole("entry-b")).toBe("duplicate")
    expect(getSemanticDuplicateEntryRole("entry-c")).toBeNull()
    expect(getSemanticDuplicateEntryRole("entry-d")).toBeNull()
  })
})
