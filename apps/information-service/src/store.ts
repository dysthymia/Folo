import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import type { ConditionSet, RuleSet } from "@follow/information-core"
import { dirname } from "pathe"

import { AutomationStore } from "./automation-store"
import { ExportStore } from "./export-store"
import type { Source, SourceEntry } from "./folo"
import { ProcessingFeedbackStore } from "./processing-feedback"
import { ProcessingReadingStore } from "./processing-reading-store"
import { ProcessingScheduleStore } from "./processing-schedule"
import { SourceSyncStore } from "./processing-source-sync"
import { ProcessingStateStore } from "./processing-state"
import { ResearchStore } from "./research-store"
import { StoryStore } from "./story-store"
import { SubscriptionTagStore } from "./subscription-tags"
import { XQueryStore } from "./x-query-store"

export type Summary = { summary: string; points: string[]; entryId: string }
export type Job = {
  id: string
  kind: "scan" | "process"
  status: "queued" | "running" | "succeeded" | "failed"
  sourceKey: string
  itemId: string | null
  model: string | null
  provider?: "codex" | "qianwen"
  error: string | null
  createdAt: string
  updatedAt: string
  cursor: string | null
  pages: number
  limit: number
  pageBudget: number
  coverage: "pending" | "budget" | "end" | "timestamp_boundary"
}
export type Result = {
  id: string
  itemId: string
  sourceKey: string
  title: string
  model: string
  material: "source_text" | "description_only"
  createdAt: string
  payload: Summary
  durationMs: number
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null
}

function categoryReferences(conditionSet: ConditionSet): Array<{ view: number; name: string }> {
  if ("all" in conditionSet) return []
  return conditionSet.anyOf.flatMap((group) =>
    group.allOf.flatMap((condition) =>
      condition.field === "category_ref" ? [condition.value] : [],
    ),
  )
}

function ruleSetCategoryReferences(config: RuleSet) {
  return config.rules.flatMap((rule) => [
    ...categoryReferences(rule.when),
    ...rule.actions.flatMap((action) =>
      action.type === "ai_aggregate" ? categoryReferences(action.scope) : [],
    ),
  ])
}

