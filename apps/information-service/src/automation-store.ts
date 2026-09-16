import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { RuleSet } from "@follow/information-core"
import { ruleSetSchema } from "@follow/information-core"
import { z } from "zod"

import type { SourceEntry } from "./folo"

export class AutomationError extends Error {
  constructor(
    public readonly code:
      | "revision_conflict"
      | "owner_required"
      | "invalid_rule_set"
      | "invalid_target"
      | "invalid_reconciliation",
  ) {
    super(code)
  }
}
export const publicationScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("future") }).strict(),
  z.object({ mode: z.literal("recent"), since: z.iso.datetime({ offset: true }) }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      inputIds: z.array(z.number().int().positive()).min(1).max(10000),
    })
    .strict(),
])
export type PublicationScope = z.infer<typeof publicationScopeSchema>
export type ProcessingInput = {
  seq: number
  sourceKey: string
  itemId: string
  contentVersion: string
  receivedAt: string
  releaseVersion: number | null
  generation: number
  status: string
  current: boolean
  body: SourceEntry
}

export type UnchangedInputReconciliation = {
  currentSeq: number
  historicalSeq: number
  sourceKey: string
  itemId: string
  contentVersion: string
  expectedHistoricalStatus: "succeeded" | "failed" | "pending"
  expectedCurrentStatus: "succeeded" | "failed" | "pending"
  expectedReleaseVersion: number
  expectedGeneration: number
  expectedDecisionId: string | null
  expectedCurrentDecisionId: string | null
  expectedSnapshotError: string | null
  expectedCurrentReceivedAt: string
}

export type UnchangedInputReconciliationGuard = {
  expectedCount: number
  minimumCurrentSeq: number
  minimumCurrentReceivedAt: string
  maximumHistoricalSeq: number
}

