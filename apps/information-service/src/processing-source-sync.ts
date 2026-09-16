import type { DatabaseSync } from "node:sqlite"

import type { FoloReader, Source, SourceEntry } from "./folo"
import { FoloReadError } from "./folo"
import type { Store } from "./store"

export type SourceCoverage =
  "pending" | "end" | "history_boundary" | "budget" | "timestamp_boundary" | "failed"

export type SourceSyncState = {
  sourceKey: string
  cursor: string | null
  historySince: string
  lastSuccessAt: string | null
  coverage: SourceCoverage
  coverageBoundary: string | null
  failure: string | null
  pending: boolean
  updatedAt: string
}

export type SourceSyncContext = {
  sourceId: string | null
  contextId: string
  view: number | null
  categoryRef: { view: number; name: string } | null
  listMembership: Record<string, boolean | null>
  metadata: { sourceSyncedAt: string | null; listMembershipVersion: number }
}

export type SourceSyncResult = {
  sourceKey: string
  pages: number
  entries: number
  coverage: SourceCoverage
  failure: string | null
}

export class SourceSyncError extends Error {
  constructor(public readonly code: "invalid_input" | "aborted") {
    super(code)
    this.name = "SourceSyncError"
  }
}

type ListMembership = {
  feedIds: string[]
  complete: boolean
  status: "complete" | "unknown"
  revision: number
  syncedAt: string | null
}

function iso(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new SourceSyncError("invalid_input")
  return new Date(value).toISOString()
}

function keys(value: readonly string[]): string[] {
  const unique = [...new Set(value)]
  if (
    !unique.length ||
    unique.some((key) => !/^(?:feed|list|inbox)\/[^/\s]+$/u.test(key) || key.length > 300)
  )
    throw new SourceSyncError("invalid_input")
  return unique
}

function sourceFromRow(row: Record<string, unknown>): Source {
  return JSON.parse(String(row.body)) as Source
}