// 数据库只保存白名单业务字段；Folo 凭据由独立受限文件按次读取，不放进业务快照。
export class Store {
  private readonly db: DatabaseSync
  readonly automation: AutomationStore
  readonly subscriptionTags: SubscriptionTagStore
  readonly processingState: ProcessingStateStore
  readonly feedback: ProcessingFeedbackStore
  readonly exports: ExportStore
  readonly research: ResearchStore
  readonly reading: ProcessingReadingStore
  readonly schedule: ProcessingScheduleStore
  readonly sourceSync: SourceSyncStore
  readonly stories: StoryStore
  readonly xQueries: XQueryStore

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path, { timeout: 5_000 })
    if (path !== ":memory:") chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, body TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (source_key TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(source_key,id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER NOT NULL);
    `)
    this.automation = new AutomationStore(
      this.db,
      () => this.ownerId,
      (config) => this.categoryReferencesValid(config),
    )
    this.subscriptionTags = new SubscriptionTagStore(this.db, () => this.ownerId)
    // 同一账号的队列、原文版本与派生 Story 共用事务数据库。
    this.processingState = new ProcessingStateStore(this.db, this.automation)
    this.feedback = new ProcessingFeedbackStore(this.db, () => this.ownerId)
    this.exports = new ExportStore(this.db, () => this.ownerId)
    this.research = new ResearchStore(this.db, () => this.ownerId)
    this.schedule = new ProcessingScheduleStore(this.db, () => this.ownerId)
    this.sourceSync = new SourceSyncStore(this.db, () =>
      this.ownerId ? this.xQueries.sources() : [],
    )
    this.stories = new StoryStore(this.db)
    this.xQueries = new XQueryStore(this.db, () => this.ownerId)
    this.reading = new ProcessingReadingStore(
      this.db,
      () => this.ownerId,
      this.automation,
      this.processingState,
      this.stories,
      () => this.schedule.snapshot().config,
    )
    // 首次增加版本层时迁入已有材料；新增表失败会保留旧库，不重建或清空数据。
    if (
      !this.db.prepare("SELECT 1 FROM metadata WHERE key='processing_inputs_initialized'").get()
    ) {
      this.transaction(() => {
        for (const row of this.db.prepare("SELECT body FROM entries ORDER BY rowid").all())
          this.automation.capture(JSON.parse(String(row.body)) as SourceEntry)
        this.db.prepare("INSERT INTO metadata VALUES('processing_inputs_initialized','1')").run()
      })
    }
  }

  transaction(operation: () => void) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      operation()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  get ownerId(): string | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='owner'").get()
    return typeof row?.value === "string" ? row.value : null
  }

  bindOwner(ownerId: string) {
    this.transaction(() => {
      if (this.ownerId && this.ownerId !== ownerId) throw new Error("account_changed")
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('owner', ?)").run(ownerId)
    })
  }

  replaceSources(sources: Source[], syncedAt?: string) {
    this.transaction(() => {
      this.db.exec("UPDATE sources SET active=0")
      const insert = this.db.prepare("INSERT OR REPLACE INTO sources VALUES (?, ?, 1)")
      for (const source of sources) insert.run(source.key, JSON.stringify(source))
      this.db
        .prepare("INSERT OR REPLACE INTO metadata VALUES ('source_inventory_known', '1')")
        .run()
      // 增量同步传入时间时，来源条件快照与主来源表必须同一事务提交。
      if (syncedAt) this.sourceSync.replaceSources(sources, syncedAt)
    })
  }

  sources(): Source[] {
    const foloSources = this.db
      .prepare("SELECT body FROM sources WHERE active=1 ORDER BY key")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Source)
    // 搜索来源来自保存查询，主站订阅同步不会误删这组私人绑定。
    return [...foloSources, ...(this.ownerId ? this.xQueries.sources() : [])]
  }

  sourceInventoryKnown(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM metadata WHERE key='source_inventory_known'").get(),
    )
  }

  private categoryReferencesValid(config: RuleSet): boolean {
    if (!this.sourceInventoryKnown()) return true
    const categories = new Set(
      this.sources().flatMap((source) =>
        source.category === null ? [] : [`${source.view}\u0000${source.category}`],
      ),
    )
    return ruleSetCategoryReferences(config).every(({ view, name }) =>
      categories.has(`${view}\u0000${name}`),
    )
  }

  entry(sourceKey: string, id: string): SourceEntry | null {
    const row = this.db
      .prepare("SELECT body FROM entries WHERE source_key=? AND id=?")
      .get(sourceKey, id)
    return row ? (JSON.parse(String(row.body)) as SourceEntry) : null
  }

  saveEntry(entry: SourceEntry) {
    this.db.exec("SAVEPOINT save_entry")
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO entries VALUES (?, ?, ?)")
        .run(entry.sourceKey, entry.id, JSON.stringify(entry))
      this.automation.capture(entry)
      this.db.exec("RELEASE save_entry")
    } catch (error) {
      this.db.exec("ROLLBACK TO save_entry; RELEASE save_entry")
      throw error
    }
  }

  saveListedEntry(entry: SourceEntry) {
    const previous = this.entry(entry.sourceKey, entry.id)
    const missingBody = Boolean(previous?.content && !entry.content)
    // 缺正文的列表只含预览媒体（数量也可能更少），必须与已保存正文保留同一份详情元数据。
    this.saveEntry(
      previous
        ? {
            ...entry,
            content: entry.content || previous.content,
            mediaLength: missingBody
              ? previous.mediaLength
              : (entry.mediaLength ?? previous.mediaLength),
            attachmentsDuration: missingBody
              ? previous.attachmentsDuration
              : (entry.attachmentsDuration ?? previous.attachmentsDuration),
          }
        : entry,
    )
  }

  saveJob(job: Job) {
    job.updatedAt = new Date().toISOString()
    this.db
      .prepare("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?)")
      .run(job.id, JSON.stringify(job), job.status)
  }

  job(id: string): Job | null {
    const row = this.db.prepare("SELECT body FROM jobs WHERE id=?").get(id)
    return row ? (JSON.parse(String(row.body)) as Job) : null
  }

  jobs(): Job[] {
    return this.db
      .prepare("SELECT body FROM jobs ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Job)
  }

  nextJob(): Job | null {
    const row = this.db
      .prepare("SELECT body FROM jobs WHERE status='queued' ORDER BY rowid LIMIT 1")
      .get()
    return row ? (JSON.parse(String(row.body)) as Job) : null
  }

  enqueue(input: {
    kind: Job["kind"]
    sourceKey: string
    itemId?: string
    model?: string
    provider?: Job["provider"]
    limit?: number
    pages?: number
  }): Job {
    const now = new Date().toISOString()
    const job: Job = {
      id: randomUUID(),
      kind: input.kind,
      status: "queued",
      sourceKey: input.sourceKey,
      itemId: input.itemId ?? null,
      model: input.model ?? null,
      provider: input.provider,
      error: null,
      createdAt: now,
      updatedAt: now,
      cursor: null,
      pages: 0,
      limit: input.limit ?? 5,
      pageBudget: input.pages ?? 3,
      coverage: "pending",
    }
    this.saveJob(job)
    return job
  }

  recover() {
    // 扫描可从事务水位重放；模型中断不能盲目重试，避免重复计费。
    const rows = this.db.prepare("SELECT body FROM jobs WHERE status='running'").all()
    for (const row of rows) {
      const job = JSON.parse(String(row.body)) as Job
      job.status = job.kind === "scan" ? "queued" : "failed"
      job.error = job.kind === "scan" ? null : "interrupted_model_outcome_unknown"
      this.saveJob(job)
    }
  }

  result(id: string): Result | null {
    const row = this.db.prepare("SELECT body FROM results WHERE id=?").get(id)
    return row ? (JSON.parse(String(row.body)) as Result) : null
  }

  saveResult(result: Result) {
    this.db
      .prepare("INSERT OR IGNORE INTO results VALUES (?, ?)")
      .run(result.id, JSON.stringify(result))
  }

  snapshot() {
    const items = this.db
      .prepare("SELECT body FROM entries ORDER BY rowid DESC LIMIT 200")
      .all()
      .map((row) => {
        const { id, sourceKey, title, url, publishedAt } = JSON.parse(
          String(row.body),
        ) as SourceEntry
        return { id, sourceKey, title, url, publishedAt }
      })
    return {
      ownerId: this.ownerId,
      sources: this.sources(),
      items,
      jobs: this.jobs(),
      results: this.db
        .prepare("SELECT body FROM results ORDER BY rowid DESC LIMIT 100")
        .all()
        .map((row) => JSON.parse(String(row.body)) as Result),
    }
  }

  issueAccess(kind: "connect" | "session"): string {
    const token = randomBytes(32).toString("base64url")
    const hash = createHash("sha256").update(token).digest("hex")
    this.db.prepare("DELETE FROM access_tokens WHERE expires < ?").run(Date.now())
    this.db
      .prepare("INSERT INTO access_tokens VALUES (?, ?, ?)")
      .run(hash, kind, Date.now() + (kind === "connect" ? 60_000 : 8 * 60 * 60_000))
    return token
  }

  checkAccess(token: string, kind: "connect" | "session"): boolean {
    const hash = createHash("sha256").update(token).digest("hex")
    // 连接票据只能消费一次；浏览器会话独立于上游 Folo 凭据。
    if (kind === "connect")
      return (
        this.db
          .prepare("DELETE FROM access_tokens WHERE hash=? AND kind=? AND expires>? RETURNING hash")
          .get(hash, kind, Date.now()) !== undefined
      )
    return (
      this.db
        .prepare("SELECT hash FROM access_tokens WHERE hash=? AND kind=? AND expires>?")
        .get(hash, kind, Date.now()) !== undefined
    )
  }

  close() {
    this.db.close()
  }
}
