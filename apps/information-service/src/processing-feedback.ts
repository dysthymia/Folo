import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

export const feedbackKinds = [
  "should_keep",
  "wrong_merge",
  "should_merge",
  "missing_point",
  "unsupported_citation",
  "rule_exception",
  "value",
  "known",
  "irrelevant",
] as const
export type FeedbackKind = (typeof feedbackKinds)[number]

export type EntryFeedbackTarget = {
  kind: "entry"
  inputSeq: number
  sourceKey: string
  itemId: string
  contentVersion: string
  decisionId: string | null
  releaseVersion: number | null
}
export type StoryFeedbackTarget = {
  kind: "story"
  storyId: string
  storyRevision: number
  decisionIds: string[]
  releaseVersions: number[]
}
export type FeedbackTarget = EntryFeedbackTarget | StoryFeedbackTarget
export type FeedbackSuggestion = {
  status: "proposed"
  // 保留用户原文，供规则编辑器明确展示和人工决定是否采用。
  userText: string
  prompt: string
}
export type ProcessingFeedback = {
  id: string
  kind: FeedbackKind
  target: FeedbackTarget
  explanation: string | null
  referenceIds: string[]
  suggestion: FeedbackSuggestion | null
  createdAt: string
}

export type NewFeedback = Omit<ProcessingFeedback, "id" | "createdAt" | "suggestion"> & {
  suggestion: FeedbackSuggestion | null
}

// 反馈是审阅记录，不触发规则发布、标签修改或处理结果重算。
export class ProcessingFeedbackStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: () => string | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processing_feedback (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_body TEXT NOT NULL,
        explanation TEXT,
        reference_ids TEXT NOT NULL,
        suggestion_body TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS processing_feedback_owner_created
        ON processing_feedback(owner_id, created_at DESC);
    `)
  }

  record(feedback: NewFeedback): ProcessingFeedback {
    const owner = this.requireOwner()
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO processing_feedback(
          id, owner_id, kind, target_kind, target_body, explanation,
          reference_ids, suggestion_body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        owner,
        feedback.kind,
        feedback.target.kind,
        JSON.stringify(feedback.target),
        feedback.explanation,
        JSON.stringify(feedback.referenceIds),
        feedback.suggestion ? JSON.stringify(feedback.suggestion) : null,
        createdAt,
      )
    return this.get(id)!
  }

  get(id: string): ProcessingFeedback | null {
    const row = this.db
      .prepare("SELECT * FROM processing_feedback WHERE id=? AND owner_id=?")
      .get(id, this.requireOwner())
    return row ? this.row(row as Record<string, unknown>) : null
  }

  list(): ProcessingFeedback[] {
    return this.db
      .prepare("SELECT * FROM processing_feedback WHERE owner_id=? ORDER BY created_at DESC")
      .all(this.requireOwner())
      .map((row) => this.row(row as Record<string, unknown>))
  }

  private requireOwner(): string {
    const owner = this.owner()
    if (!owner) throw new ProcessingFeedbackError("owner_required")
    return owner
  }

  private row(row: Record<string, unknown>): ProcessingFeedback {
    const target = JSON.parse(String(row.target_body)) as FeedbackTarget
    return {
      id: String(row.id),
      kind: String(row.kind) as FeedbackKind,
      target,
      explanation: row.explanation === null ? null : String(row.explanation),
      referenceIds: JSON.parse(String(row.reference_ids)) as string[],
      suggestion:
        row.suggestion_body === null
          ? null
          : (JSON.parse(String(row.suggestion_body)) as FeedbackSuggestion),
      createdAt: String(row.created_at),
    }
  }
}

export class ProcessingFeedbackError extends Error {
  constructor(
    public readonly code:
      "owner_required" | "invalid_target" | "stale_target" | "invalid_reference",
  ) {
    super(code)
  }
}
