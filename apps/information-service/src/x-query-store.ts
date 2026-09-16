import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import { z } from "zod"

const queryInputSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    title: z.string().trim().min(1).max(120),
    view: z.number().int().nonnegative(),
    category: z.string().trim().min(1).max(120).nullable(),
    enabled: z.boolean().default(true),
  })
  .strict()
export type XSavedQueryInput = z.input<typeof queryInputSchema>
export type XSavedQuery = z.output<typeof queryInputSchema> & {
  id: string
  sourceKey: string
  createdAt: string
  updatedAt: string
}
export type XQueryStatus =
  | "idle"
  | "pending"
  | "complete"
  | "budget"
  | "unconfigured"
  | "rate_limited"
  | "forbidden"
  | "insufficient_access"
  | "billing"
  | "failed"
export type XQueryState = {
  queryId: string
  nextToken: string | null
  scanSinceId: string | null
  candidateHighWaterId: string | null
  highWaterId: string | null
  pending: boolean
  status: XQueryStatus
  failure: string | null
  retryAt: string | null
  updatedAt: string
}
export type XVirtualSource = {
  key: string
  kind: "x_search"
  id: string
  title: string
  view: number
  category: string | null
}
export class XQueryError extends Error {
  constructor(
    public readonly code: "invalid_query" | "not_found" | "state_conflict" | "owner_required",
  ) {
    super(code)
  }
}

