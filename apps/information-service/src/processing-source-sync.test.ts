import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { FoloReader, Page, Source, SourceEntry } from "./folo"
import { FoloReadError } from "./folo"
import { acquireSources, SourceSyncStore } from "./processing-source-sync"
import { Store } from "./store"

const databases: DatabaseSync[] = []
const feed: Source = {
  key: "feed/f1",
  kind: "feed",
  id: "f1",
  title: "Feed",
  view: 0,
  category: "研究",
}
const list: Source = {
  key: "list/l1",
  kind: "list",
  id: "l1",
  title: "List",
  view: 1,
  category: null,
}
const inbox: Source = {
  key: "inbox/i1",
  kind: "inbox",
  id: "i1",
  title: "Inbox",
  view: 0,
  category: null,
}
const entry = (
  id: string,
  publishedAt = "2026-02-01T00:00:00.000Z",
  content: string | null = null,
): SourceEntry => ({
  id,
  sourceKey: feed.key,
  feedId: "f1",
  feedKind: "feed",
  title: id,
  url: null,
  publishedAt,
  read: false,
  content,
  description: null,
})
const page = (entries: SourceEntry[], options: Partial<Page> = {}): Page => ({
  entries,
  nextCursor: entries.at(-1)?.publishedAt ?? null,
  pageFull: false,
  boundaryCount: 0,
  ...options,
})

function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  const saved: SourceEntry[] = []
  const state = new SourceSyncStore(db)
  const store = {
    ownerId: "owner",
    // 真实 Store 负责同时更新主来源表和来源同步快照；替身保持同一契约。
    replaceSources: vi.fn((sources: Source[], syncedAt?: string) => {
      if (syncedAt) state.replaceSources(sources, syncedAt)
    }),
    transaction(operation: () => void) {
      operation()
    },
    saveEntry(item: SourceEntry) {
      saved.push(item)
    },
    saveListedEntry(item: SourceEntry) {
      saved.push(item)
    },
  } as unknown as Store
  return { state, store, saved }
}

function reader(input: {
  sources: Source[]
  pages: (source: Source, cursor?: string) => Promise<Page>
  members?: (
    id: string,
  ) => Promise<{ feedIds: string[]; complete: boolean; ownerId?: string | null }>
}) {
  return {
    session: vi.fn(async () => ({ ownerId: "owner", expiresAt: null })),
    sources: vi.fn(async () => input.sources),
    page: vi.fn((source: Source, options: { cursor?: string }) =>
      input.pages(source, options.cursor),
    ),
    listMembers: vi.fn(async (id: string) =>
      input.members ? input.members(id) : { feedIds: [], complete: true },
    ),
  } as unknown as FoloReader
}

afterEach(() => databases.splice(0).forEach((db) => db.close()))