// 来源同步状态与正文同库时，调用方可把 savePage 放进 Store.transaction，保证正文和游标原子推进。
export class SourceSyncStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly virtualSources: () => Source[] = () => [],
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_sync_states (
        source_key TEXT PRIMARY KEY, cursor TEXT, history_since TEXT NOT NULL,
        last_success_at TEXT, coverage TEXT NOT NULL, coverage_boundary TEXT,
        failure TEXT, pending INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_sync_sources (
        source_key TEXT PRIMARY KEY, body TEXT NOT NULL, active INTEGER NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_sync_list_memberships (
        list_key TEXT PRIMARY KEY, feed_ids TEXT NOT NULL, complete INTEGER NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL, synced_at TEXT, error TEXT
      );
    `)
  }

  replaceSources(sources: Source[], syncedAt: string) {
    this.db.exec("UPDATE source_sync_sources SET active=0")
    const insert = this.db.prepare("INSERT OR REPLACE INTO source_sync_sources VALUES(?,?,1,?)")
    for (const source of sources) insert.run(source.key, JSON.stringify(source), syncedAt)
  }

  source(sourceKey: string): Source | null {
    const virtual = this.virtualSources().find((source) => source.key === sourceKey)
    if (virtual) return { ...virtual, platform: "X" }
    const row = this.db
      .prepare("SELECT body FROM source_sync_sources WHERE source_key=? AND active=1")
      .get(sourceKey)
    return row ? sourceFromRow(row) : null
  }

  begin(sourceKey: string, historySince: string, now: string): SourceSyncState {
    const previous = this.state(sourceKey)
    if (previous?.pending && previous.historySince === historySince) return previous
    const state: SourceSyncState = {
      sourceKey,
      cursor: null,
      historySince,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      coverage: "pending",
      coverageBoundary: null,
      failure: null,
      pending: true,
      updatedAt: now,
    }
    this.writeState(state)
    return state
  }

  savePage(input: {
    sourceKey: string
    cursor: string | null
    historySince: string
    coverage: SourceCoverage
    coverageBoundary?: string | null
    pending: boolean
    now: string
  }) {
    const previous = this.state(input.sourceKey)
    this.writeState({
      sourceKey: input.sourceKey,
      cursor: input.cursor,
      historySince: input.historySince,
      lastSuccessAt:
        input.coverage === "end" || input.coverage === "history_boundary"
          ? input.now
          : (previous?.lastSuccessAt ?? null),
      coverage: input.coverage,
      coverageBoundary: input.coverageBoundary ?? null,
      failure: null,
      pending: input.pending,
      updatedAt: input.now,
    })
  }

  fail(sourceKey: string, historySince: string, now: string, failure: string) {
    const previous = this.state(sourceKey)
    this.writeState({
      sourceKey,
      cursor: previous?.cursor ?? null,
      historySince,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      coverage: "failed",
      coverageBoundary: previous?.coverageBoundary ?? null,
      failure,
      pending: true,
      updatedAt: now,
    })
  }

  budget(sourceKey: string, historySince: string, now: string) {
    const previous = this.state(sourceKey)
    this.writeState({
      sourceKey,
      cursor: previous?.cursor ?? null,
      historySince,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      coverage: "budget",
      coverageBoundary: previous?.coverageBoundary ?? null,
      failure: null,
      pending: true,
      updatedAt: now,
    })
  }

  state(sourceKey: string): SourceSyncState | null {
    const row = this.db
      .prepare("SELECT * FROM source_sync_states WHERE source_key=?")
      .get(sourceKey)
    return row ? this.stateFromRow(row) : null
  }

  contextFor(sourceKey: string, entry: SourceEntry): SourceSyncContext {
    const source = this.source(sourceKey)
    const actualFeedId = entry.feedId ?? (source?.kind === "feed" ? source.id : null)
    const memberships = this.db
      .prepare("SELECT * FROM source_sync_list_memberships ORDER BY list_key")
      .all()
    const listMembership: Record<string, boolean | null> = {}
    let listMembershipVersion = 0
    for (const row of memberships) {
      const membership = this.membershipFromRow(row)
      listMembershipVersion = Math.max(listMembershipVersion, membership.revision)
      // 规则条件保存的是官方 list ID，不是服务内部的 `list/<id>` 来源键。
      listMembership[listId(String(row.list_key))] =
        membership.status === "complete" && membership.complete && actualFeedId !== null
          ? membership.feedIds.includes(actualFeedId)
          : null
    }
    return {
      sourceId: entry.feedId
        ? `${entry.feedKind ?? "feed"}/${entry.feedId}`
        : source?.kind === "list"
          ? null
          : sourceKey,
      contextId: sourceKey,
      view: source?.view ?? null,
      categoryRef:
        source?.category === null || source?.category === undefined
          ? null
          : { view: source.view, name: source.category },
      listMembership,
      metadata: {
        sourceSyncedAt: source ? this.sourceSyncedAt(sourceKey) : null,
        listMembershipVersion,
      },
    }
  }

  saveListMembership(
    listKey: string,
    result: { feedIds: string[]; complete: boolean },
    now: string,
  ) {
    const previous = this.membership(listKey)
    const feedIds = [...new Set(result.feedIds)].sort()
    const changed =
      !previous ||
      previous.complete !== result.complete ||
      previous.status !== "complete" ||
      JSON.stringify(previous.feedIds) !== JSON.stringify(feedIds)
    this.db
      .prepare("INSERT OR REPLACE INTO source_sync_list_memberships VALUES(?,?,?,?,?,?,?)")
      .run(
        listKey,
        JSON.stringify(feedIds),
        Number(result.complete),
        "complete",
        (previous?.revision ?? 0) + Number(changed),
        now,
        null,
      )
  }

  unknownListMembership(listKey: string, now: string, error: string) {
    const previous = this.membership(listKey)
    const changed = !previous || previous.status !== "unknown"
    this.db
      .prepare("INSERT OR REPLACE INTO source_sync_list_memberships VALUES(?,?,?,?,?,?,?)")
      .run(
        listKey,
        JSON.stringify(previous?.feedIds ?? []),
        Number(previous?.complete ?? false),
        "unknown",
        (previous?.revision ?? 0) + Number(changed),
        previous?.syncedAt ?? null,
        error,
      )
  }

  private writeState(state: SourceSyncState) {
    this.db
      .prepare("INSERT OR REPLACE INTO source_sync_states VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        state.sourceKey,
        state.cursor,
        state.historySince,
        state.lastSuccessAt,
        state.coverage,
        state.coverageBoundary,
        state.failure,
        Number(state.pending),
        state.updatedAt,
      )
  }

  private sourceSyncedAt(sourceKey: string): string | null {
    const row = this.db
      .prepare("SELECT synced_at FROM source_sync_sources WHERE source_key=? AND active=1")
      .get(sourceKey)
    return row ? String(row.synced_at) : null
  }

  private membership(listKey: string): ListMembership | null {
    const row = this.db
      .prepare("SELECT * FROM source_sync_list_memberships WHERE list_key=?")
      .get(listKey)
    return row ? this.membershipFromRow(row) : null
  }

  private membershipFromRow(row: Record<string, unknown>): ListMembership {
    return {
      feedIds: JSON.parse(String(row.feed_ids)) as string[],
      complete: Boolean(row.complete),
      status: String(row.status) as "complete" | "unknown",
      revision: Number(row.revision),
      syncedAt: row.synced_at === null ? null : String(row.synced_at),
    }
  }

  private stateFromRow(row: Record<string, unknown>): SourceSyncState {
    return {
      sourceKey: String(row.source_key),
      cursor: row.cursor === null ? null : String(row.cursor),
      historySince: String(row.history_since),
      lastSuccessAt: row.last_success_at === null ? null : String(row.last_success_at),
      coverage: String(row.coverage) as SourceCoverage,
      coverageBoundary: row.coverage_boundary === null ? null : String(row.coverage_boundary),
      failure: row.failure === null ? null : String(row.failure),
      pending: Boolean(row.pending),
      updatedAt: String(row.updated_at),
    }
  }
}

function listId(listKey: string): string {
  return listKey.startsWith("list/") ? listKey.slice("list/".length) : listKey
}

export async function acquireSources(
  input: {
    store: Store
    reader: () => Promise<FoloReader>
    state: SourceSyncStore
    sourceKeys: string[]
    historySince: string
    pageBudget?: number
    pageSize?: number
  },
  signal?: AbortSignal,
): Promise<SourceSyncResult[]> {
  const sourceKeys = keys(input.sourceKeys)
  const historySince = iso(input.historySince)
  const pageBudget = input.pageBudget ?? 20
  const pageSize = input.pageSize ?? 100
  if (
    !Number.isInteger(pageBudget) ||
    pageBudget < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new SourceSyncError("invalid_input")
  const abort = () => {
    if (signal?.aborted) throw new SourceSyncError("aborted")
  }
  abort()
  const reader = await input.reader()
  abort()
  const now = new Date().toISOString()
  let sources: Source[]
  try {
    // 同一轮只核验一次账号、拉取一次订阅与 List 元数据，后续每页不重复请求。
    const session = await reader.session()
    if (input.store.ownerId !== session.ownerId) throw new SourceSyncError("invalid_input")
    sources = await reader.sources()
    // Store 内部把两份来源快照一起提交，避免此处嵌套 BEGIN 使首批同步立刻失败。
    input.store.replaceSources(sources, now)
  } catch (error) {
    const failure = syncFailure(error)
    for (const sourceKey of sourceKeys) input.state.fail(sourceKey, historySince, now, failure)
    return sourceKeys.map((sourceKey) => ({
      sourceKey,
      pages: 0,
      entries: 0,
      coverage: "failed",
      failure,
    }))
  }
  const selected = sourceKeys
    .map((sourceKey, index) => ({
      sourceKey,
      source: sources.find((item) => item.key === sourceKey),
      index,
      previous: input.state.state(sourceKey),
    }))
    .sort(
      (left, right) =>
        sourcePriority(left.previous) - sourcePriority(right.previous) ||
        // 同为已覆盖来源时先刷新最久未成功采集的，避免预算较小时尾部来源永远不更新。
        (left.previous?.lastSuccessAt ?? "").localeCompare(right.previous?.lastSuccessAt ?? "") ||
        left.index - right.index,
    )
  await syncListMemberships(
    reader,
    input.state,
    selected.flatMap(({ source }) => (source?.kind === "list" ? [source] : [])),
    now,
    signal,
  )

  const progress = new Map<string, { pages: number; entries: number }>()
  const ready = [] as Array<{
    sourceKey: string
    source: Source
    current: SourceSyncState | null
    done: boolean
  }>
  for (const { sourceKey, source } of selected) {
    abort()
    if (!source) {
      input.state.fail(sourceKey, historySince, now, "source_missing")
      continue
    }
    ready.push({ sourceKey, source, current: null, done: false })
  }

  let remaining = pageBudget
  // 每轮每个来源最多先取一页；来源多于预算时，下一轮会优先未取到页的 budget 状态。
  while (remaining > 0 && ready.some((item) => !item.done)) {
    let progressed = false
    for (const item of ready) {
      if (remaining === 0) break
      if (item.done) continue
      const { sourceKey, source } = item
      const current = item.current ?? input.state.begin(sourceKey, historySince, now)
      try {
        abort()
        const page = await reader.page(source, {
          cursor: current.cursor ?? undefined,
          limit: pageSize,
        })
        abort()
        const currentProgress = progress.get(sourceKey) ?? { pages: 0, entries: 0 }
        currentProgress.pages += 1
        currentProgress.entries += page.entries.length
        progress.set(sourceKey, currentProgress)
        remaining -= 1
        progressed = true
        const timestampGap = page.pageFull && page.boundaryCount > 1
        const repeatedCursor = page.pageFull && page.nextCursor === current.cursor
        const reachedHistory =
          page.entries.length > 0 && page.entries.every((entry) => entry.publishedAt < historySince)
        const coverage: SourceCoverage =
          timestampGap || repeatedCursor
            ? "timestamp_boundary"
            : !page.pageFull
              ? "end"
              : reachedHistory
                ? "history_boundary"
                : remaining === 0
                  ? "budget"
                  : "pending"
        const pending = coverage === "pending" || coverage === "budget"
        // 正文、自动化输入和游标一同提交；崩溃后只会从已保存游标继续。
        input.store.transaction(() => {
          for (const entry of page.entries) input.store.saveListedEntry(entry)
          input.state.savePage({
            sourceKey,
            cursor: coverage === "timestamp_boundary" ? current.cursor : page.nextCursor,
            historySince,
            coverage,
            coverageBoundary: page.nextCursor,
            pending,
            now,
          })
        })
        item.current = input.state.state(sourceKey)!
        if (!pending) item.done = true
      } catch (error) {
        if (error instanceof SourceSyncError && error.code === "aborted") throw error
        input.state.fail(sourceKey, historySince, now, syncFailure(error))
        item.done = true
      }
    }
    if (!progressed) break
  }
  if (remaining === 0) {
    for (const { sourceKey } of ready) {
      const state = input.state.state(sourceKey)
      // 未轮到的来源写成 budget；已完整覆盖的旧状态必须保留，不能伪装为待补。
      if (!state || state.coverage === "pending") input.state.budget(sourceKey, historySince, now)
    }
  }
  return selected.map(({ sourceKey }) => {
    const state = input.state.state(sourceKey)
    const value = progress.get(sourceKey) ?? { pages: 0, entries: 0 }
    return {
      sourceKey,
      pages: value.pages,
      entries: value.entries,
      coverage: state?.coverage ?? "failed",
      failure: state ? state.failure : "source_missing",
    }
  })
}

function sourcePriority(state: SourceSyncState | null): number {
  // 无游标的 budget 表示上一批从未取到该来源，必须先于已推进游标的待补来源。
  if (state?.pending && state.coverage === "budget" && state.cursor === null) return 0
  if (state?.pending) return 1
  if (!state) return 2
  return 3
}

async function syncListMemberships(
  reader: FoloReader,
  state: SourceSyncStore,
  sources: Source[],
  now: string,
  signal?: AbortSignal,
) {
  for (const source of sources) {
    if (signal?.aborted) throw new SourceSyncError("aborted")
    try {
      state.saveListMembership(source.key, await reader.listMembers(source.id), now)
    } catch (error) {
      // 读取失败不能把旧成员快照写成空集合；条件层会得到 unknown。
      state.unknownListMembership(source.key, now, syncFailure(error))
    }
  }
}

function syncFailure(error: unknown): string {
  return error instanceof FoloReadError ? error.code : "sync_failed"
}
