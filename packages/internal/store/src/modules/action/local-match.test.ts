import { FeedViewType } from "@follow/constants"
import type { ActionFilterItem } from "@follow-app/client-sdk"
import { beforeEach, describe, expect, test } from "vitest"

import { useCollectionStore } from "../collection/store"
import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { useSubscriptionStore } from "../subscription/store"
import type { SubscriptionModel } from "../subscription/types"
import type { LocalActionEntryContext } from "./local-match"
import { doesLocalActionRuleMatch, getLocalActionSilenceEntryIds } from "./local-match"
import { useLocalActionStore } from "./local-store"
import type { ActionItem } from "./store"

const context: LocalActionEntryContext = {
  category: "Blockchain",
  entryAttachmentsDuration: 0,
  entryAuthor: "Folo",
  entryContent: "Prediction market note",
  entryMediaLength: 0,
  entryTitle: "Catcher Predict：“链捕手 2026 年度预测”",
  entryUrl: "https://example.com/entry",
  feedTitle: "链捕手",
  feedUrl: "https://example.com/rss.xml",
  siteUrl: "https://example.com",
  status: "unread",
  view: 0,
}

const createRule = ({
  condition,
  disabled,
  result = { block: true },
}: {
  condition: ActionFilterItem[][]
  disabled?: boolean
  result?: ActionItem["result"]
}): ActionItem => ({
  condition,
  index: 0,
  name: "Local rule",
  result: disabled ? { ...result, disabled: true } : result,
})

const emptyEntryIdByView = () => ({
  [FeedViewType.All]: new Set<string>(),
  [FeedViewType.Articles]: new Set<string>(),
  [FeedViewType.Audios]: new Set<string>(),
  [FeedViewType.Notifications]: new Set<string>(),
  [FeedViewType.Pictures]: new Set<string>(),
  [FeedViewType.SocialMedia]: new Set<string>(),
  [FeedViewType.Videos]: new Set<string>(),
})

const createEntry = ({ id, read, title }: { id: string; read?: boolean; title: string }) =>
  ({
    feedId: "feed-1",
    guid: `${id}-guid`,
    id,
    insertedAt: new Date("2026-01-01T00:00:00.000Z"),
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    read: read ?? false,
    title,
  }) as EntryModel

const chainCatcherSubscription = {
  category: "Blockchain",
  feedId: "feed-1",
  hideFromTimeline: false,
  isPrivate: false,
  title: "链捕手",
  type: "feed",
  view: FeedViewType.Articles,
} as SubscriptionModel

describe("doesLocalActionRuleMatch", () => {
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
    useCollectionStore.setState({ collections: {} })
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
    useLocalActionStore.setState({
      isDirty: false,
      isHydrated: true,
      ownerKey: "user-1",
      revision: 0,
      rules: [],
    })
  })

  test("matches an AND condition group", () => {
    const rule = createRule({
      condition: [
        [
          { field: "title", operator: "eq", value: "链捕手" },
          { field: "entry_title", operator: "contains", value: "Catcher Predict" },
        ],
      ],
    })

    expect(doesLocalActionRuleMatch(rule, context)).toBe(true)
  })

  test("does not trim configured values before matching", () => {
    const rule = createRule({
      condition: [
        [
          { field: "title", operator: "eq", value: "链捕手" },
          { field: "entry_title", operator: "contains", value: "Catcher Predict " },
        ],
      ],
    })

    expect(doesLocalActionRuleMatch(rule, context)).toBe(false)
  })

  test("matches when any OR group matches", () => {
    const rule = createRule({
      condition: [
        [{ field: "entry_author", operator: "eq", value: "Someone else" }],
        [{ field: "category", operator: "eq", value: "Blockchain" }],
      ],
    })

    expect(doesLocalActionRuleMatch(rule, context)).toBe(true)
  })

  test("ignores disabled rules", () => {
    const rule = createRule({
      condition: [[{ field: "title", operator: "eq", value: "链捕手" }]],
      disabled: true,
    })

    expect(doesLocalActionRuleMatch(rule, context)).toBe(false)
  })

  test("finds matching unread entries for local silence rules", () => {
    const matchingEntry = createEntry({
      id: "entry-match",
      title: "Catcher Predict：“旧金山巨人对芝加哥小熊” 胜率暴跌 16%",
    })
    const alreadyReadEntry = createEntry({
      id: "entry-read",
      read: true,
      title: "Catcher Predict：“纽约洋基对波士顿红袜”",
    })
    const nonMatchingEntry = createEntry({
      id: "entry-miss",
      title: "Moonshot AI 寻求新一轮最高 20 亿美元融资",
    })

    useEntryStore.setState((state) => ({
      ...state,
      data: {
        [alreadyReadEntry.id]: alreadyReadEntry,
        [matchingEntry.id]: matchingEntry,
        [nonMatchingEntry.id]: nonMatchingEntry,
      },
      entryIdSet: new Set([matchingEntry.id, alreadyReadEntry.id, nonMatchingEntry.id]),
    }))
    useSubscriptionStore.setState((state) => ({
      ...state,
      data: {
        "feed-1": chainCatcherSubscription,
      },
    }))
    useLocalActionStore.setState((state) => ({
      ...state,
      rules: [
        createRule({
          condition: [
            [
              { field: "title", operator: "eq", value: "链捕手" },
              { field: "entry_title", operator: "contains", value: "Catcher Predict" },
            ],
          ],
          result: { silence: true },
        }),
      ],
    }))

    expect(
      getLocalActionSilenceEntryIds([matchingEntry.id, alreadyReadEntry.id, nonMatchingEntry.id]),
    ).toEqual([matchingEntry.id])
  })
})
