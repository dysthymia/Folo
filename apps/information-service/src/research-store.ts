import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import { z } from "zod"

import { AutomationError } from "./automation-store"
import type { CodexUsage } from "./codex"

export const researchSelectionTargetSchema = z
  .object({
    kind: z.literal("selection"),
    entries: z
      .array(
        z
          .object({
            sourceKey: z.string().min(1).max(300),
            entryId: z.string().min(1).max(300),
            inputSeq: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()

export const researchRequestSchema = z
  .object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("story"), storyId: z.uuid() }).strict(),
      z.object({ kind: z.literal("entry"), inputSeq: z.number().int().positive() }).strict(),
      researchSelectionTargetSchema,
    ]),
    question: z.string().trim().min(1).max(4000),
    goal: z.string().trim().min(1).max(4000),
    knownQuestions: z.array(z.string().trim().min(1).max(2000)).max(30),
  })
  .strict()
export type ResearchRequest = z.infer<typeof researchRequestSchema>
export type ResearchRecord = ResearchRequest & {
  id: string
  revision: number
  status: "prepared" | "submitted" | "running" | "failed" | "completed"
  title: string
  markdown: string
  createdAt: string
  updatedAt: string
  submissionReference: string | null
  resultReference: string | null
  // 一次性模型研究字段保持可选，旧的手动准备/交接记录仍可直接读取。
  result?: ResearchResult | null
  metrics?: { modelCalls: number; durationMs: number; usage: CodexUsage | null }
  errorCode?: string | null
}

export type ResearchResult = {
  title: string
  sentences: Array<{
    id: string
    text: string
    citations: Array<{ materialId: string; quote: string }>
  }>
  limitations: string[]
}
export type SelectionMaterial = {
  sourceKey: string
  entryId: string
  materialId: string
  inputSeq?: number
  contentVersion?: string
  generation?: number
  materialState?: string | null
  remoteVersion?: string
  title: string
  text: string
  url: string | null
  // 冻结资料的时间边界；可选字段兼容此前保存的预览，不推断未知日期。
  publishedAt?: string | null
  receivedAt?: string
  missing: string[]
}
export type SelectionPreview = {
  selectionCount: number
  totalCharacters: number
  missingContext: Array<{ sourceKey: string; entryId: string; reasons: string[] }>
  estimatedModelCalls: number
  canExecute: boolean
  materials: Array<{
    sourceKey: string
    entryId: string
    materialId: string
    inputSeq?: number
    title: string
    characters: number
  }>
  selectionToken: string
}

