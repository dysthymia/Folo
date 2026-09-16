import type { DatabaseSync } from "node:sqlite"

import type { RuleInput } from "@follow/information-core"

import type { AutomationStore, ProcessingInput } from "./automation-store"
import { AutomationError } from "./automation-store"
import type { ProcessingDecision, PublishedDecision } from "./processing-decision"

export type TargetSnapshot = {
  context: RuleInput
  provider: "codex" | "qianwen"
  model: string
  sourceRole: string
  metadataVersion: number
}
export class ProcessingStateStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly automation: AutomationStore,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processing_target_snapshots(input_seq INTEGER NOT NULL,generation INTEGER NOT NULL,body TEXT NOT NULL,error TEXT,PRIMARY KEY(input_seq,generation));
      CREATE TABLE IF NOT EXISTS processing_model_cache(fingerprint TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_entry_overrides(input_seq INTEGER PRIMARY KEY,mode TEXT NOT NULL,revision INTEGER NOT NULL,previous_mode TEXT);
      CREATE TABLE IF NOT EXISTS processing_source_item_overrides(source_key TEXT NOT NULL,item_id TEXT NOT NULL,mode TEXT NOT NULL,revision INTEGER NOT NULL,previous_mode TEXT,PRIMARY KEY(source_key,item_id));
      CREATE TABLE IF NOT EXISTS processing_trigger_reports(trigger_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_material_state(source_key TEXT NOT NULL,item_id TEXT NOT NULL,content_version TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(source_key,item_id));
    `)
  }

  prepare(seq: number, snapshot: TargetSnapshot) {
    const input = this.automation.assign(seq)
    this.db
      .prepare(
        "INSERT OR IGNORE INTO processing_target_snapshots(input_seq,generation,body) VALUES(?,?,?)",
      )
      .run(input.seq, input.generation, JSON.stringify(snapshot))
    const row = this.db
      .prepare("SELECT body FROM processing_target_snapshots WHERE input_seq=? AND generation=?")
      .get(input.seq, input.generation)!
    // 已启动目标保留配置快照，后续模型设置变化不影响同一目标重试。
    return { input, snapshot: JSON.parse(String(row.body)) as TargetSnapshot }
  }

  start(input: ProcessingInput) {
    return (
      this.db
        .prepare(
          "UPDATE processing_inputs SET status='running' WHERE seq=? AND current=1 AND generation=? AND release_version=? AND status='pending'",
        )
        .run(input.seq, input.generation, input.releaseVersion).changes === 1
    )
  }

  fail(input: ProcessingInput, error: string) {
    this.db
      .prepare("UPDATE processing_target_snapshots SET error=? WHERE input_seq=? AND generation=?")
      .run(error, input.seq, input.generation)
    this.db
      .prepare(
        "UPDATE processing_inputs SET status='failed' WHERE seq=? AND current=1 AND generation=?",
      )
      .run(input.seq, input.generation)
  }

  recover() {
    // 中断的模型调用结果未知，标为失败，避免重启时无提示重复付费。
    this.db.exec("UPDATE processing_inputs SET status='failed' WHERE status='running'")
  }

  retry(seq: number) {
    return (
      this.db
        .prepare(
          "UPDATE processing_inputs SET status='pending' WHERE seq=? AND current=1 AND status='failed'",
        )
        .run(seq).changes === 1
    )
  }

  cache(fingerprint: string): ProcessingDecision | null {
    const row = this.db
      .prepare("SELECT body FROM processing_model_cache WHERE fingerprint=?")
      .get(fingerprint)
    return row ? (JSON.parse(String(row.body)) as ProcessingDecision) : null
  }

  saveCache(decision: ProcessingDecision) {
    this.db
      .prepare("INSERT OR IGNORE INTO processing_model_cache VALUES(?,?,?)")
      .run(decision.fingerprint, JSON.stringify(decision), decision.generatedAt)
  }

  published(): PublishedDecision[] {
    const result: PublishedDecision[] = []
    for (const input of this.automation.inputs()) {
      const row = this.db
        .prepare(
          "SELECT decisions.id,decisions.body FROM entry_decisions decisions JOIN processing_inputs inputs ON inputs.decision_id=decisions.id WHERE inputs.seq=? AND inputs.status='succeeded' AND decisions.generation=inputs.generation AND decisions.release_version=inputs.release_version",
        )
        .get(input.seq)
      if (row) {
        const decision = JSON.parse(String(row.body)) as ProcessingDecision
        if (decision.schemaVersion === 1)
          result.push({ input, decisionId: String(row.id), decision })
      }
    }
    return result
  }

  report(triggerId: string, body: object) {
    this.db
      .prepare(
        "INSERT INTO processing_trigger_reports VALUES(?,?) ON CONFLICT(trigger_id) DO UPDATE SET body=excluded.body",
      )
      .run(triggerId, JSON.stringify(body))
  }

  reports() {
    return this.db
      .prepare("SELECT trigger_id,body FROM processing_trigger_reports")
      .all()
      .map((row) => ({
        triggerId: String(row.trigger_id),
        report: JSON.parse(String(row.body)) as unknown,
      }))
  }

  material(input: ProcessingInput) {
    const row = this.db
      .prepare(
        "SELECT status FROM processing_material_state WHERE source_key=? AND item_id=? AND content_version=?",
      )
      .get(input.sourceKey, input.itemId, input.contentVersion)
    return row ? String(row.status) : null
  }

  setMaterial(input: ProcessingInput, status: "complete" | "missing" | "failed") {
    this.db
      .prepare(
        "INSERT INTO processing_material_state VALUES(?,?,?,?) ON CONFLICT(source_key,item_id) DO UPDATE SET content_version=excluded.content_version,status=excluded.status",
      )
      .run(input.sourceKey, input.itemId, input.contentVersion, status)
  }

  overrides() {
    // 用户纠偏绑定来源与原文身份，正文版本变化后仍有效。
    return this.automation.inputs().map((input) => {
      const row = this.db
        .prepare(
          "SELECT mode,revision FROM processing_source_item_overrides WHERE source_key=? AND item_id=?",
        )
        .get(input.sourceKey, input.itemId)
      return {
        inputSeq: input.seq,
        mode: String(row?.mode ?? "automatic") as "restore" | "hide" | "automatic",
        revision: Number(row?.revision ?? 0),
      }
    })
  }

  setOverride(seq: number, mode: "restore" | "hide" | "automatic", expectedRevision: number) {
    const input = this.automation.inputs().find((entry) => entry.seq === seq)
    if (!input) throw new AutomationError("invalid_target")
    const old = this.db
      .prepare(
        "SELECT mode,revision FROM processing_source_item_overrides WHERE source_key=? AND item_id=?",
      )
      .get(input.sourceKey, input.itemId)
    if (Number(old?.revision ?? 0) !== expectedRevision)
      throw new AutomationError("revision_conflict")
    this.db
      .prepare(
        "INSERT INTO processing_source_item_overrides VALUES(?,?,?,?,?) ON CONFLICT(source_key,item_id) DO UPDATE SET mode=excluded.mode,revision=excluded.revision,previous_mode=excluded.previous_mode",
      )
      .run(
        input.sourceKey,
        input.itemId,
        mode,
        expectedRevision + 1,
        String(old?.mode ?? "automatic"),
      )
    return { inputSeq: seq, mode, revision: expectedRevision + 1 }
  }

  undoOverride(seq: number, expectedRevision: number) {
    const input = this.automation.inputs().find((entry) => entry.seq === seq)
    if (!input) throw new AutomationError("invalid_target")
    const row = this.db
      .prepare(
        "SELECT previous_mode FROM processing_source_item_overrides WHERE source_key=? AND item_id=?",
      )
      .get(input.sourceKey, input.itemId)
    if (!row) throw new AutomationError("invalid_target")
    return this.setOverride(
      seq,
      String(row.previous_mode) as "restore" | "hide" | "automatic",
      expectedRevision,
    )
  }
}