// 草稿、不可变发布和输入目标共用业务数据库，发布边界使用摄取序号而非文章来源日期。
export class AutomationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: () => string | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_draft (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_set_releases (version INTEGER PRIMARY KEY AUTOINCREMENT, draft_revision INTEGER NOT NULL, activation_seq INTEGER NOT NULL, body TEXT NOT NULL, scope TEXT NOT NULL, targets TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL, item_id TEXT NOT NULL, content_version TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL, release_version INTEGER, generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', current INTEGER NOT NULL DEFAULT 1, decision_id TEXT);
      CREATE INDEX IF NOT EXISTS processing_input_identity ON processing_inputs(source_key,item_id,current);
      CREATE TABLE IF NOT EXISTS entry_decisions (id TEXT PRIMARY KEY, input_seq INTEGER NOT NULL, generation INTEGER NOT NULL, release_version INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_requests (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, scope TEXT NOT NULL, release_version INTEGER NOT NULL);
    `)
  }

  private transaction<T>(operation: () => T): T {
    // SAVEPOINT 可嵌入扫描页面事务，避免条目与版本状态发生半提交。
    this.db.exec("SAVEPOINT automation_write")
    try {
      const value = operation()
      this.db.exec("RELEASE automation_write")
      return value
    } catch (error) {
      this.db.exec("ROLLBACK TO automation_write; RELEASE automation_write")
      throw error
    }
  }

  draft(): { revision: number; config: RuleSet } {
    const ownerId = this.owner()
    if (!ownerId) throw new AutomationError("owner_required")
    const row = this.db.prepare("SELECT revision,body FROM automation_draft WHERE id=1").get()
    if (row)
      return {
        revision: Number(row.revision),
        config: ruleSetSchema.parse(JSON.parse(String(row.body))),
      }
    return {
      revision: 0,
      config: { formatVersion: 4, ownerId, global: { version: 1, markdown: "" }, rules: [] },
    }
  }

  saveDraft(input: unknown, expectedRevision: number) {
    const parsed = ruleSetSchema.safeParse(input)
    if (!parsed.success || parsed.data.ownerId !== this.owner())
      throw new AutomationError("invalid_rule_set")
    return this.transaction(() => {
      const previous = this.draft()
      if (previous.revision !== expectedRevision) throw new AutomationError("revision_conflict")
      const config = parsed.data
      config.global.version =
        previous.config.global.version +
        Number(config.global.markdown !== previous.config.global.markdown)
      config.rules = config.rules.map((rule) => {
        const old = previous.config.rules.find((candidate) => candidate.id === rule.id)
        const changed =
          old && JSON.stringify({ ...old, version: 0 }) !== JSON.stringify({ ...rule, version: 0 })
        return { ...rule, version: old ? old.version + Number(changed) : 1 }
      })
      const revision = previous.revision + 1
      this.db
        .prepare("INSERT OR REPLACE INTO automation_draft VALUES(1,?,?)")
        .run(revision, JSON.stringify(config))
      return { revision, config }
    })
  }

  capture(entry: SourceEntry) {
    const contentVersion = createHash("sha256")
      .update(
        JSON.stringify([
          entry.id,
          entry.title,
          entry.url,
          entry.publishedAt,
          entry.content,
          entry.description,
          entry.author ?? null,
          entry.language ?? null,
          entry.updatedAt ?? null,
          entry.mediaLength ?? null,
          entry.attachmentsDuration ?? null,
          entry.collected ?? null,
          // List 返回的原始 feed 身份补齐后需要重新匹配来源条件。
          entry.feedId,
          entry.feedKind,
        ]),
      )
      .digest("hex")
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT seq,content_version,release_version FROM processing_inputs WHERE source_key=? AND item_id=? AND current=1 ORDER BY seq DESC LIMIT 1",
        )
        .get(entry.sourceKey, entry.id)
      if (previous?.content_version === contentVersion) {
        // 未分配任务可刷新原文状态；已分配输入保持运行快照，阅读变化不产生新内容版本。
        if (previous.release_version === null)
          this.db
            .prepare("UPDATE processing_inputs SET body=? WHERE seq=?")
            .run(JSON.stringify(entry), previous.seq!)
        return Number(previous.seq)
      }
      this.db
        .prepare(
          "UPDATE processing_inputs SET current=0 WHERE source_key=? AND item_id=? AND current=1",
        )
        .run(entry.sourceKey, entry.id)
      const result = this.db
        .prepare(
          "INSERT INTO processing_inputs(source_key,item_id,content_version,body,received_at) VALUES(?,?,?,?,?)",
        )
        .run(
          entry.sourceKey,
          entry.id,
          contentVersion,
          JSON.stringify(entry),
          new Date().toISOString(),
        )
      return Number(result.lastInsertRowid)
    })
  }

  inputs(): ProcessingInput[] {
    return this.db
      .prepare("SELECT * FROM processing_inputs WHERE current=1 ORDER BY seq")
      .all()
      .map((row) => this.inputFromRow(row))
  }

  current(sourceKey: string, itemId: string): ProcessingInput | null {
    const row = this.db
      .prepare(
        "SELECT * FROM processing_inputs WHERE source_key=? AND item_id=? AND current=1 ORDER BY seq DESC LIMIT 1",
      )
      .get(sourceKey, itemId)
    return row ? this.inputFromRow(row) : null
  }

  invalidateSources(sourceKeys: string[]) {
    // 来源元数据改变时只更新受影响输入代际；既有不可变决策保留作历史。
    return this.transaction(() => {
      const keys = new Set(sourceKeys)
      const targets = this.inputs().filter(
        (input) =>
          keys.has(input.sourceKey) ||
          (input.body.feedId && keys.has(`${input.body.feedKind ?? "feed"}/${input.body.feedId}`)),
      )
      const update = this.db.prepare(
        "UPDATE processing_inputs SET generation=generation+1,status='pending' WHERE seq=? AND release_version IS NOT NULL",
      )
      for (const target of targets) update.run(target.seq)
      return targets.map((target) => target.seq)
    })
  }

  private inputFromRow(row: Record<string, unknown>): ProcessingInput {
    return {
      seq: Number(row.seq),
      sourceKey: String(row.source_key),
      itemId: String(row.item_id),
      contentVersion: String(row.content_version),
      receivedAt: String(row.received_at),
      releaseVersion: row.release_version === null ? null : Number(row.release_version),
      generation: Number(row.generation),
      status: String(row.status),
      current: Boolean(row.current),
      body: JSON.parse(String(row.body)) as SourceEntry,
    }
  }

  releases() {
    return this.db
      .prepare(
        "SELECT version,draft_revision,activation_seq,scope,targets,created_at FROM rule_set_releases ORDER BY version DESC",
      )
      .all()
      .map((row) => ({
        version: Number(row.version),
        draftRevision: Number(row.draft_revision),
        activationSeq: Number(row.activation_seq),
        scope: publicationScopeSchema.parse(JSON.parse(String(row.scope))),
        targetInputIds: JSON.parse(String(row.targets)) as number[],
        createdAt: String(row.created_at),
      }))
  }

  release(version: number): RuleSet | null {
    const row = this.db.prepare("SELECT body FROM rule_set_releases WHERE version=?").get(version)
    return row ? ruleSetSchema.parse(JSON.parse(String(row.body))) : null
  }

  publish(expectedRevision: number, rawScope: unknown, requestId: string) {
    const parsed = publicationScopeSchema.safeParse(rawScope)
    if (!parsed.success || !z.uuid().safeParse(requestId).success)
      throw new AutomationError("invalid_target")
    return this.transaction(() => {
      const scope = parsed.data
      if (scope.mode === "selected")
        scope.inputIds = [...new Set(scope.inputIds)].sort((a, b) => a - b)
      // HTTP 响应丢失后重发同一请求，返回原来的冻结范围，不再次发布或扩大目标集。
      const previous = this.db
        .prepare("SELECT * FROM publication_requests WHERE id=?")
        .get(requestId)
      if (previous) {
        if (
          Number(previous.revision) !== expectedRevision ||
          previous.scope !== JSON.stringify(scope)
        )
          throw new AutomationError("revision_conflict")
        return this.releases().find(
          (release) => release.version === Number(previous.release_version),
        )!
      }
      const draft = this.draft()
      if (draft.revision !== expectedRevision) throw new AutomationError("revision_conflict")
      const inputs = this.inputs()
      const selected = scope.mode === "selected" ? new Set(scope.inputIds) : null
      if (selected && [...selected].some((id) => !inputs.some((input) => input.seq === id)))
        throw new AutomationError("invalid_target")
      const targets = inputs.filter(
        (input) =>
          input.releaseVersion === null ||
          (scope.mode === "selected" && selected!.has(input.seq)) ||
          (scope.mode === "recent" && Date.parse(input.receivedAt) >= Date.parse(scope.since)),
      )
      const activationSeq = Number(
        this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM processing_inputs").get()!.seq,
      )
      const targetInputIds = targets.map((input) => input.seq)
      const createdAt = new Date().toISOString()
      const result = this.db
        .prepare(
          "INSERT INTO rule_set_releases(draft_revision,activation_seq,body,scope,targets,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          draft.revision,
          activationSeq,
          JSON.stringify(draft.config),
          JSON.stringify(scope),
          JSON.stringify(targetInputIds),
          createdAt,
        )
      const version = Number(result.lastInsertRowid)
      this.db
        .prepare("INSERT INTO publication_requests VALUES(?,?,?,?)")
        .run(requestId, draft.revision, JSON.stringify(scope), version)
      const update = this.db.prepare(
        "UPDATE processing_inputs SET release_version=?,generation=generation+1,status='pending' WHERE seq=? AND current=1",
      )
      for (const input of targets) update.run(version, input.seq)
      return {
        version,
        draftRevision: draft.revision,
        activationSeq,
        scope,
        targetInputIds,
        createdAt,
      }
    })
  }

  assign(seq: number) {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM processing_inputs WHERE seq=? AND current=1")
        .get(seq)
      if (!row) throw new AutomationError("invalid_target")
      if (row.release_version === null) {
        const release = this.db
          .prepare("SELECT MAX(version) AS version FROM rule_set_releases")
          .get()
        if (release?.version == null) throw new AutomationError("invalid_target")
        this.db
          .prepare(
            "UPDATE processing_inputs SET release_version=?,generation=generation+1 WHERE seq=?",
          )
          .run(release.version, seq)
      }
      return this.inputFromRow(
        this.db.prepare("SELECT * FROM processing_inputs WHERE seq=?").get(seq)!,
      )
    })
  }

  complete(target: ProcessingInput, decision: object) {
    return this.transaction(() => {
      if (target.releaseVersion === null) throw new AutomationError("invalid_target")
      // 同一目标只接受第一个完成结果；重发不能替换已经保存的不可变决策。
      const id = createHash("sha256")
        .update(JSON.stringify([target.seq, target.generation, target.releaseVersion]))
        .digest("hex")
      this.db
        .prepare("INSERT OR IGNORE INTO entry_decisions VALUES(?,?,?,?,?,?)")
        .run(
          id,
          target.seq,
          target.generation,
          target.releaseVersion,
          JSON.stringify(decision),
          new Date().toISOString(),
        )
      // 晚到任务保留历史，但不能覆盖新内容、新发布范围或重算后的当前结果。
      const result = this.db
        .prepare(
          "UPDATE processing_inputs SET status='succeeded',decision_id=? WHERE seq=? AND current=1 AND content_version=? AND generation=? AND release_version=?",
        )
        .run(id, target.seq, target.contentVersion, target.generation, target.releaseVersion)
      return { id, published: result.changes === 1 }
    })
  }

  reconcileUnchangedInput(
    manifest: readonly UnchangedInputReconciliation[],
    guard: UnchangedInputReconciliationGuard,
  ) {
    // 该入口只用于经逐项核对的事故清单；全部守卫在同一事务内成立后才迁回旧指针。
    return this.transaction(() => {
      const invalid = (): never => {
        throw new AutomationError("invalid_reconciliation")
      }
      if (
        manifest.length !== guard.expectedCount ||
        manifest.length === 0 ||
        new Set(manifest.map((item) => item.currentSeq)).size !== manifest.length ||
        new Set(manifest.map((item) => item.historicalSeq)).size !== manifest.length
      )
        invalid()
      if (
        Number(
          this.db
            .prepare("SELECT count(*) AS n FROM processing_inputs WHERE status='running'")
            .get()?.n ?? 0,
        ) !== 0
      )
        invalid()
      const duplicateCurrent = this.db
        .prepare(
          "SELECT 1 FROM processing_inputs WHERE current=1 GROUP BY source_key,item_id HAVING count(*)<>1 LIMIT 1",
        )
        .get()
      if (duplicateCurrent) invalid()
      const currentCount = Number(
        this.db.prepare("SELECT count(*) AS n FROM processing_inputs WHERE current=1").get()?.n ??
          0,
      )
      const selectInput = this.db.prepare("SELECT * FROM processing_inputs WHERE seq=?")
      const selectDecision = this.db.prepare("SELECT * FROM entry_decisions WHERE id=?")
      const selectRelease = this.db.prepare("SELECT 1 FROM rule_set_releases WHERE version=?")
      const selectSnapshot = this.db.prepare(
        "SELECT error FROM processing_target_snapshots WHERE input_seq=? AND generation=?",
      )
      const selectCache = this.db.prepare(
        "SELECT body FROM processing_model_cache WHERE fingerprint=?",
      )
      const selectMaterial = this.db.prepare(
        "SELECT status FROM processing_material_state WHERE source_key=? AND item_id=? AND content_version=?",
      )
      const demote = this.db.prepare(
        "UPDATE processing_inputs SET current=0 WHERE seq=? AND current=1",
      )
      const promote = this.db.prepare(
        "UPDATE processing_inputs SET current=1 WHERE seq=? AND current=0",
      )
      const restored = { succeeded: 0, failed: 0, pending: 0 }
      for (const item of manifest) {
        const current = selectInput.get(item.currentSeq)
        const historical = selectInput.get(item.historicalSeq)
        if (!current || !historical) invalid()
        const currentRow = current as Record<string, unknown>
        const historicalRow = historical as Record<string, unknown>
        const currentReceivedAt = Date.parse(String(currentRow.received_at))
        const minimumCurrentReceivedAt = Date.parse(guard.minimumCurrentReceivedAt)
        if (
          item.currentSeq < guard.minimumCurrentSeq ||
          item.historicalSeq > guard.maximumHistoricalSeq ||
          String(currentRow.received_at) !== item.expectedCurrentReceivedAt ||
          !Number.isFinite(currentReceivedAt) ||
          !Number.isFinite(minimumCurrentReceivedAt) ||
          currentReceivedAt < minimumCurrentReceivedAt ||
          Number(currentRow.current) !== 1 ||
          Number(historicalRow.current) !== 0 ||
          String(currentRow.source_key) !== item.sourceKey ||
          String(historicalRow.source_key) !== item.sourceKey ||
          String(currentRow.item_id) !== item.itemId ||
          String(historicalRow.item_id) !== item.itemId ||
          String(currentRow.content_version) !== item.contentVersion ||
          String(historicalRow.content_version) !== item.contentVersion ||
          String(currentRow.status) !== item.expectedCurrentStatus ||
          String(historicalRow.status) !== item.expectedHistoricalStatus ||
          Number(historicalRow.release_version) !== item.expectedReleaseVersion ||
          Number(historicalRow.generation) !== item.expectedGeneration ||
          (currentRow.decision_id === null ? null : String(currentRow.decision_id)) !==
            item.expectedCurrentDecisionId ||
          (historicalRow.decision_id === null ? null : String(historicalRow.decision_id)) !==
            item.expectedDecisionId ||
          !selectRelease.get(item.expectedReleaseVersion)
        )
          invalid()
        const currentBody = parseObject(currentRow.body)
        const historicalBody = parseObject(historicalRow.body)
        if (!currentBody || !historicalBody || !equalExceptRead(currentBody, historicalBody))
          invalid()
        if (
          String(
            selectMaterial.get(item.sourceKey, item.itemId, item.contentVersion)?.status ?? "",
          ) !== "complete"
        )
          invalid()
        if (item.expectedHistoricalStatus === "succeeded") {
          if (!item.expectedDecisionId || item.expectedSnapshotError !== null) invalid()
          const decision = selectDecision.get(item.expectedDecisionId)
          if (!decision) invalid()
          const decisionRow = decision as Record<string, unknown>
          if (
            Number(decisionRow.input_seq) !== item.historicalSeq ||
            Number(decisionRow.generation) !== item.expectedGeneration ||
            Number(decisionRow.release_version) !== item.expectedReleaseVersion
          )
            invalid()
          const decisionBody = parseObject(decisionRow.body)
          const fingerprint = decisionBody?.fingerprint
          if (
            decisionBody?.schemaVersion !== 1 ||
            typeof fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/u.test(fingerprint)
          )
            invalid()
          const verifiedFingerprint = fingerprint as string
          const cacheBody = parseObject(selectCache.get(verifiedFingerprint)?.body)
          if (cacheBody?.schemaVersion !== 1 || cacheBody.fingerprint !== verifiedFingerprint)
            invalid()
        } else {
          if (item.expectedDecisionId !== null || !item.expectedSnapshotError) invalid()
          const snapshot = selectSnapshot.get(item.historicalSeq, item.expectedGeneration)
          if (!snapshot || snapshot.error !== item.expectedSnapshotError) invalid()
        }
        // 历史已分配输入保持不可变；实时 read 继续由 entries 表提供。
        if (demote.run(item.currentSeq).changes !== 1) invalid()
        if (promote.run(item.historicalSeq).changes !== 1) invalid()
        restored[item.expectedHistoricalStatus] += 1
      }
      const finalCurrentCount = Number(
        this.db.prepare("SELECT count(*) AS n FROM processing_inputs WHERE current=1").get()?.n ??
          0,
      )
      const finalDuplicateCurrent = this.db
        .prepare(
          "SELECT 1 FROM processing_inputs WHERE current=1 GROUP BY source_key,item_id HAVING count(*)<>1 LIMIT 1",
        )
        .get()
      if (finalCurrentCount !== currentCount || finalDuplicateCurrent) invalid()
      return { total: manifest.length, ...restored }
    })
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function equalExceptRead(left: Record<string, unknown>, right: Record<string, unknown>) {
  const { read: _leftRead, ...leftStable } = left
  const { read: _rightRead, ...rightStable } = right
  return JSON.stringify(leftStable) === JSON.stringify(rightStable)
}