// 文件准备和研究执行是不同事实；显式登记交接与结果，不因下载文件自动升级状态。
export class ResearchStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerId: () => string | null,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS research_records (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS research_selection_previews (token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request TEXT NOT NULL, materials TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_selection_runs (owner_id TEXT NOT NULL, execution_key TEXT NOT NULL, request_hash TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(owner_id,execution_key));`)
    // 进程中断后不自动重跑付费请求，明确保留未知结果供用户用新 key 显式重试。
    for (const record of this.ownerId() ? this.list() : []) {
      if (record.target.kind === "selection" && record.status === "running")
        this.finishSelection(record.id, { status: "failed", errorCode: "execution_interrupted" })
    }
  }

  list(): ResearchRecord[] {
    return this.db
      .prepare("SELECT body FROM research_records WHERE owner_id=? ORDER BY rowid DESC")
      .all(this.owner())
      .map((row) => JSON.parse(String(row.body)) as ResearchRecord)
  }

  get(id: string): ResearchRecord {
    const row = this.db
      .prepare("SELECT body FROM research_records WHERE id=? AND owner_id=?")
      .get(id, this.owner())
    if (!row) throw new AutomationError("invalid_target")
    return JSON.parse(String(row.body)) as ResearchRecord
  }

  prepare(request: ResearchRequest, title: string, markdown: string): ResearchRecord {
    const now = new Date().toISOString()
    const record: ResearchRecord = {
      ...request,
      id: randomUUID(),
      revision: 1,
      status: "prepared",
      title,
      markdown,
      createdAt: now,
      updatedAt: now,
      submissionReference: null,
      resultReference: null,
    }
    this.db
      .prepare("INSERT INTO research_records VALUES(?,?,?,?)")
      .run(record.id, this.owner(), 1, JSON.stringify(record))
    return record
  }

  transition(
    id: string,
    expectedRevision: number,
    status: "submitted" | "completed",
    reference: string,
  ): ResearchRecord {
    const record = this.get(id)
    if (record.target.kind === "selection") throw new AutomationError("invalid_target")
    if (record.revision !== expectedRevision) throw new AutomationError("revision_conflict")
    if (
      (status === "submitted" && record.status !== "prepared") ||
      (status === "completed" && record.status !== "submitted")
    )
      throw new AutomationError("invalid_target")
    const next: ResearchRecord = {
      ...record,
      status,
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
      ...(status === "submitted"
        ? { submissionReference: reference }
        : { resultReference: reference }),
    }
    const result = this.db
      .prepare(
        "UPDATE research_records SET revision=?,body=? WHERE id=? AND owner_id=? AND revision=?",
      )
      .run(next.revision, JSON.stringify(next), id, this.owner(), expectedRevision)
    if (!result.changes) throw new AutomationError("revision_conflict")
    return next
  }

  saveSelectionPreview(request: ResearchRequest, materials: SelectionMaterial[]): string {
    const token = randomUUID()
    this.db
      .prepare("INSERT INTO research_selection_previews VALUES(?,?,?,?)")
      .run(token, this.owner(), JSON.stringify(request), JSON.stringify(materials))
    return token
  }

  selectionPreview(token: string): { request: ResearchRequest; materials: SelectionMaterial[] } {
    const row = this.db
      .prepare(
        "SELECT request,materials FROM research_selection_previews WHERE token=? AND owner_id=?",
      )
      .get(token, this.owner())
    if (!row) throw new AutomationError("invalid_target")
    return {
      request: JSON.parse(String(row.request)) as ResearchRequest,
      materials: JSON.parse(String(row.materials)) as SelectionMaterial[],
    }
  }

  selectionRun(key: string, requestHash: string): ResearchRecord | null {
    const row = this.db
      .prepare(
        "SELECT record_id,request_hash FROM research_selection_runs WHERE owner_id=? AND execution_key=?",
      )
      .get(this.owner(), key)
    if (!row) return null
    if (row.request_hash !== requestHash) throw new AutomationError("revision_conflict")
    return this.get(String(row.record_id))
  }

  startSelection(request: ResearchRequest, key: string, requestHash: string): ResearchRecord {
    const record = this.prepare(request, "一次性综述研究", "研究执行中，尚无完成结果。")
    this.db
      .prepare("INSERT INTO research_selection_runs VALUES(?,?,?,?)")
      .run(this.owner(), key, requestHash, record.id)
    return this.finishSelection(record.id, {
      status: "running",
      result: null,
      errorCode: null,
      metrics: { modelCalls: 0, durationMs: 0, usage: null },
    })
  }

  finishSelection(
    id: string,
    update: Partial<
      Pick<ResearchRecord, "status" | "result" | "metrics" | "errorCode" | "markdown" | "title">
    >,
  ): ResearchRecord {
    const record = this.get(id)
    if (record.target.kind !== "selection") throw new AutomationError("invalid_target")
    const next = {
      ...record,
      ...update,
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    this.db
      .prepare(
        "UPDATE research_records SET revision=?,body=? WHERE id=? AND owner_id=? AND revision=?",
      )
      .run(next.revision, JSON.stringify(next), id, this.owner(), record.revision)
    return next
  }

  private owner() {
    const owner = this.ownerId()
    if (!owner) throw new AutomationError("owner_required")
    return owner
  }
}
