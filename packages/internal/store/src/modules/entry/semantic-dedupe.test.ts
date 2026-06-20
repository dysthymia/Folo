import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, it } from "vitest"

import { useFeedStore } from "../feed/store"
import type { FeedModel } from "../feed/types"
import { useSubscriptionStore } from "../subscription/store"
import type { SemanticDuplicateCandidate } from "./semantic-dedupe"
import {
  getSemanticDuplicateCandidates,
  getSemanticDuplicateEntryRole,
  registerSemanticDuplicateEvaluator,
  semanticDedupeActions,
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
      settledEntryIds: {},
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
      keepEntryId: secondEntry.id,
      testEntryId: firstEntry.id,
    })
    expect(candidates[0]?.entries[0]).toMatchObject({
      description: firstEntry.description,
      feedTitle: "BlockBeats",
      title: firstEntry.title,
      urlHost: "example.com",
    })
  })

  it("prioritizes newer entry candidates before older higher-similarity pairs", () => {
    const newestEntry = createEntry({
      description: "Alpha protocol reports a service outage during peak traffic.",
      id: "entry-newest-a",
      publishedAt: "2026-06-19T12:03:00.000Z",
      title: "Alpha protocol outage update",
    })
    const newestCandidate = createEntry({
      description: "Alpha protocol warns users about an outage during peak traffic.",
      id: "entry-newest-b",
      publishedAt: "2026-06-19T12:02:00.000Z",
      title: "Alpha protocol outage alert",
    })
    const olderEntry = createEntry({
      description: "Ethereum staking reward plan is released by the foundation.",
      id: "entry-older-a",
      publishedAt: "2026-06-19T11:03:00.000Z",
      title: "Ethereum staking reward plan",
    })
    const olderCandidate = createEntry({
      description: "Ethereum staking reward plans are released by the foundation.",
      id: "entry-older-b",
      publishedAt: "2026-06-19T11:02:00.000Z",
      title: "Ethereum staking reward plans",
    })

    useEntryStore.setState((state) => ({
      ...state,
      data: {
        [newestEntry.id]: newestEntry,
        [newestCandidate.id]: newestCandidate,
        [olderEntry.id]: olderEntry,
        [olderCandidate.id]: olderCandidate,
      },
      entryIdSet: new Set([newestEntry.id, newestCandidate.id, olderEntry.id, olderCandidate.id]),
    }))

    const candidates = getSemanticDuplicateCandidates(
      [newestEntry.id, newestCandidate.id, olderEntry.id, olderCandidate.id],
      { maxCandidates: 1 },
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      keepEntryId: newestCandidate.id,
      testEntryId: newestEntry.id,
    })
  })

  it("skips settled old pairs while still comparing new entries with settled entries", () => {
    const newEntry = createEntry({
      description: "Chainlink non-circulating supply wallet transferred LINK to Binance.",
      id: "entry-new",
      publishedAt: "2026-06-19T12:03:00.000Z",
      title: "Chainlink wallet transfers LINK to Binance",
    })
    const settledEntry = createEntry({
      description: "Chainlink non-circulating supply wallet deposited LINK into Binance.",
      id: "entry-settled-a",
      publishedAt: "2026-06-19T11:03:00.000Z",
      title: "Chainlink wallet deposits LINK to Binance",
    })
    const settledDuplicate = createEntry({
      description: "Chainlink non-circulating supply wallets deposited LINK into Binance.",
      id: "entry-settled-b",
      publishedAt: "2026-06-19T11:02:00.000Z",
      title: "Chainlink wallet deposits LINK to Binance",
    })

    useEntryStore.setState((state) => ({
      ...state,
      data: {
        [newEntry.id]: newEntry,
        [settledEntry.id]: settledEntry,
        [settledDuplicate.id]: settledDuplicate,
      },
      entryIdSet: new Set([newEntry.id, settledEntry.id, settledDuplicate.id]),
    }))
    useSemanticDedupeStore.setState({
      settledEntryIds: {
        [settledEntry.id]: true,
        [settledDuplicate.id]: true,
      },
    })

    expect(getSemanticDuplicateCandidates([settledEntry.id, settledDuplicate.id])).toHaveLength(0)

    const candidates = getSemanticDuplicateCandidates([
      newEntry.id,
      settledEntry.id,
      settledDuplicate.id,
    ])

    expect(
      candidates.some(
        (candidate) =>
          candidate.testEntryId === newEntry.id &&
          [settledEntry.id, settledDuplicate.id].includes(candidate.keepEntryId),
      ),
    ).toBe(true)
  })

  it("bumps revision when the evaluator changes", () => {
    expect(useSemanticDedupeStore.getState().revision).toBe(0)
    expect(useSemanticDedupeStore.getState().debug.evaluatorSource).toBe("none")

    const dispose = registerSemanticDuplicateEvaluator(async () => [], "dev-server")

    expect(useSemanticDedupeStore.getState().revision).toBe(1)
    expect(useSemanticDedupeStore.getState().debug.evaluatorSource).toBe("dev-server")

    dispose()

    expect(useSemanticDedupeStore.getState().revision).toBe(2)
    expect(useSemanticDedupeStore.getState().debug.evaluatorSource).toBe("none")
  })

  it("tracks processing debug state", () => {
    const candidate: SemanticDuplicateCandidate = {
      entries: [
        {
          description: "First description",
          feedTitle: "Feed A",
          id: "entry-a",
          publishedAt: "2026-06-19T12:00:00.000Z",
          title: "First title",
          urlHost: "example.com",
        },
        {
          description: "Second description",
          feedTitle: "Feed B",
          id: "entry-b",
          publishedAt: "2026-06-19T12:01:00.000Z",
          title: "Second title",
          urlHost: "example.org",
        },
      ],
      keepEntryId: "entry-a",
      pairKey: "entry-a::entry-b",
      similarity: 0.9,
      testEntryId: "entry-b",
    }

    semanticDedupeActions.recordScan(10, [candidate])
    semanticDedupeActions.recordProcessingStarted([candidate])

    expect(useSemanticDedupeStore.getState().debug).toMatchObject({
      isProcessing: true,
      lastCandidateCount: 1,
      lastScannedEntryCount: 10,
      recentCandidates: [
        {
          pairKey: "entry-a::entry-b",
          similarity: 0.9,
          titles: ["First title", "Second title"],
        },
      ],
    })

    semanticDedupeActions.recordProcessingFinished([
      {
        confidence: 0.91,
        duplicate: true,
        hideEntryId: "entry-b",
        keepEntryId: "entry-a",
        pairKey: "entry-a::entry-b",
        reason: "Same event",
      },
    ])

    expect(useSemanticDedupeStore.getState().debug).toMatchObject({
      isProcessing: false,
      lastDuplicateCount: 1,
      lastEvaluationCount: 1,
      lastError: null,
      recentEvaluations: [
        {
          confidence: 0.91,
          duplicate: true,
          pairKey: "entry-a::entry-b",
          reason: "Same event",
        },
      ],
      totalRuns: 1,
    })
  })

  it("tracks queued debug state", () => {
    semanticDedupeActions.recordProcessingQueued(20)

    expect(useSemanticDedupeStore.getState().debug).toMatchObject({
      queuedEntryCount: 20,
    })
    expect(useSemanticDedupeStore.getState().debug.lastQueuedAt).toEqual(expect.any(String))

    semanticDedupeActions.hydrate("user-1")

    expect(useSemanticDedupeStore.getState().debug.queuedEntryCount).toBe(0)
  })

  it("tracks evaluator run debug state", () => {
    semanticDedupeActions.recordEvaluatorRun({
      candidateCount: 16,
      command: "/opt/homebrew/bin/codex",
      durationMs: 1234,
      fallbackUsed: false,
      inputCandidateCount: 20,
      reasoningEffort: "low",
      requestedModel: "GPT-5.3-Codex-Spark",
      usedModel: "GPT-5.3-Codex-Spark",
    })

    expect(useSemanticDedupeStore.getState().debug.lastEvaluatorRun).toMatchObject({
      candidateCount: 16,
      durationMs: 1234,
      fallbackUsed: false,
      inputCandidateCount: 20,
      requestedModel: "GPT-5.3-Codex-Spark",
      usedModel: "GPT-5.3-Codex-Spark",
    })

    semanticDedupeActions.hydrate("user-1")

    expect(useSemanticDedupeStore.getState().debug.lastEvaluatorRun).toBeNull()
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
