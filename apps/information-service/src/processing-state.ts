import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { RuleInput } from "@follow/information-core"

import type { AIProvider } from "./ai-config"
import type { ReasoningEffort } from "./ai-reasoning"
import type { AutomationStore, ProcessingInput } from "./automation-store"
import { AutomationError } from "./automation-store"
import type { ProcessingDecision, PublishedDecision } from "./processing-decision"

export type TargetSnapshot = {
  context: RuleInput
  provider: AIProvider
  model: string
  baseUrl?: string
  endpointFingerprint?: string
  // 已领取目标冻结强度；旧快照缺字段仍以 low 重试。
  reasoningEffort?: ReasoningEffort
  sourceRole: string
  metadataVersion: number
}
export type DecisionQuarantine = {
  inputSeq: number
  contentVersion: string
  decisionId: string
  reason: string
  status: "keep" | "needs_context"
  // 修复正文由已核验原文提供，不能复用错误的模型摘要。
  summary: string
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
      CREATE TABLE IF NOT EXISTS processing_input_retries(input_seq INTEGER NOT NULL,generation INTEGER NOT NULL,last_failed_at TEXT NOT NULL,automatic_retries INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL,PRIMARY KEY(input_seq,generation));
      CREATE TABLE IF NOT EXISTS processing_decision_quarantine(decision_id TEXT PRIMARY KEY,input_seq INTEGER NOT NULL,content_version TEXT NOT NULL,fingerprint TEXT NOT NULL,reason TEXT NOT NULL,replacement_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processing_quarantine_fingerprint ON processing_decision_quarantine(fingerprint);
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

  fail(input: ProcessingInput, error: string, now = new Date()) {
    this.db
      .prepare("UPDATE processing_target_snapshots SET error=? WHERE input_seq=? AND generation=?")
      .run(error, input.seq, input.generation)
    const changed = this.db
      .prepare(
        "UPDATE processing_inputs SET status='failed' WHERE seq=? AND current=1 AND generation=?",
      )
      .run(input.seq, input.generation)
    // 每次失败刷新退避起点，自动重试次数跨任务和服务重启保存。
    if (Number(changed.changes) === 1)
      this.db
        .prepare(
          "INSERT INTO processing_input_retries VALUES(?,?,?,0,?) ON CONFLICT(input_seq,generation) DO UPDATE SET last_failed_at=excluded.last_failed_at,error=excluded.error",
        )
        .run(input.seq, input.generation, now.toISOString(), error)
  }

  recover() {
    // 中断的模型调用结果未知，标为失败，避免重启时无提示重复付费。
    this.db
      .prepare(
        "INSERT INTO processing_input_retries SELECT seq,generation,?,0,'processing_interrupted' FROM processing_inputs WHERE status='running' ON CONFLICT(input_seq,generation) DO UPDATE SET last_failed_at=excluded.last_failed_at,error=excluded.error",
      )
      .run(new Date().toISOString())
    this.db.exec("UPDATE processing_inputs SET status='failed' WHERE status='running'")
  }

  retry(seq: number) {
    const changed =
      this.db
        .prepare(
          "UPDATE processing_inputs SET status='pending' WHERE seq=? AND current=1 AND status='failed'",
        )
        .run(seq).changes === 1
    // 用户显式重试重新授予额度；配置快照和已发布版本仍保留。
    if (changed) this.db.prepare("DELETE FROM processing_input_retries WHERE input_seq=?").run(seq)
    return changed
  }

  failure(input: ProcessingInput): string | null {
    const row = this.db
      .prepare(
        "SELECT error FROM processing_input_retries WHERE input_seq=? AND generation=? UNION ALL SELECT error FROM processing_target_snapshots WHERE input_seq=? AND generation=? LIMIT 1",
      )
      .get(input.seq, input.generation, input.seq, input.generation)
    return typeof row?.error === "string" ? row.error : null
  }

  retryAutomatically(input: ProcessingInput, now = new Date()): boolean {
    if (!input.current || input.status !== "failed" || input.releaseVersion === null) return false
    const error = this.failure(input)
    // 只自动恢复暂时性的调用故障，配置错误、无效输出及未知中断需要显式处理。
    if (
      !error ||
      ![
        "codex_process_failed",
        "codex_timeout",
        "codex_incomplete_turn",
        "codex_connection",
        "codex_rate_limit",
      ].includes(error)
    )
      return false
    const readRetry = this.db.prepare(
      "SELECT * FROM processing_input_retries WHERE input_seq=? AND generation=?",
    )
    let row = readRetry.get(input.seq, input.generation)
    if (!row) {
      // 仅首次迁移旧失败才读取报告；摄取时间不是失败时间，不能据此提前补付费。
      const reported = this.db
        .prepare(
          "SELECT MAX(COALESCE(json_extract(report.body,'$.finishedAt'),json_extract(report.body,'$.progressAt'))) AS failed_at FROM processing_trigger_reports AS report,json_each(report.body,'$.entries.failures') AS failure WHERE json_extract(failure.value,'$.inputSeq')=? AND json_extract(failure.value,'$.code')=?",
        )
        .get(input.seq, error)
      const failedAt = Date.parse(String(reported?.failed_at ?? ""))
      const knownFailureTime =
        Number.isFinite(failedAt) &&
        failedAt >= Date.parse(input.receivedAt) &&
        failedAt <= now.getTime()
          ? new Date(failedAt).toISOString()
          : now.toISOString()
      // 缺少可靠失败时间的旧目标从首次观察开始等待，仍只允许两次自动续跑。
      this.db
        .prepare("INSERT OR IGNORE INTO processing_input_retries VALUES(?,?,?,0,?)")
        .run(input.seq, input.generation, knownFailureTime, error)
      row = readRetry.get(input.seq, input.generation)!
    }
    if (
      Number(row.automatic_retries) >= 2 ||
      now.getTime() - Date.parse(String(row.last_failed_at)) < 5 * 60_000
    )
      return false
    const changed =
      this.db
        .prepare(
          "UPDATE processing_inputs SET status='pending' WHERE seq=? AND current=1 AND generation=? AND release_version=? AND status='failed'",
        )
        .run(input.seq, input.generation, input.releaseVersion).changes === 1
    if (changed)
      this.db
        .prepare(
          "UPDATE processing_input_retries SET automatic_retries=automatic_retries+1 WHERE input_seq=? AND generation=?",
        )
        .run(input.seq, input.generation)
    return changed
  }

  /**
   * 读态收敛：已读的当前输入直接进入终态，不再占用模型额度。
   *
   * `read` 不属于内容身份（automation-store 的身份比较显式忽略它），所以来源侧读到一半
   * 不会自动让输入换代；队列里历史遗留的已读条目必须在这里显式收敛，否则会永久停留在
   * 「待处理」并每轮重复参与候选。反向同样成立：来源侧又变回未读时要重新放回队列，
   * 否则「跳过」会变成一个不可逆的黑洞。
   *
   * 只在读态明确时动作：`read` 为 `null`（例如 X 搜索来源没有读态）保持原状。失败态一并
   * 收敛——已读条目的处理失败没有修复价值，留在失败视图只会误导。
   */
  settleRead(skip: number[], revive: number[]) {
    const toSkipped = this.db.prepare(
      "UPDATE processing_inputs SET status='skipped' WHERE seq=? AND current=1 AND status IN ('pending','failed')",
    )
    const toPending = this.db.prepare(
      "UPDATE processing_inputs SET status='pending' WHERE seq=? AND current=1 AND status='skipped'",
    )
    let changed = 0
    // 单条失败不必整体回滚：下一轮会重新计算，收敛本身是幂等的。
    // `changes` 在 node:sqlite 的类型里是 `number | bigint`，显式归一化后再累加。
    for (const seq of skip) changed += Number(toSkipped.run(seq).changes)
    for (const seq of revive) changed += Number(toPending.run(seq).changes)
    return changed
  }

  cache(fingerprint: string): ProcessingDecision | null {
    // 已确认材料错配的缓存永久隔离；保留原始记录用于审计，不靠删除掩盖事故。
    if (
      this.db
        .prepare("SELECT 1 FROM processing_decision_quarantine WHERE fingerprint=?")
        .get(fingerprint)
    )
      return null
    const row = this.db
      .prepare("SELECT body FROM processing_model_cache WHERE fingerprint=?")
      .get(fingerprint)
    return row ? (JSON.parse(String(row.body)) as ProcessingDecision) : null
  }

  saveCache(decision: ProcessingDecision) {
    if (
      this.db
        .prepare("SELECT 1 FROM processing_decision_quarantine WHERE fingerprint=?")
        .get(decision.fingerprint)
    )
      return
    this.db
      .prepare("INSERT OR IGNORE INTO processing_model_cache VALUES(?,?,?)")
      .run(decision.fingerprint, JSON.stringify(decision), decision.generatedAt)
  }

  quarantine(manifest: readonly DecisionQuarantine[]) {
    this.db.exec("SAVEPOINT quarantine_decisions")
    try {
      const results: Array<{ inputSeq: number; decisionId: string; repeated: boolean }> = []
      // 先核验整份清单，任一正文或发布指针已变更都不能半提交修复。
      const targets = manifest.map((item) => {
        const previous = this.db
          .prepare(
            "SELECT replacement_id FROM processing_decision_quarantine WHERE decision_id=? AND input_seq=? AND content_version=?",
          )
          .get(item.decisionId, item.inputSeq, item.contentVersion)
        if (previous) return { item, previous: String(previous.replacement_id), published: null }
        const published = this.published([item.inputSeq]).find(
          (value) =>
            value.input.current &&
            value.input.contentVersion === item.contentVersion &&
            value.decisionId === item.decisionId,
        )
        if (!published || !item.reason.trim()) throw new AutomationError("revision_conflict")
        return { item, previous: null, published }
      })
      for (const { item, previous, published } of targets) {
        if (previous) {
          results.push({ inputSeq: item.inputSeq, decisionId: previous, repeated: true })
          continue
        }
        const { input, decision } = published!
        const replacement: ProcessingDecision = {
          ...decision,
          fingerprint: createHash("sha256")
            .update(JSON.stringify(["audited-repair-v1", item]))
            .digest("hex"),
          generatedAt: new Date().toISOString(),
          durationMs: 0,
          usage: null,
          status: item.status,
          title: input.body.title ?? "",
          summary: item.summary,
          reason: item.reason,
          labels: [],
          facts: [],
          semantic: null,
          semanticProfile: undefined,
          analysisFingerprint: undefined,
          pendingPolicyFields: undefined,
          policy: { standalone: "always", aggregation: "deny", rewrite: "deny" },
          repair: { sourceDecisionId: item.decisionId, reason: item.reason },
          reused: false,
        }
        // 发布新代际，旧决定保持不可变；不改已读、收藏及用户已有人工覆盖。
        const completed = this.automation.recalculate(input, replacement)
        this.db
          .prepare("INSERT INTO processing_decision_quarantine VALUES(?,?,?,?,?,?,?)")
          .run(
            item.decisionId,
            input.seq,
            input.contentVersion,
            decision.fingerprint,
            item.reason,
            completed.id,
            replacement.generatedAt,
          )
        results.push({ inputSeq: input.seq, decisionId: completed.id, repeated: false })
      }
      this.db.exec("RELEASE quarantine_decisions")
      return results
    } catch (error) {
      this.db.exec("ROLLBACK TO quarantine_decisions; RELEASE quarantine_decisions")
      throw error
    }
  }

  published(inputSeqs?: readonly number[]): PublishedDecision[] {
    const result: PublishedDecision[] = []
    // 详情只核验本组发布指针，避免每次展开理由都解析全部当前原文。
    for (const input of this.automation.inputs(inputSeqs)) {
      const row = this.db
        .prepare(
          "SELECT decisions.id,decisions.body FROM entry_decisions decisions JOIN processing_inputs inputs ON inputs.decision_id=decisions.id WHERE inputs.seq=? AND inputs.status='succeeded' AND decisions.generation=inputs.generation AND decisions.release_version=inputs.release_version",
        )
        .get(input.seq)
      if (row) {
        const decision = JSON.parse(String(row.body)) as ProcessingDecision
        if (decision.schemaVersion === 1 || decision.schemaVersion === 2)
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

  overrides(inputSeqs?: readonly number[]) {
    // 用户纠偏绑定来源与原文身份，正文版本变化后仍有效。
    return this.automation.inputs(inputSeqs).map((input) => {
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