// 保存查询拥有独立虚拟来源；同一帖子只进入一次输入队列，但保留每个查询的绑定记录。
export class XQueryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: () => string | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS x_saved_queries (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS x_query_states (
        query_id TEXT PRIMARY KEY, next_token TEXT, scan_since_id TEXT, candidate_high_water_id TEXT,
        high_water_id TEXT, pending INTEGER NOT NULL, status TEXT NOT NULL, failure TEXT, retry_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS x_post_bindings (
        post_id TEXT NOT NULL, query_id TEXT NOT NULL, canonical_source_key TEXT, folo_source_key TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY(post_id,query_id)
      );
    `)
  }

  create(value: XSavedQueryInput, now = new Date().toISOString()): XSavedQuery {
    const owner = this.owner()
    if (!owner) throw new XQueryError("owner_required")
    const base = queryInputSchema.parse(value)
    const id = randomUUID()
    const query: XSavedQuery = {
      ...base,
      id,
      sourceKey: sourceKey(id),
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare("INSERT INTO x_saved_queries VALUES(?,?,?,?,?,?)")
      .run(id, owner, JSON.stringify(query), Number(query.enabled), now, now)
    this.writeState({
      queryId: id,
      nextToken: null,
      scanSinceId: null,
      candidateHighWaterId: null,
      highWaterId: null,
      pending: false,
      status: "idle",
      failure: null,
      retryAt: null,
      updatedAt: now,
    })
    return query
  }

  update(id: string, value: XSavedQueryInput, now = new Date().toISOString()): XSavedQuery {
    const current = this.require(id)
    const next = {
      ...queryInputSchema.parse(value),
      id,
      sourceKey: current.sourceKey,
      createdAt: current.createdAt,
      updatedAt: now,
    }
    this.db
      .prepare("UPDATE x_saved_queries SET body=?,enabled=?,updated_at=? WHERE id=? AND owner_id=?")
      .run(JSON.stringify(next), Number(next.enabled), now, id, this.requireOwner())
    if (current.query !== next.query)
      this.writeState({
        queryId: id,
        nextToken: null,
        scanSinceId: null,
        candidateHighWaterId: null,
        highWaterId: null,
        pending: false,
        status: "idle",
        failure: null,
        retryAt: null,
        updatedAt: now,
      })
    return next
  }

  delete(id: string) {
    this.require(id)
    this.db
      .prepare("DELETE FROM x_saved_queries WHERE id=? AND owner_id=?")
      .run(id, this.requireOwner())
    this.db.prepare("DELETE FROM x_query_states WHERE query_id=?").run(id)
    this.db.prepare("DELETE FROM x_post_bindings WHERE query_id=?").run(id)
  }

  list(): XSavedQuery[] {
    return this.db
      .prepare("SELECT body FROM x_saved_queries WHERE owner_id=? ORDER BY created_at,id")
      .all(this.requireOwner())
      .map((row) => JSON.parse(String(row.body)) as XSavedQuery)
  }
  get(id: string): XSavedQuery | null {
    const row = this.db
      .prepare("SELECT body FROM x_saved_queries WHERE id=? AND owner_id=?")
      .get(id, this.requireOwner())
    return row ? (JSON.parse(String(row.body)) as XSavedQuery) : null
  }
  sources(): XVirtualSource[] {
    return this.list().map((query) => ({
      key: query.sourceKey,
      kind: "x_search",
      id: query.id,
      title: query.title,
      view: query.view,
      category: query.category,
    }))
  }
  state(queryId: string): XQueryState {
    this.require(queryId)
    return this.stateRow(queryId)
  }

  begin(queryId: string, now = new Date().toISOString()): XQueryState {
    this.require(queryId)
    const previous = this.stateRow(queryId)
    if (previous.pending) return previous
    const next = {
      ...previous,
      nextToken: null,
      scanSinceId: previous.highWaterId,
      candidateHighWaterId: null,
      pending: true,
      status: "pending" as const,
      failure: null,
      retryAt: null,
      updatedAt: now,
    }
    this.writeState(next)
    return next
  }

  savePage(input: {
    queryId: string
    nextToken: string | null
    newestId: string | null
    now: string
    budget?: boolean
  }) {
    const current = this.stateRow(input.queryId)
    if (!current.pending) throw new XQueryError("state_conflict")
    const candidate = current.candidateHighWaterId ?? input.newestId
    const complete = input.nextToken === null && !input.budget
    this.writeState({
      ...current,
      nextToken: input.nextToken,
      candidateHighWaterId: candidate,
      highWaterId: complete ? candidate : current.highWaterId,
      pending: !complete,
      status: complete ? "complete" : input.budget ? "budget" : "pending",
      failure: null,
      retryAt: null,
      updatedAt: input.now,
    })
  }

  fail(
    queryId: string,
    status: Extract<
      XQueryStatus,
      "unconfigured" | "rate_limited" | "forbidden" | "insufficient_access" | "billing" | "failed"
    >,
    now: string,
    retryAt: string | null = null,
  ) {
    const current = this.stateRow(queryId)
    this.writeState({
      ...current,
      pending: status === "rate_limited",
      status,
      failure: status,
      retryAt,
      updatedAt: now,
    })
  }

  // true 表示该帖子第一次进入 Folo 输入队列；Folo 已订阅的原帖只保存关联，不复制内容。
  bindPost(postId: string, queryId: string, now: string, foloSourceKey: string | null): boolean {
    if (!/^\d{1,30}$/u.test(postId)) throw new XQueryError("invalid_query")
    this.require(queryId)
    const known = this.db
      .prepare(
        "SELECT canonical_source_key,folo_source_key FROM x_post_bindings b JOIN x_saved_queries q ON q.id=b.query_id WHERE post_id=? AND q.owner_id=? LIMIT 1",
      )
      .get(postId, this.requireOwner()) as Record<string, unknown> | undefined
    const save = !known && !foloSourceKey
    this.db
      .prepare("INSERT OR IGNORE INTO x_post_bindings VALUES(?,?,?,?,?)")
      .run(
        postId,
        queryId,
        save ? this.require(queryId).sourceKey : nullable(known?.canonical_source_key),
        foloSourceKey ?? nullable(known?.folo_source_key),
        now,
      )
    return save
  }

  // 供 worker 从一份 canonical 正文展开所有保存查询上下文，不能只保留首次命中的 query。
  postContexts(
    postId: string,
  ): Array<{ queryId: string; sourceKey: string; view: number; category: string | null }> {
    return this.db
      .prepare(
        `SELECT bindings.query_id,queries.body FROM x_post_bindings bindings JOIN x_saved_queries queries ON queries.id=bindings.query_id WHERE bindings.post_id=? AND queries.owner_id=? ORDER BY bindings.query_id`,
      )
      .all(postId, this.requireOwner())
      .map((row) => {
        const query = JSON.parse(String((row as Record<string, unknown>).body)) as XSavedQuery
        return {
          queryId: query.id,
          sourceKey: query.sourceKey,
          view: query.view,
          category: query.category,
        }
      })
  }

  // 外部 entry 写入成功后才登记绑定，失败后下一轮仍可安全重试。
  savePost(
    postId: string,
    queryId: string,
    now: string,
    foloSourceKey: string | null,
    save: () => void,
  ): boolean {
    this.db.exec("SAVEPOINT x_post")
    try {
      const shouldSave = this.bindPost(postId, queryId, now, foloSourceKey)
      if (shouldSave) save()
      this.db.exec("RELEASE x_post")
      return shouldSave
    } catch (error) {
      this.db.exec("ROLLBACK TO x_post; RELEASE x_post")
      throw error
    }
  }

  private requireOwner(): string {
    const owner = this.owner()
    if (!owner) throw new XQueryError("owner_required")
    return owner
  }
  private require(id: string): XSavedQuery {
    const value = this.get(id)
    if (!value) throw new XQueryError("not_found")
    return value
  }
  private stateRow(queryId: string): XQueryState {
    const row = this.db.prepare("SELECT * FROM x_query_states WHERE query_id=?").get(queryId) as
      Record<string, unknown> | undefined
    if (!row) throw new XQueryError("not_found")
    return {
      queryId,
      nextToken: nullable(row.next_token),
      scanSinceId: nullable(row.scan_since_id),
      candidateHighWaterId: nullable(row.candidate_high_water_id),
      highWaterId: nullable(row.high_water_id),
      pending: Boolean(row.pending),
      status: String(row.status) as XQueryStatus,
      failure: nullable(row.failure),
      retryAt: nullable(row.retry_at),
      updatedAt: String(row.updated_at),
    }
  }
  private writeState(value: XQueryState) {
    this.db
      .prepare("INSERT OR REPLACE INTO x_query_states VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        value.queryId,
        value.nextToken,
        value.scanSinceId,
        value.candidateHighWaterId,
        value.highWaterId,
        Number(value.pending),
        value.status,
        value.failure,
        value.retryAt,
        value.updatedAt,
      )
  }
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}
function sourceKey(id: string) {
  return `x/search/${id}`
}
