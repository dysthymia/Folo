import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { ConditionSet, RuleSet } from "@follow/information-core"
import { matchConditions } from "@follow/information-core"

import type { AIConfigStore } from "./ai-config"
import type { AutomationStore, ProcessingInput } from "./automation-store"
import type { CodexUsage, runCodexJson } from "./codex"
import type { Source } from "./folo"
import type { PublishedDecision } from "./processing-decision"
import type { ProcessingStateStore } from "./processing-state"
import type {
  SemanticDuplicateCandidate,
  SemanticDuplicateEntry,
  SemanticDuplicateEvaluation,
} from "./semantic-dedupe"
import {
  dedupeUrlHost,
  evaluateSemanticDuplicateCandidates,
  getSemanticDuplicateCandidates,
  MAX_SEMANTIC_DUPLICATE_CANDIDATES,
  SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
  SEMANTIC_DUPLICATE_PROMPT_VERSION,
  truncateDedupeDescription,
} from "./semantic-dedupe"

/**
 * 语义去重的持久化与执行。
 *
 * 判定按"对"保存，读取时逐条核对正文版本与规则指纹，任何一侧正文更新、或用户改了去重
 * 规则，旧判定立即失效并被重算；这与阅读快照对决定的处理方式一致，不做原地修改。
 */
const MAX_BATCHES_PER_RUN = 3
// 单轮最多判定的对数。预筛时多取一个，用来区分"确实没有剩余候选"与"预算刚好用尽"。
const MAX_CANDIDATES_PER_RUN = MAX_BATCHES_PER_RUN * MAX_SEMANTIC_DUPLICATE_CANDIDATES

export type DedupeAction = {
  ruleId: string
  when: ConditionSet
  scope: ConditionSet
  fingerprint: string
}

export type DedupeDecisionView = {
  pairKey: string
  ruleId: string
  duplicate: boolean
  confidence: number
  reason: string | null
  keep: ProcessingInput | null
  hide: ProcessingInput | null
}

const inputKey = (sourceKey: string, itemId: string) => `${sourceKey}\u0000${itemId}`

/**
 * 规则指纹只包含规则身份、参与范围与提示词版本：正文之外的模型设置变化不追溯推翻既有
 * 判定，但用户改动去重规则会立刻让旧判定失效。
 */
export function dedupeConfigFingerprint(input: { ruleId: string; scope: ConditionSet }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SEMANTIC_DUPLICATE_PROMPT_VERSION,
        ruleId: input.ruleId,
        scope: input.scope,
      }),
    )
    .digest("hex")
}

/** 只取最新一次发布的去重规则：它是用户当前意图，删除动作即等于关闭去重。 */
export function activeDedupeActions(config: RuleSet | null): DedupeAction[] {
  return (config?.rules ?? [])
    .filter((rule) => rule.enabled)
    .flatMap((rule) =>
      rule.actions
        .filter((action) => action.type === "ai_dedupe")
        .map((action) => ({
          fingerprint: dedupeConfigFingerprint({ ruleId: rule.id, scope: action.scope }),
          ruleId: rule.id,
          scope: action.scope,
          when: rule.when,
        })),
    )
}

