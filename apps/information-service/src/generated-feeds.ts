import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import { z } from "zod"

import type { StoryStore } from "./story-store"

// 私人生成源只存在于本地阅读投影，不能作为官方 feedId 或采集来源。
export const GENERATED_EVENTS_FEED_ID = "generated:events" as const
export const generatedEventsFeed = {
  id: GENERATED_EVENTS_FEED_ID,
  origin: "generated" as const,
  title: "事件综述",
  private: true as const,
}

export const generatedFeedQuerySchema = z
  .object({
    feedId: z.literal(GENERATED_EVENTS_FEED_ID).optional(),
    mode: z.enum(["stories", "smart", "collections"]).default("stories"),
    snapshotId: z.uuid().optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(50).default(30),
    search: z.string().trim().max(300).optional(),
    topic: z.string().trim().max(100).optional(),
    unreadOnly: z.boolean().default(false),
    collectedOnly: z.boolean().default(false),
    // 普通视图按同步来源的 view 解析，List 和 Inbox 不退化为 feed 名单。
    view: z.union([z.number().int().min(0).max(5), z.literal("all")]).optional(),
    sourceKeys: z.array(z.string().min(1).max(300)).max(10000).optional(),
    category: z
      // 全局分类按名称跨视图读取；单视图分类仍保留 view 与名称的联合身份。
      .object({
        view: z.union([z.number().int().min(0).max(5), z.literal("all")]),
        name: z.string().max(200),
      })
      .strict()
      .optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    refresh: z.boolean().default(false),
  })
  .strict()
  .refine(
    (query) => !query.since || !query.until || Date.parse(query.since) <= Date.parse(query.until),
    {
      message: "invalid_time_range",
    },
  )
export type GeneratedFeedQuery = z.infer<typeof generatedFeedQuerySchema>
export type GeneratedFeedScope = Omit<
  GeneratedFeedQuery,
  "snapshotId" | "cursor" | "limit" | "refresh"
>

type GeneratedItemFields = {
  id: string
  title: string
  summary: string
  publishedAt: string
  updatedAt: string
  read: boolean
  collected: boolean
  collectedAt?: string | null
  materialCount: number
  topics: string[]
  sourceKeys: string[]
}
export type GeneratedStoryItem = GeneratedItemFields & {
  kind: "story"
  origin: "generated"
  generatedFeedId: typeof GENERATED_EVENTS_FEED_ID
  storyId: string
  revision: number
  substantiveRevision: number
  hasImportantUpdate: boolean
}
export type GeneratedEntryItem = GeneratedItemFields & {
  kind: "entry"
  origin: "original"
  inputSeq: number | null
  sourceKey: string
  decisionId: string | null
  storyIds: string[]
  view?: number
  officialCollection?: true
}
export type GeneratedReaderItem = GeneratedStoryItem | GeneratedEntryItem
export type GeneratedFeedCounts = {
  pending: number
  failed: number
  needsContext: number
  // 库存计数在搜索、读态、收藏与时间筛选前计算，表示当前来源范围的处理材料。
  inputs?: number
  uncovered?: number
  hidden?: number
  folded?: number
}
export type GeneratedFeedPage = {
  feed: typeof generatedEventsFeed
  snapshotId: string
  latestAvailable: boolean
  total: number
  nextCursor: string | null
  items: GeneratedReaderItem[]
  counts: GeneratedFeedCounts
}
export type GeneratedReaderProjection = {
  items: GeneratedReaderItem[]
  counts: GeneratedFeedCounts
  // 冻结候选库保留被折叠和隐藏的原文，人工恢复能立即显示而无需接纳后台新条目。
  reservoir?: GeneratedReaderItem[]
}

// 搜索与主题在服务端选材和折叠之前判定，避免隐藏了原文却没有可达的综述入口。
export function matchesGeneratedItem(item: GeneratedReaderItem, query: GeneratedFeedScope) {
  return (
    (!query.unreadOnly || !item.read) &&
    (!query.collectedOnly || item.collected) &&
    (!query.topic || item.topics.includes(query.topic)) &&
    (!query.since || Date.parse(item.publishedAt) >= Date.parse(query.since)) &&
    (!query.until || Date.parse(item.publishedAt) <= Date.parse(query.until)) &&
    (!query.search ||
      `${item.title}\n${item.summary}`
        .toLocaleLowerCase()
        .includes(query.search.toLocaleLowerCase()))
  )
}