describe("来源增量同步", () => {
  it("后台授权失效会暂停全部所选来源，且不请求条目", async () => {
    const { state, store } = fixture()
    const client = reader({ sources: [feed], pages: async () => page([]) })
    ;(client.session as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new FoloReadError("unauthorized"),
    )
    const result = await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [feed.key],
      historySince: "2026-01-01T00:00:00Z",
    })
    expect(result).toEqual([
      expect.objectContaining({ coverage: "failed", failure: "unauthorized" }),
    ])
    expect(client.page).not.toHaveBeenCalled()
  })

  it("逐页保存到末页，保留已读条目且来源元数据只同步一次", async () => {
    const { state, store, saved } = fixture()
    const pages = [page([entry("new")], { pageFull: true }), page([entry("old")])]
    const client = reader({ sources: [feed], pages: async () => pages.shift()! })
    const result = await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [feed.key],
      historySince: "2026-01-01T00:00:00Z",
      pageSize: 1,
    })
    expect(store.replaceSources).toHaveBeenCalledWith([feed], expect.any(String))
    expect(result).toEqual([
      expect.objectContaining({ sourceKey: feed.key, pages: 2, entries: 2, coverage: "end" }),
    ])
    expect(saved.map((item) => item.id)).toEqual(["new", "old"])
    expect(client.sources).toHaveBeenCalledTimes(1)
    expect(state.state(feed.key)).toMatchObject({
      coverage: "end",
      pending: false,
      lastSuccessAt: expect.any(String),
    })
  })

  it("真实 Store 在单一事务同步两份来源快照，不触发嵌套事务", async () => {
    const store = new Store(":memory:")
    try {
      store.bindOwner("owner")
      const client = reader({ sources: [feed], pages: async () => page([]) })
      const result = await acquireSources({
        store,
        reader: async () => client,
        state: store.sourceSync,
        sourceKeys: [feed.key],
        historySince: "2026-01-01T00:00:00Z",
      })

      expect(result).toEqual([
        expect.objectContaining({ sourceKey: feed.key, coverage: "end", failure: null }),
      ])
      expect(store.sources()).toEqual([feed])
      expect(
        store.sourceSync.contextFor(feed.key, entry("context")).metadata.sourceSyncedAt,
      ).toEqual(expect.any(String))
    } finally {
      store.close()
    }
  })

  it("预算耗尽保存游标，后续运行从游标继续，不把未扫描来源静默排除", async () => {
    const { state, store } = fixture()
    const calls: Array<string | undefined> = []
    const client = reader({
      sources: [feed, inbox],
      pages: async (source, cursor) => {
        calls.push(`${source.key}:${cursor ?? "start"}`)
        return source.key === feed.key ? page([entry("first")], { pageFull: true }) : page([])
      },
    })
    const first = await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [feed.key, inbox.key],
      historySince: "2026-01-01T00:00:00Z",
      pageBudget: 1,
      pageSize: 1,
    })
    expect(first.map((item) => item.coverage)).toEqual(["budget", "budget"])
    await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [feed.key],
      historySince: "2026-01-01T00:00:00Z",
      pageBudget: 1,
      pageSize: 1,
    })
    expect(calls[1]).toBe(`feed/f1:${entry("first").publishedAt}`)
  })

  it("22 个来源在两批 20 页预算内都至少获得一页，不让末尾来源长期饥饿", async () => {
    const { state, store } = fixture()
    const sources = Array.from({ length: 22 }, (_, index): Source => ({
      key: `feed/${index + 1}`,
      kind: "feed",
      id: String(index + 1),
      title: `来源 ${index + 1}`,
      view: 0,
      category: null,
    }))
    const calls: string[] = []
    const client = reader({
      sources,
      pages: async (source) => {
        calls.push(source.key)
        return page(
          [
            {
              ...entry(`entry-${source.id}`),
              sourceKey: source.key,
              feedId: source.id,
              feedKind: "feed",
            },
          ],
          { pageFull: true },
        )
      },
    })
    const input = {
      store,
      reader: async () => client,
      state,
      sourceKeys: sources.map((source) => source.key),
      historySince: "2026-01-01T00:00:00Z",
      pageBudget: 20,
      pageSize: 1,
    }

    await acquireSources(input)
    expect(calls).toHaveLength(20)
    expect(state.state(sources[20]!.key)).toMatchObject({ coverage: "budget", cursor: null })
    expect(state.state(sources[21]!.key)).toMatchObject({ coverage: "budget", cursor: null })

    await acquireSources(input)
    expect(calls.slice(20, 22)).toEqual([sources[20]!.key, sources[21]!.key])
    expect(new Set(calls)).toEqual(new Set(sources.map((source) => source.key)))
    expect(sources.map((source) => state.state(source.key))).not.toContain(null)
  })

  it("已覆盖来源超过页预算时，下一轮优先刷新未轮到的旧来源", async () => {
    const { state, store } = fixture()
    const sources: Source[] = Array.from({ length: 22 }, (_, index) => ({
      ...feed,
      key: `feed/${index + 1}`,
      id: String(index + 1),
    }))
    const historySince = "2026-01-01T00:00:00.000Z"
    for (const source of sources)
      state.savePage({
        sourceKey: source.key,
        cursor: null,
        historySince,
        coverage: "end",
        pending: false,
        now: historySince,
      })
    const calls: string[] = []
    const client = reader({
      sources,
      pages: async (source) => {
        calls.push(source.key)
        return page([])
      },
    })
    const input = {
      store,
      state,
      reader: async () => client,
      sourceKeys: sources.map((source) => source.key),
      historySince,
      pageBudget: 20,
    }
    await acquireSources(input)
    expect(calls).toEqual(sources.slice(0, 20).map((source) => source.key))
    // 尾部保持原覆盖事实，但其较旧的采集时间让它们在下轮先执行。
    expect(state.state(sources[21]!.key)).toMatchObject({
      coverage: "end",
      lastSuccessAt: historySince,
    })
    await acquireSources(input)
    expect(calls.slice(20, 22)).toEqual(sources.slice(20).map((source) => source.key))
    expect(new Set(calls).size).toBe(22)
  })

  it("List 成员每轮只拉取一次，失败保留 unknown 而不当成空集合", async () => {
    const { state, store } = fixture()
    const client = reader({
      sources: [list],
      pages: async () => page([]),
      members: async () => ({ feedIds: ["f1"], complete: true, ownerId: "owner-list-1" }),
    })
    await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [list.key],
      historySince: "2026-01-01T00:00:00Z",
    })
    expect(client.listMembers).toHaveBeenCalledTimes(1)
    const complete = state.contextFor(list.key, { ...entry("x"), sourceKey: list.key })
    expect(complete.listMembership).toEqual({ [list.id]: true })
    expect(complete.metadata.listMembershipVersion).toBe(1)
    expect(state.listMemberships()).toEqual([
      {
        listKey: list.key,
        ownerId: "owner-list-1",
        feedIds: ["f1"],
        complete: true,
        status: "complete",
        revision: 1,
        syncedAt: expect.any(String),
      },
    ])
    expect(
      state.contextFor(list.key, {
        ...entry("container"),
        sourceKey: list.key,
        feedId: undefined,
        feedKind: undefined,
      }).sourceId,
    ).toBeNull()
    ;(client.listMembers as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new FoloReadError("unauthorized"),
    )
    await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [list.key],
      historySince: "2026-01-01T00:00:00Z",
    })
    const unknown = state.contextFor(list.key, { ...entry("x"), sourceKey: list.key })
    expect(unknown.listMembership).toEqual({ [list.id]: null })
    expect(unknown.metadata.listMembershipVersion).toBe(2)
    expect(state.listMemberships()[0]).toMatchObject({
      listKey: list.key,
      ownerId: "owner-list-1",
      feedIds: ["f1"],
      status: "unknown",
      revision: 2,
    })
  })

  it("旧 List 成员表原位增加 owner_id，并保持历史快照可读", () => {
    const db = new DatabaseSync(":memory:")
    databases.push(db)
    db.exec(`
      CREATE TABLE source_sync_list_memberships (
        list_key TEXT PRIMARY KEY, feed_ids TEXT NOT NULL, complete INTEGER NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL, synced_at TEXT, error TEXT
      );
      INSERT INTO source_sync_list_memberships VALUES(
        'list/l1', '["f1"]', 1, 'complete', 2, '2026-09-19T00:00:00.000Z', NULL
      );
    `)

    const state = new SourceSyncStore(db)
    expect(state.listMemberships()).toEqual([
      {
        listKey: "list/l1",
        ownerId: null,
        feedIds: ["f1"],
        complete: true,
        status: "complete",
        revision: 2,
        syncedAt: "2026-09-19T00:00:00.000Z",
      },
    ])

    state.saveListMembership(
      "list/l1",
      { feedIds: ["f1"], complete: true, ownerId: "owner-list-1" },
      "2026-09-20T00:00:00.000Z",
    )
    expect(state.listMemberships()[0]).toMatchObject({ ownerId: "owner-list-1", revision: 3 })
  })

  it("规则引用的 List 只同步成员，不扩大本轮条目采集来源", async () => {
    const { state, store } = fixture()
    const client = reader({
      sources: [feed, list],
      pages: async (source) => {
        expect(source.key).toBe(feed.key)
        return page([])
      },
      members: async () => ({ feedIds: [feed.id], complete: true }),
    })

    const result = await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [feed.key],
      membershipListKeys: [list.key],
      historySince: "2026-01-01T00:00:00Z",
    })

    expect(result.map((item) => item.sourceKey)).toEqual([feed.key])
    expect(client.page).toHaveBeenCalledTimes(1)
    expect(client.listMembers).toHaveBeenCalledWith(list.id)
    expect(state.state(list.key)).toBeNull()
    expect(state.contextFor(feed.key, entry("member")).listMembership).toEqual({ [list.id]: true })
  })

  it("旧发布日期的新到达与正文更新仍会保存，不按发布时间静默过滤", async () => {
    const { state, store, saved } = fixture()
    const oldPublishedAt = "2025-12-01T00:00:00.000Z"
    const pages = [
      page([entry("late", oldPublishedAt, "旧正文")]),
      page([entry("late", oldPublishedAt, "修正正文")]),
    ]
    const client = reader({ sources: [feed], pages: async () => pages.shift()! })
    const input = {
      store,
      reader: async () => client,
      state,
      sourceKeys: [feed.key],
      historySince: "2026-01-01T00:00:00Z",
    }
    await acquireSources(input)
    await acquireSources(input)
    expect(saved.map((item) => item.content)).toEqual(["旧正文", "修正正文"])
    expect(state.state(feed.key)).toMatchObject({ coverage: "end", pending: false })
  })

  it("同时间戳满页明确标记缺口并停止，inbox 失败仍计入覆盖结果", async () => {
    const { state, store } = fixture()
    const client = reader({
      sources: [feed, inbox],
      pages: async (source) => {
        if (source.key === inbox.key) throw new FoloReadError("unauthorized")
        return page([entry("a"), entry("b")], { pageFull: true, boundaryCount: 2 })
      },
    })
    const result = await acquireSources({
      store,
      reader: async () => client,
      state,
      sourceKeys: [feed.key, inbox.key],
      historySince: "2026-01-01T00:00:00Z",
      pageSize: 2,
    })
    expect(result).toEqual([
      expect.objectContaining({ sourceKey: feed.key, coverage: "timestamp_boundary" }),
      expect.objectContaining({
        sourceKey: inbox.key,
        coverage: "failed",
        failure: "unauthorized",
      }),
    ])
    expect(client.page).toHaveBeenCalledTimes(2)
  })
})
