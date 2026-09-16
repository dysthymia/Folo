import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

export type ExportStatus =
  "prepared" | "sending" | "succeeded" | "failed" | "unknown" | "retry_after"
export type ExportOperation = "create" | "append"
export type ExportTargetMode = "parent" | "page"

type ExportBase = {
  id: string
  revision: number
  destinationId: string
  markdown: string
  contentHash: string
  operation: ExportOperation
  targetMode: ExportTargetMode
  status: ExportStatus
  notionPageId: string | null
  retryAfter: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export type ExportRecord = ExportBase & { kind: "story"; storyId: string }
export type EntryExportRecord = ExportBase & {
  kind: "entry"
  entry: {
    inputSeq: number
    sourceKey: string
    itemId: string
    contentVersion: string
    title: string
  }
}
export type ExportableRecord = ExportRecord | EntryExportRecord
export type EntryExportInput = EntryExportRecord["entry"]

type ExportPatch = {
  notionPageId?: string | null
  retryAfter?: string | null
  error?: string | null
}
type TopicRow = { page_id: string; current_revision: number }

// 导出队列与账号绑定；正文只保存在本机业务库，永不写进外接配置文件。
export class ExportStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: () => string | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_exports (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, story_id TEXT NOT NULL, revision INTEGER NOT NULL,
        destination_id TEXT NOT NULL, markdown TEXT NOT NULL, content_hash TEXT NOT NULL,
        operation TEXT NOT NULL DEFAULT 'create', target_mode TEXT NOT NULL DEFAULT 'parent', status TEXT NOT NULL, notion_page_id TEXT,
        retry_after TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(owner_id, story_id, revision, destination_id, content_hash)
      );
      CREATE TABLE IF NOT EXISTS external_export_topics (
        owner_id TEXT NOT NULL, story_id TEXT NOT NULL, destination_id TEXT NOT NULL,
        page_id TEXT NOT NULL, current_export_id TEXT NOT NULL, current_revision INTEGER NOT NULL,
        current_content_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, story_id, destination_id)
      );
      CREATE TABLE IF NOT EXISTS external_entry_exports (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, input_seq INTEGER NOT NULL,
        source_key TEXT NOT NULL, item_id TEXT NOT NULL, content_version TEXT NOT NULL, title TEXT NOT NULL,
        revision INTEGER NOT NULL, destination_id TEXT NOT NULL, markdown TEXT NOT NULL, content_hash TEXT NOT NULL,
        operation TEXT NOT NULL, target_mode TEXT NOT NULL DEFAULT 'parent', status TEXT NOT NULL,
        notion_page_id TEXT, retry_after TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(owner_id, source_key, item_id, content_version, revision, destination_id, content_hash)
      );
      CREATE TABLE IF NOT EXISTS external_entry_export_topics_v2 (
        owner_id TEXT NOT NULL, source_key TEXT NOT NULL, item_id TEXT NOT NULL, destination_id TEXT NOT NULL,
        page_id TEXT NOT NULL, current_export_id TEXT NOT NULL, current_revision INTEGER NOT NULL,
        current_content_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, source_key, item_id, destination_id)
      );
    `)
    this.ensureColumns()
    this.ensureStoryTopicMappings()
    this.ensureEntryTopicMappings()
  }

  prepare(
    storyId: string,
    revision: number,
    destinationId: string,
    markdown: string,
    targetMode: ExportTargetMode = "parent",
  ): ExportRecord {
    const owner = this.requireOwner()
    const contentHash = hash(markdown)
    const existing = this.db
      .prepare(
        `SELECT * FROM external_exports
         WHERE owner_id=? AND story_id=? AND revision=? AND destination_id=? AND content_hash=?`,
      )
      .get(owner, storyId, revision, destinationId, contentHash)
    if (existing) return this.storyRow(existing as Record<string, unknown>)

    const topic = this.storyTopic(owner, storyId, destinationId)
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO external_exports(
          id, owner_id, story_id, revision, destination_id, markdown, content_hash, operation, target_mode,
          status, notion_page_id, retry_after, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        owner,
        storyId,
        revision,
        destinationId,
        markdown,
        contentHash,
        topic || targetMode === "page" ? "append" : "create",
        targetMode,
        "prepared",
        topic?.page_id ?? (targetMode === "page" ? destinationId : null),
        null,
        null,
        now,
        now,
      )
    return this.get(id) as ExportRecord
  }

  prepareEntry(
    input: EntryExportInput,
    destinationId: string,
    markdown: string,
    targetMode: ExportTargetMode = "parent",
  ): EntryExportRecord {
    const owner = this.requireOwner()
    const contentHash = hash(markdown)
    const existing = this.db
      .prepare(
        `SELECT * FROM external_entry_exports
         WHERE owner_id=? AND source_key=? AND item_id=? AND content_version=?
           AND destination_id=? AND content_hash=?`,
      )
      .get(owner, input.sourceKey, input.itemId, input.contentVersion, destinationId, contentHash)
    if (existing) return this.entryRow(existing as Record<string, unknown>)

    const topic = this.entryTopic(owner, input, destinationId)
    const prior = this.db
      .prepare(
        `SELECT MAX(revision) AS revision FROM external_entry_exports
         WHERE owner_id=? AND source_key=? AND item_id=? AND destination_id=?`,
      )
      .get(owner, input.sourceKey, input.itemId, destinationId) as {
      revision: number | null
    }
    const now = new Date().toISOString()
    const id = randomUUID()
    const revision = (prior.revision ?? 0) + 1
    this.db
      .prepare(
        `INSERT INTO external_entry_exports(
          id, owner_id, input_seq, source_key, item_id, content_version, title, revision,
          destination_id, markdown, content_hash, operation, target_mode, status, notion_page_id,
          retry_after, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        owner,
        input.inputSeq,
        input.sourceKey,
        input.itemId,
        input.contentVersion,
        input.title,
        revision,
        destinationId,
        markdown,
        contentHash,
        topic || targetMode === "page" ? "append" : "create",
        targetMode,
        "prepared",
        topic?.page_id ?? (targetMode === "page" ? destinationId : null),
        null,
        null,
        now,
        now,
      )
    return this.get(id) as EntryExportRecord
  }

  get(id: string): ExportableRecord | null {
    const owner = this.requireOwner()
    const story = this.db
      .prepare("SELECT * FROM external_exports WHERE id=? AND owner_id=?")
      .get(id, owner)
    if (story) return this.storyRow(story as Record<string, unknown>)
    const entry = this.db
      .prepare("SELECT * FROM external_entry_exports WHERE id=? AND owner_id=?")
      .get(id, owner)
    return entry ? this.entryRow(entry as Record<string, unknown>) : null
  }

  list(): ExportableRecord[] {
    const owner = this.requireOwner()
    const stories = this.db
      .prepare("SELECT * FROM external_exports WHERE owner_id=?")
      .all(owner)
      .map((row) => this.storyRow(row as Record<string, unknown>))
    const entries = this.db
      .prepare("SELECT * FROM external_entry_exports WHERE owner_id=?")
      .all(owner)
      .map((row) => this.entryRow(row as Record<string, unknown>))
    return [...stories, ...entries].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )
  }

  update(id: string, status: ExportStatus, patch: ExportPatch = {}): ExportableRecord {
    const current = this.get(id)
    if (!current) throw new ExportStoreError("export_not_found")
    const now = new Date().toISOString()
    const table = current.kind === "story" ? "external_exports" : "external_entry_exports"
    this.db
      .prepare(
        `UPDATE ${table}
         SET status=?, notion_page_id=?, retry_after=?, error=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        status,
        patch.notionPageId ?? current.notionPageId,
        patch.retryAfter ?? null,
        patch.error ?? null,
        now,
        id,
      )
    return this.get(id)!
  }

  // 只有完整写入的版本才能推进稳定目标映射，未知或失败版本绝不污染后续准备。
  markSucceeded(id: string, notionPageId: string): ExportableRecord {
    const record = this.get(id)
    if (!record) throw new ExportStoreError("export_not_found")
    const owner = this.requireOwner()
    const now = new Date().toISOString()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const table = record.kind === "story" ? "external_exports" : "external_entry_exports"
      this.db
        .prepare(
          `UPDATE ${table}
           SET status='succeeded', notion_page_id=?, retry_after=NULL, error=NULL, updated_at=?
           WHERE id=?`,
        )
        .run(notionPageId, now, id)
      if (record.kind === "story") this.upsertStoryTopic(owner, record, notionPageId, now)
      else this.upsertEntryTopic(owner, record, notionPageId, now)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return this.get(id)!
  }

  private upsertStoryTopic(owner: string, record: ExportRecord, pageId: string, now: string): void {
    this.db
      .prepare(topicUpsert("external_export_topics", "owner_id, story_id, destination_id"))
      .run(
        owner,
        record.storyId,
        record.destinationId,
        pageId,
        record.id,
        record.revision,
        record.contentHash,
        now,
      )
  }

  private upsertEntryTopic(
    owner: string,
    record: EntryExportRecord,
    pageId: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO external_entry_export_topics_v2(
          owner_id, source_key, item_id, destination_id, page_id,
          current_export_id, current_revision, current_content_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, source_key, item_id, destination_id) DO UPDATE SET
          page_id=excluded.page_id, current_export_id=excluded.current_export_id,
          current_revision=excluded.current_revision, current_content_hash=excluded.current_content_hash,
          updated_at=excluded.updated_at
        WHERE excluded.current_revision >= external_entry_export_topics_v2.current_revision`,
      )
      .run(
        owner,
        record.entry.sourceKey,
        record.entry.itemId,
        record.destinationId,
        pageId,
        record.id,
        record.revision,
        record.contentHash,
        now,
      )
  }

  private storyTopic(owner: string, storyId: string, destinationId: string): TopicRow | null {
    return this.topic("external_export_topics", [owner, storyId, destinationId])
  }

  private entryTopic(
    owner: string,
    input: EntryExportInput,
    destinationId: string,
  ): TopicRow | null {
    return this.topic("external_entry_export_topics_v2", [
      owner,
      input.sourceKey,
      input.itemId,
      destinationId,
    ])
  }

  private topic(table: string, parameters: string[]): TopicRow | null {
    const columns =
      table === "external_export_topics"
        ? "owner_id=? AND story_id=? AND destination_id=?"
        : "owner_id=? AND source_key=? AND item_id=? AND destination_id=?"
    const row = this.db
      .prepare(`SELECT page_id, current_revision FROM ${table} WHERE ${columns}`)
      .get(...parameters)
    return row ? (row as TopicRow) : null
  }

  private ensureColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(external_exports)").all() as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === "operation"))
      this.db.exec(
        "ALTER TABLE external_exports ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'",
      )
    if (!columns.some((column) => column.name === "target_mode"))
      this.db.exec(
        "ALTER TABLE external_exports ADD COLUMN target_mode TEXT NOT NULL DEFAULT 'parent'",
      )
    const entryColumns = this.db
      .prepare("PRAGMA table_info(external_entry_exports)")
      .all() as Array<{
      name: string
    }>
    if (!entryColumns.some((column) => column.name === "target_mode"))
      this.db.exec(
        "ALTER TABLE external_entry_exports ADD COLUMN target_mode TEXT NOT NULL DEFAULT 'parent'",
      )
  }

  private ensureStoryTopicMappings(): void {
    const completed = this.db
      .prepare(
        `SELECT owner_id, story_id, destination_id, notion_page_id, id, revision, content_hash, updated_at
         FROM external_exports WHERE status='succeeded' AND notion_page_id IS NOT NULL
         ORDER BY revision ASC, updated_at ASC`,
      )
      .all() as Array<Record<string, unknown>>
    for (const row of completed) {
      this.upsertStoryTopic(
        String(row.owner_id),
        this.storyRow(row),
        String(row.notion_page_id),
        String(row.updated_at),
      )
    }
  }

  private ensureEntryTopicMappings(): void {
    const completed = this.db
      .prepare(
        `SELECT * FROM external_entry_exports
         WHERE status='succeeded' AND notion_page_id IS NOT NULL
         ORDER BY revision ASC, updated_at ASC`,
      )
      .all() as Array<Record<string, unknown>>
    for (const row of completed) {
      this.upsertEntryTopic(
        String(row.owner_id),
        this.entryRow(row),
        String(row.notion_page_id),
        String(row.updated_at),
      )
    }
  }

  private requireOwner(): string {
    const owner = this.owner()
    if (!owner) throw new ExportStoreError("owner_required")
    return owner
  }

  private storyRow(row: Record<string, unknown>): ExportRecord {
    return { ...this.baseRow(row), kind: "story", storyId: String(row.story_id) }
  }

  private entryRow(row: Record<string, unknown>): EntryExportRecord {
    return {
      ...this.baseRow(row),
      kind: "entry",
      entry: {
        inputSeq: Number(row.input_seq),
        sourceKey: String(row.source_key),
        itemId: String(row.item_id),
        contentVersion: String(row.content_version),
        title: String(row.title),
      },
    }
  }

  private baseRow(row: Record<string, unknown>): ExportBase {
    return {
      id: String(row.id),
      revision: Number(row.revision),
      destinationId: String(row.destination_id),
      markdown: String(row.markdown),
      contentHash: String(row.content_hash),
      operation: row.operation === "append" ? "append" : "create",
      targetMode: row.target_mode === "page" ? "page" : "parent",
      status: String(row.status) as ExportStatus,
      notionPageId: row.notion_page_id === null ? null : String(row.notion_page_id),
      retryAfter: row.retry_after === null ? null : String(row.retry_after),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}

function hash(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex")
}

function topicUpsert(table: "external_export_topics", keyColumns: string): string {
  return `INSERT INTO ${table}(
    owner_id, story_id, destination_id, page_id, current_export_id,
    current_revision, current_content_hash, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(${keyColumns}) DO UPDATE SET
    page_id=excluded.page_id, current_export_id=excluded.current_export_id,
    current_revision=excluded.current_revision, current_content_hash=excluded.current_content_hash,
    updated_at=excluded.updated_at
  WHERE excluded.current_revision >= ${table}.current_revision`
}

export class ExportStoreError extends Error {
  constructor(public readonly code: "owner_required" | "export_not_found") {
    super(code)
  }
}