export class ProcessingDedupeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly inputs: () => ProcessingInput[],
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processing_dedupe_decisions (
        pair_key TEXT NOT NULL,
        config_fingerprint TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        keep_source_key TEXT NOT NULL,
        keep_item_id TEXT NOT NULL,
        keep_content_version TEXT NOT NULL,
        hide_source_key TEXT NOT NULL,
        hide_item_id TEXT NOT NULL,
        hide_content_version TEXT NOT NULL,
        duplicate INTEGER NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(pair_key,config_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS processing_dedupe_decisions_hide
        ON processing_dedupe_decisions(hide_source_key,hide_item_id);
      CREATE TABLE IF NOT EXISTS processing_dedupe_scans (
        source_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        content_version TEXT NOT NULL,
        config_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(source_key,item_id,config_fingerprint)
      );
    `)
  }

  private currentInputs() {
    return new Map(this.inputs().map((input) => [inputKey(input.sourceKey, input.itemId), input]))
  }

  /** 仍然有效的判定：两侧正文版本未变，且规则指纹仍在当前生效集合内。 */
  private validDecisions(fingerprints: ReadonlySet<string>): DedupeDecisionView[] {
    if (fingerprints.size === 0) return []
    const byKey = this.currentInputs()
    const views: DedupeDecisionView[] = []
    for (const row of this.db.prepare("SELECT * FROM processing_dedupe_decisions").all()) {
      const fingerprint = String(row.config_fingerprint)
      if (!fingerprints.has(fingerprint)) continue
      const keep = byKey.get(inputKey(String(row.keep_source_key), String(row.keep_item_id)))
      const hide = byKey.get(inputKey(String(row.hide_source_key), String(row.hide_item_id)))
      if (keep?.contentVersion !== String(row.keep_content_version)) continue
      if (hide?.contentVersion !== String(row.hide_content_version)) continue
      views.push({
        confidence: Number(row.confidence),
        duplicate: Boolean(row.duplicate),
        hide: hide ?? null,
        keep: keep ?? null,
        pairKey: String(row.pair_key),
        reason: row.reason === null ? null : String(row.reason),
        ruleId: String(row.rule_id),
      })
    }
    return views
  }

  /** 已判定过的对（包含否定判定），用于避免下一轮重复请求模型。 */
  decidedPairKeys(fingerprints: ReadonlySet<string>): Set<string> {
    return new Set(this.validDecisions(fingerprints).map((decision) => decision.pairKey))
  }

  /** 角色投影消费的合并结论：只取达到置信阈值且两侧都还在的判定。 */
  merges(fingerprints: ReadonlySet<string>) {
    return this.validDecisions(fingerprints)
      .filter(
        (decision) =>
          decision.duplicate &&
          decision.confidence >= SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD &&
          decision.keep !== null &&
          decision.hide !== null &&
          decision.keep.itemId !== decision.hide.itemId,
      )
      .map((decision) => ({
        confidence: decision.confidence,
        hide: decision.hide!,
        keep: decision.keep!,
        reason: decision.reason,
        ruleId: decision.ruleId,
      }))
  }

  /** 已完成整轮扫描且没有可比对象的条目，避免每轮把全库重扫一遍。 */
  settledItemIds(fingerprints: ReadonlySet<string>): ReadonlySet<string> {
    if (fingerprints.size === 0) return new Set()
    const byKey = this.currentInputs()
    const settled = new Set<string>()
    for (const row of this.db.prepare("SELECT * FROM processing_dedupe_scans").all()) {
      if (!fingerprints.has(String(row.config_fingerprint))) continue
      const input = byKey.get(inputKey(String(row.source_key), String(row.item_id)))
      if (!input || input.contentVersion !== String(row.content_version)) continue
      settled.add(input.itemId)
    }
    return settled
  }

  /** 写入一批判定；正文换代期间到达的结果按当前版本登记，不写会立刻失效的行。 */
  saveBatch(input: {
    configFingerprint: string
    ruleId: string
    provider: string
    model: string
    decisions: Array<{
      candidate: SemanticDuplicateCandidate
      evaluation: SemanticDuplicateEvaluation
      keep: ProcessingInput
      hide: ProcessingInput
    }>
  }) {
    if (input.decisions.length === 0) return
    const now = new Date().toISOString()
    const byKey = this.currentInputs()
    this.db.exec("SAVEPOINT dedupe_batch")
    try {
      const insert = this.db.prepare(
        `INSERT INTO processing_dedupe_decisions(
          pair_key,config_fingerprint,rule_id,provider,model,
          keep_source_key,keep_item_id,keep_content_version,
          hide_source_key,hide_item_id,hide_content_version,
          duplicate,confidence,reason,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(pair_key,config_fingerprint) DO UPDATE SET
          rule_id=excluded.rule_id,provider=excluded.provider,model=excluded.model,
          keep_source_key=excluded.keep_source_key,keep_item_id=excluded.keep_item_id,
          keep_content_version=excluded.keep_content_version,
          hide_source_key=excluded.hide_source_key,hide_item_id=excluded.hide_item_id,
          hide_content_version=excluded.hide_content_version,
          duplicate=excluded.duplicate,confidence=excluded.confidence,reason=excluded.reason,
          created_at=excluded.created_at`,
      )
      for (const item of input.decisions) {
        const keep = byKey.get(inputKey(item.keep.sourceKey, item.keep.itemId)) ?? item.keep
        const hide = byKey.get(inputKey(item.hide.sourceKey, item.hide.itemId)) ?? item.hide
        insert.run(
          item.candidate.pairKey,
          input.configFingerprint,
          input.ruleId,
          input.provider,
          input.model,
          keep.sourceKey,
          keep.itemId,
          keep.contentVersion,
          hide.sourceKey,
          hide.itemId,
          hide.contentVersion,
          Number(item.evaluation.duplicate),
          item.evaluation.confidence,
          item.evaluation.reason ?? null,
          now,
        )
      }
      this.db.exec("RELEASE dedupe_batch")
    } catch (error) {
      this.db.exec("ROLLBACK TO dedupe_batch; RELEASE dedupe_batch")
      throw error
    }
  }

  /** 登记"这些条目已完成整轮扫描且无可比对象"，下一轮不再重复预筛。 */
  markScanned(configFingerprint: string, inputs: ProcessingInput[]) {
    if (inputs.length === 0) return
    const now = new Date().toISOString()
    const byKey = this.currentInputs()
    this.db.exec("SAVEPOINT dedupe_scans")
    try {
      const insert = this.db.prepare(
        `INSERT INTO processing_dedupe_scans(source_key,item_id,content_version,config_fingerprint,created_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(source_key,item_id,config_fingerprint) DO UPDATE SET
           content_version=excluded.content_version,created_at=excluded.created_at`,
      )
      for (const item of inputs) {
        const current = byKey.get(inputKey(item.sourceKey, item.itemId))
        if (!current) continue
        insert.run(item.sourceKey, item.itemId, current.contentVersion, configFingerprint, now)
      }
      this.db.exec("RELEASE dedupe_scans")
    } catch (error) {
      this.db.exec("ROLLBACK TO dedupe_scans; RELEASE dedupe_scans")
      throw error
    }
  }
}

export type SemanticDedupeRunResult = {
  batches: number
  candidates: number
  duplicates: number
  /** 本轮预算用尽后仍未判定的候选对数；预算用尽时只知"还剩至少一对"，因此是下限。 */
  pending: number
  usage: CodexUsage
}

export type SemanticDedupeStore = {
  automation: AutomationStore
  processingState: ProcessingStateStore
  dedupe: ProcessingDedupeStore
  sources: () => Source[]
}

/**
 * 语义去重的一次执行。
 *
 * 参与范围由最新发布版本里启用的 `ai_dedupe` 动作决定：规则 `when` 与该动作的 `scope`
 * 都命中才算参与。判定结果写入角色层，时间线的过滤与角标不需要额外改动。
 */
export async function runSemanticDedupe(options: {
  store: SemanticDedupeStore
  aiConfig: AIConfigStore
  runtimeDir: string
  signal: AbortSignal
  execute?: typeof runCodexJson
}): Promise<SemanticDedupeRunResult> {
  const result: SemanticDedupeRunResult = {
    batches: 0,
    candidates: 0,
    duplicates: 0,
    pending: 0,
    usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
  }
  const releases = options.store.automation.releases()
  const latest = releases.length > 0 ? options.store.automation.release(releases[0]!.version) : null
  const actions = activeDedupeActions(latest)
  if (actions.length === 0) return result
  const fingerprints = new Set(actions.map((action) => action.fingerprint))
  const decided = options.store.dedupe.decidedPairKeys(fingerprints)
  const settled = options.store.dedupe.settledItemIds(fingerprints)
  const overrides = new Map(
    options.store.processingState.overrides().map((override) => [override.inputSeq, override.mode]),
  )
  const sources = new Map(
    options.store.sources().map((source) => [source.key, source.title] as const),
  )
  const publishedBySeq = new Map<number, PublishedDecision>(
    options.store.processingState.published().map((item) => [item.input.seq, item]),
  )
  for (const action of actions) {
    if (options.signal.aborted) break
    const participants = dedupeParticipants(action, publishedBySeq, overrides, sources)
    if (participants.length < 2) continue
    const entries = [...participants].sort(
      (left, right) =>
        Date.parse(right.input.body.publishedAt) - Date.parse(left.input.body.publishedAt),
    )
    const candidates = getSemanticDuplicateCandidates(
      entries.map((participant) => participant.entry),
      {
        decidedPairKeys: decided,
        // 预筛默认只返回 8 对；这里按整轮预算取，否则"是否还有剩余候选"永远判不出来，
        // 会把刚判过、其实还有可比对象的条目误登记为已扫完。
        maxCandidates: MAX_CANDIDATES_PER_RUN + 1,
        settledItemIds: settled,
      },
    )
    result.candidates += candidates.length
    if (candidates.length === 0) {
      // 只有整轮确实无可比对象才算"扫完"，否则留待下一轮继续消化剩余候选。
      options.store.dedupe.markScanned(
        action.fingerprint,
        entries.map((participant) => participant.input),
      )
      continue
    }
    const entryByItemId = new Map(
      entries.map((participant) => [participant.entry.itemId, participant]),
    )
    for (
      let offset = 0;
      offset < candidates.length && offset < MAX_CANDIDATES_PER_RUN;
      offset += MAX_SEMANTIC_DUPLICATE_CANDIDATES
    ) {
      if (options.signal.aborted) break
      const slice = candidates.slice(
        offset,
        Math.min(offset + MAX_SEMANTIC_DUPLICATE_CANDIDATES, MAX_CANDIDATES_PER_RUN),
      )
      const config = await options.aiConfig.read()
      const run = await evaluateSemanticDuplicateCandidates({
        aiConfig: config,
        candidates: slice,
        execute: options.execute,
        qianwen: await options.aiConfig.execution(config.provider),
        runtimeDir: options.runtimeDir,
        signal: options.signal,
      })
      result.batches += 1
      if (run.usage) {
        result.usage.inputTokens += run.usage.inputTokens
        result.usage.outputTokens += run.usage.outputTokens
        result.usage.cachedInputTokens += run.usage.cachedInputTokens
      }
      const decisions: Array<{
        candidate: SemanticDuplicateCandidate
        evaluation: SemanticDuplicateEvaluation
        keep: ProcessingInput
        hide: ProcessingInput
      }> = []
      for (const evaluation of run.evaluations) {
        const candidate = slice.find((item) => item.pairKey === evaluation.pairKey)
        if (!candidate) continue
        // 判定失效前先确认两侧仍在当前库中：正文换代期间到达的结果不再落库。
        const keep = entryByItemId.get(evaluation.keepEntryId ?? candidate.keepEntryId)
        const hide = entryByItemId.get(evaluation.hideEntryId ?? candidate.testEntryId)
        if (!keep || !hide || keep.input.seq === hide.input.seq) continue
        decisions.push({ candidate, evaluation, hide: hide.input, keep: keep.input })
        if (
          evaluation.duplicate &&
          evaluation.confidence >= SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD
        )
          result.duplicates += 1
      }
      options.store.dedupe.saveBatch({
        configFingerprint: action.fingerprint,
        decisions,
        model: run.model,
        provider: run.provider,
        ruleId: action.ruleId,
      })
      for (const item of decisions) decided.add(item.candidate.pairKey)
    }
    // 剩余候选（含"至少还有一个"的情形）留待下一轮；登记扫完只在本轮已穷尽时发生。
    result.pending += Math.max(0, candidates.length - MAX_CANDIDATES_PER_RUN)
    if (candidates.length > MAX_CANDIDATES_PER_RUN) continue
    options.store.dedupe.markScanned(
      action.fingerprint,
      entries.map((participant) => participant.input),
    )
  }
  return result
}

type DedupeParticipant = { entry: SemanticDuplicateEntry; input: ProcessingInput }

function dedupeParticipants(
  action: DedupeAction,
  publishedBySeq: Map<number, PublishedDecision>,
  overrides: Map<number, string>,
  sourceTitles: Map<string, string>,
): DedupeParticipant[] {
  const participants: DedupeParticipant[] = []
  for (const [seq, published] of publishedBySeq) {
    const { input, decision } = published
    if (!input.current || input.status !== "succeeded") continue
    // 显式例外与人工纠偏优先：这两种条目不再交给语义判重决定去留。
    if (decision.policy.standalone === "always" || decision.policy.standalone === "never") continue
    if (decision.status !== "keep") continue
    if ((overrides.get(seq) ?? "automatic") !== "automatic") continue
    if (!input.body.title) continue
    const context = decision.context
    if (matchConditions(action.when, context).state !== "match") continue
    if (matchConditions(action.scope, context).state !== "match") continue
    participants.push({
      entry: {
        description: truncateDedupeDescription(input.body.description),
        itemId: input.itemId,
        publishedAt: input.body.publishedAt,
        sourceTitle: sourceTitles.get(input.sourceKey) ?? input.sourceKey,
        title: input.body.title,
        urlHost: dedupeUrlHost(input.body.url),
      },
      input,
    })
  }
  return participants
}
