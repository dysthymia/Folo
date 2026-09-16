import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import { z } from "zod"

import { AutomationError } from "./automation-store"

export const researchRequestSchema = z
  .object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("story"), storyId: z.uuid() }).strict(),
      z.object({ kind: z.literal("entry"), inputSeq: z.number().int().positive() }).strict(),
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
  status: "prepared" | "submitted" | "completed"
  title: string
  markdown: string
  createdAt: string
  updatedAt: string
  submissionReference: string | null
  resultReference: string | null
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

  private owner() {
    const owner = this.ownerId()
    if (!owner) throw new AutomationError("owner_required")
    return owner
  }
}