// 快照固定列表成员、排序和正文版本；读态与收藏仍实时读取，不会回写原文读态。
export class GeneratedFeedStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerId: () => string | null,
    private readonly stories: StoryStore,
    private readonly project: (query: GeneratedFeedScope) => GeneratedReaderProjection,
    private readonly liveState: (item: GeneratedReaderItem) => {
      allowed: boolean
      restored: boolean
      read: boolean
      collected: boolean
    },
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS generated_reader_snapshots (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generated_reader_snapshot_owner
      ON generated_reader_snapshots(owner_id,scope_key,created_at DESC);`)
  }

  page(query: GeneratedFeedQuery): GeneratedFeedPage {
    const ownerId = this.requireOwner()
    const { snapshotId, cursor, limit, refresh, ...rawScope } = query
    const scope = {
      ...rawScope,
      sourceKeys: rawScope.sourceKeys ? [...new Set(rawScope.sourceKeys)].sort() : undefined,
    }
    const scopeKey = createHash("sha256").update(JSON.stringify(scope)).digest("hex")
    const decoded = cursor ? this.decodeCursor(cursor) : null
    if (snapshotId && decoded && decoded.snapshotId !== snapshotId)
      throw new Error("invalid_generated_cursor")
    const requestedId = decoded?.snapshotId ?? snapshotId
    let row = requestedId
      ? this.db
          .prepare(
            "SELECT id,body,scope_key FROM generated_reader_snapshots WHERE id=? AND owner_id=?",
          )
          .get(requestedId, ownerId)
      : refresh
        ? undefined
        : this.db
            .prepare(
              "SELECT id,body,scope_key FROM generated_reader_snapshots WHERE owner_id=? AND scope_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(ownerId, scopeKey)
    if (requestedId && !row) throw new Error("generated_snapshot_not_found")
    // 分页不能把另一个筛选范围的游标误用于当前列表。
    if (row && String(row.scope_key) !== scopeKey) throw new Error("invalid_generated_cursor")
    if (!row) {
      const id = randomUUID()
      const projection = this.project(scope)
      const snapshot = { scope, projection }
      this.db
        .prepare("INSERT INTO generated_reader_snapshots VALUES(?,?,?,?,?)")
        .run(id, ownerId, scopeKey, JSON.stringify(snapshot), new Date().toISOString())
      row = { id, body: JSON.stringify(snapshot), scope_key: scopeKey }
    }
    const saved = JSON.parse(String(row.body)) as {
      scope: GeneratedFeedScope
      projection: GeneratedReaderProjection
    }
    const current = this.project(saved.scope)
    // 只人工纠错和来源资格能改变冻结成员；后台新决定不能令正在阅读的旧行跳位。
    const frozen = saved.projection.reservoir ?? saved.projection.items
    const capturedVisible = new Set(saved.projection.items.map((item) => this.itemKey(item)))
    const available = new Map(frozen.map((item) => [this.itemKey(item), this.liveState(item)]))
    const visible = (item: GeneratedReaderItem) => {
      const live = available.get(this.itemKey(item))!
      return live.allowed && (capturedVisible.has(this.itemKey(item)) || live.restored)
    }
    let offset = decoded?.offset ?? 0
    if (offset > frozen.length) throw new Error("invalid_generated_cursor")
    const items: GeneratedReaderItem[] = []
    while (offset < frozen.length && items.length < limit) {
      const item = frozen[offset++]!
      if (!visible(item)) continue
      const live = available.get(this.itemKey(item))!
      items.push(
        item.kind === "story"
          ? this.withReaderState(item, ownerId)
          : { ...item, read: live.read, collected: live.collected },
      )
    }
    const signature = (entries: GeneratedReaderItem[]) =>
      JSON.stringify(
        entries.map((item) => [
          this.itemKey(item),
          item.kind === "story" ? item.revision : item.decisionId,
        ]),
      )
    return {
      feed: generatedEventsFeed,
      snapshotId: String(row.id),
      latestAvailable: signature(current.items) !== signature(saved.projection.items),
      total: frozen.filter(visible).length,
      nextCursor:
        offset < frozen.length
          ? Buffer.from(JSON.stringify({ snapshotId: String(row.id), offset })).toString(
              "base64url",
            )
          : null,
      items,
      counts: current.counts,
    }
  }

  readerState(
    storyId: string,
    changes?: { read?: boolean; collected?: boolean; revision?: number },
  ) {
    const ownerId = this.requireOwner()
    if (changes?.read === true) this.stories.markRead(storyId, ownerId, changes.revision)
    else if (changes?.read === false) this.stories.markUnread(storyId, ownerId)
    if (changes?.collected !== undefined)
      this.stories.setCollected(storyId, ownerId, changes.collected)
    const state = this.stories.readStatus(storyId, ownerId)
    return {
      storyId,
      read: !state.unread,
      collected: this.stories.isCollected(storyId, ownerId),
      hasImportantUpdate: state.unread && state.readSubstantiveRevision > 0,
      link: this.stories.resolveLink(storyId),
    }
  }

  // 深链通过同一范围与冻结快照定位，不能按首批结果猜测，也不能绕过账号资格。
  locate(query: GeneratedFeedQuery, target: { entryId?: string; storyId?: string }) {
    const page = this.page(query)
    const row = this.db
      .prepare("SELECT body FROM generated_reader_snapshots WHERE id=? AND owner_id=?")
      .get(page.snapshotId, this.requireOwner())!
    const saved = JSON.parse(String(row.body)) as { projection: GeneratedReaderProjection }
    const frozen = saved.projection.reservoir ?? saved.projection.items
    const captured = new Set(saved.projection.items.map((item) => this.itemKey(item)))
    let visibleCount = 0
    let pageOffset = 0
    let previousPageOffset = 0
    for (let index = 0; index < frozen.length; index++) {
      const item = frozen[index]!
      const state = this.liveState(item)
      if (!state.allowed || (!captured.has(this.itemKey(item)) && !state.restored)) continue
      if (visibleCount > 0 && visibleCount % query.limit === 0) {
        previousPageOffset = pageOffset
        pageOffset = index
      }
      const matches =
        item.kind === "entry" ? item.id === target.entryId : item.storyId === target.storyId
      if (matches)
        return {
          snapshotId: page.snapshotId,
          cursor: pageOffset
            ? Buffer.from(
                JSON.stringify({ snapshotId: page.snapshotId, offset: pageOffset }),
              ).toString("base64url")
            : null,
          previousCursor: previousPageOffset
            ? Buffer.from(
                JSON.stringify({ snapshotId: page.snapshotId, offset: previousPageOffset }),
              ).toString("base64url")
            : null,
        }
      visibleCount++
    }
    return null
  }

  private withReaderState(item: GeneratedStoryItem, ownerId: string): GeneratedStoryItem {
    const status = this.stories.readStatus(item.storyId, ownerId)
    const read = status.readSubstantiveRevision >= item.substantiveRevision
    return {
      ...item,
      read,
      collected: this.stories.isCollected(item.storyId, ownerId),
      hasImportantUpdate: status.unread && status.readSubstantiveRevision > 0,
    }
  }

  private itemKey(item: GeneratedReaderItem) {
    return item.kind === "story" ? `story:${item.storyId}` : `entry:${item.sourceKey}:${item.id}`
  }

  private decodeCursor(cursor: string) {
    try {
      return z
        .object({ snapshotId: z.uuid(), offset: z.number().int().nonnegative() })
        .strict()
        .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
    } catch {
      throw new Error("invalid_generated_cursor")
    }
  }

  private requireOwner() {
    const ownerId = this.ownerId()
    if (!ownerId) throw new Error("owner_required")
    return ownerId
  }
}
