import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { ConditionSet, RuleSet } from "@follow/information-core"
import { compileInstructions, matchConditions } from "@follow/information-core"

import type { AIConfigStore } from "./ai-config"
import type { AutomationStore, ProcessingInput } from "./automation-store"
import type { CodexUsage, runCodexJson } from "./codex"
import { contentIdentity } from "./content-identity"
import type { Source } from "./folo"
import { processingRuleInput } from "./processing-context"
import type { ProcessingReadStateLookup } from "./processing-read-state"
import { inputReadState } from "./processing-read-state"
import type { ProcessingReadingStore } from "./processing-reading-store"
import type { ProcessingStateStore } from "./processing-state"
import type {
  SemanticDuplicateCandidate,
  SemanticDuplicateEntry,
  SemanticDuplicateEvaluation,
} from "./semantic-dedupe"
import {
  dedupeContentEvidence,
  dedupeUrlHost,
  evaluateSemanticDuplicateCandidates,
  getSemanticDuplicateCandidates,
  MAX_SEMANTIC_DUPLICATE_CANDIDATES,
  SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
  SEMANTIC_DUPLICATE_PROMPT_VERSION,
  semanticDuplicatePairKey,
  truncateDedupeDescription,
} from "./semantic-dedupe"
import { sourceText } from "./service"
import type { Store } from "./store"

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
  exact: boolean
  keep: ProcessingInput | null
  hide: ProcessingInput | null
  keepReference: boolean
}

const inputKey = (sourceKey: string, itemId: string) => `${sourceKey}\u0000${itemId}`

/**
 * 规则指纹只包含规则身份、触发条件、参与范围与提示词版本：正文之外的模型设置变化不追溯推翻既有
 * 判定，但用户改动去重规则会立刻让旧判定失效。
 */
export function dedupeConfigFingerprint(input: {
  ruleId: string
  scope: ConditionSet
  when: ConditionSet
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SEMANTIC_DUPLICATE_PROMPT_VERSION,
        ruleId: input.ruleId,
        scope: input.scope,
        when: input.when,
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
          fingerprint: dedupeConfigFingerprint({
            ruleId: rule.id,
            scope: action.scope,
            when: rule.when,
          }),
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
    // 旧行没有模型输入序号/代次，无法证明仍对应当前正文，迁移后自然失效并重算。
    for (const [table, columns] of [
      [
        "processing_dedupe_decisions",
        ["keep_input_seq", "keep_generation", "hide_input_seq", "hide_generation"],
      ],
      ["processing_dedupe_scans", ["input_seq", "generation"]],
    ] as const) {
      const existing = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => String(row.name)),
      )
      for (const column of columns)
        if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`)
    }
    // 已读参考可以没有发布决定，独立记录身份以免把待处理未读误当成有效保留侧。
    const columns = db.prepare("PRAGMA table_info(processing_dedupe_decisions)").all()
    if (!columns.some((row) => row.name === "keep_reference"))
      db.exec(
        "ALTER TABLE processing_dedupe_decisions ADD COLUMN keep_reference INTEGER NOT NULL DEFAULT 0",
      )
  }

  private currentInputs() {
    return new Map(this.inputs().map((input) => [inputKey(input.sourceKey, input.itemId), input]))
  }

  // 输入正文、序号、发布代次及状态必须同时相同，重算或换代期间拒绝晚到结果。
  private sameInput(
    current: ProcessingInput | undefined,
    expected: ProcessingInput,
    reference = false,
  ) {
    return Boolean(
      current?.current &&
      (current.status === "succeeded" || (reference && current.status === expected.status)) &&
      current.seq === expected.seq &&
      current.generation === expected.generation &&
      current.releaseVersion === expected.releaseVersion &&
      current.contentVersion === expected.contentVersion,
    )
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
      if (
        !keep?.current ||
        !hide?.current ||
        (keep.status !== "succeeded" && !row.keep_reference) ||
        hide.status !== "succeeded"
      )
        continue
      if (keep.seq !== Number(row.keep_input_seq) || hide.seq !== Number(row.hide_input_seq))
        continue
      if (
        keep.generation !== Number(row.keep_generation) ||
        hide.generation !== Number(row.hide_generation)
      )
        continue
      views.push({
        confidence: Number(row.confidence),
        exact: row.provider === "local" && row.model === "exact-content-v1",
        duplicate: Boolean(row.duplicate),
        hide: hide ?? null,
        keep: keep ?? null,
        keepReference: Boolean(row.keep_reference),
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

  /** 只有已保存且版本有效的精确肯定判定才能省略后续语义候选。 */
  exactPairKeys(fingerprints: ReadonlySet<string>): ReadonlySet<string> {
    return new Set(
      this.validDecisions(fingerprints)
        .filter(
          (item) =>
            item.exact &&
            item.duplicate &&
            item.confidence >= SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
        )
        .map((item) => item.pairKey),
    )
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
        keepReference: decision.keepReference,
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
      if (
        !input?.current ||
        input.status !== "succeeded" ||
        input.contentVersion !== String(row.content_version)
      )
        continue
      if (input.seq !== Number(row.input_seq) || input.generation !== Number(row.generation))
        continue
      settled.add(input.itemId)
    }
    return settled
  }

  /** 写入一批判定；正文、序号或代次换代期间到达的旧结果拒绝落库，也不能覆盖新判定。 */
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
      keepReference?: boolean
    }>
  }) {
    const saved = new Set<string>()
    if (input.decisions.length === 0) return saved
    const now = new Date().toISOString()
    const byKey = this.currentInputs()
    this.db.exec("SAVEPOINT dedupe_batch")
    try {
      const insert = this.db.prepare(
        `INSERT INTO processing_dedupe_decisions(
          pair_key,config_fingerprint,rule_id,provider,model,
          keep_source_key,keep_item_id,keep_content_version,
          hide_source_key,hide_item_id,hide_content_version,
          duplicate,confidence,reason,created_at,keep_input_seq,keep_generation,hide_input_seq,hide_generation,keep_reference
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(pair_key,config_fingerprint) DO UPDATE SET
          rule_id=excluded.rule_id,provider=excluded.provider,model=excluded.model,
          keep_source_key=excluded.keep_source_key,keep_item_id=excluded.keep_item_id,
          keep_content_version=excluded.keep_content_version,
          hide_source_key=excluded.hide_source_key,hide_item_id=excluded.hide_item_id,
          hide_content_version=excluded.hide_content_version,
          duplicate=excluded.duplicate,confidence=excluded.confidence,reason=excluded.reason,
          created_at=excluded.created_at,keep_input_seq=excluded.keep_input_seq,
          keep_generation=excluded.keep_generation,hide_input_seq=excluded.hide_input_seq,
          hide_generation=excluded.hide_generation,keep_reference=excluded.keep_reference`,
      )
      for (const item of input.decisions) {
        if (
          !this.sameInput(
            byKey.get(inputKey(item.keep.sourceKey, item.keep.itemId)),
            item.keep,
            item.keepReference,
          ) ||
          !this.sameInput(byKey.get(inputKey(item.hide.sourceKey, item.hide.itemId)), item.hide)
        )
          continue
        const { keep, hide } = item
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
          keep.seq,
          keep.generation,
          hide.seq,
          hide.generation,
          Number(item.keepReference ?? false),
        )
        saved.add(item.candidate.pairKey)
      }
      this.db.exec("RELEASE dedupe_batch")
    } catch (error) {
      this.db.exec("ROLLBACK TO dedupe_batch; RELEASE dedupe_batch")
      throw error
    }

    return saved
  }

  /** 登记"这些条目已完成整轮扫描且无可比对象"，下一轮不再重复预筛。 */
  markScanned(configFingerprint: string, inputs: ProcessingInput[]) {
    if (inputs.length === 0) return
    const now = new Date().toISOString()
    const byKey = this.currentInputs()
    this.db.exec("SAVEPOINT dedupe_scans")
    try {
      const insert = this.db.prepare(
        `INSERT INTO processing_dedupe_scans(source_key,item_id,content_version,config_fingerprint,created_at,input_seq,generation)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(source_key,item_id,config_fingerprint) DO UPDATE SET
           content_version=excluded.content_version,created_at=excluded.created_at,input_seq=excluded.input_seq,generation=excluded.generation`,
      )
      for (const item of inputs) {
        const current = byKey.get(inputKey(item.sourceKey, item.itemId))
        if (!this.sameInput(current, item)) continue
        insert.run(
          item.sourceKey,
          item.itemId,
          item.contentVersion,
          configFingerprint,
          now,
          item.seq,
          item.generation,
        )
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
  exactDuplicates: number
  /** 本轮预算用尽后仍未判定的候选对数；预算用尽时只知"还剩至少一对"，因此是下限。 */
  pending: number
  usage: CodexUsage
}

export type SemanticDedupeStore = {
  entry?: ProcessingReadStateLookup
  sourceSync?: Store["sourceSync"]
  subscriptionTags?: Store["subscriptionTags"]
  automation: AutomationStore
  processingState: ProcessingStateStore
  dedupe: ProcessingDedupeStore
  sources: () => Source[]
  reading: Pick<ProcessingReadingStore, "representedInputSeqs">
}

export type SemanticDedupePreparationOptions = {
  store: SemanticDedupeStore
  targets?: readonly { sourceKey: string; itemId: string }[]
  sourceKeys?: readonly string[]
  /** 同一任务的固定截止时间，已读参考仅接受此前 24 小时发布的缓存材料。 */
  cutoffAt?: string
  /** 单篇统一批次可在发布决定前用已冻结且完整的输入准备相同候选。 */
  pendingInputs?: readonly ProcessingInput[]
}

export type DedupeParticipant = {
  entry: SemanticDuplicateEntry
  input: ProcessingInput
  readReference: boolean
}

export type PreparedSemanticDedupe = {
  action: DedupeAction
  participants: DedupeParticipant[]
  targetItemIds: ReadonlySet<string>
  candidates: SemanticDuplicateCandidate[]
}

export type PreparedDedupeEvaluation = {
  configFingerprint: string
  pairKey: string
  evaluation: SemanticDuplicateEvaluation
  model: string
  provider: string
  inputs: readonly Pick<
    ProcessingInput,
    "seq" | "generation" | "contentVersion" | "sourceKey" | "itemId"
  >[]
}

/** 单篇处理和角色发布共用预筛，避免两条管线对同一对原文分别调用模型。 */
export function prepareSemanticDedupe(
  options: SemanticDedupePreparationOptions,
): PreparedSemanticDedupe[] {
  const releases = options.store.automation.releases()
  const latest = releases.length > 0 ? options.store.automation.release(releases[0]!.version) : null
  const actions = activeDedupeActions(latest)
  if (!latest || actions.length === 0) return []
  const published = new Map(
    options.store.processingState.published().map((item) => [item.input.seq, item]),
  )
  const overrides = new Map(
    options.store.processingState.overrides().map((item) => [item.inputSeq, item.mode]),
  )
  const sources = new Map(options.store.sources().map((source) => [source.key, source]))
  const represented = options.store.reading.representedInputSeqs()
  const pending = new Set(options.pendingInputs?.map((input) => input.seq))
  const scopedSources = options.sourceKeys === undefined ? null : new Set(options.sourceKeys)
  const cutoff = Date.parse(options.cutoffAt ?? new Date().toISOString())
  const currentEntry = options.store.entry?.bind(options.store)
  const contextStore =
    options.store.sourceSync && options.store.subscriptionTags
      ? {
          sourceSync: options.store.sourceSync,
          subscriptionTags: options.store.subscriptionTags,
          sources: options.store.sources.bind(options.store),
        }
      : null
  return actions.map((action) => {
    const participants: DedupeParticipant[] = []
    for (const input of options.store.automation.inputs()) {
      const source = sources.get(input.sourceKey)
      if (!input.current || !source || represented.has(input.seq)) continue
      if (scopedSources && !scopedSources.has(input.sourceKey)) continue
      if ((overrides.get(input.seq) ?? "automatic") !== "automatic" || !input.body.title) continue
      const read = inputReadState(input, currentEntry)
      if (read === null) continue
      const readReference = read === true
      const at = Date.parse(input.body.publishedAt)
      if (
        readReference &&
        (!Number.isFinite(cutoff) ||
          !Number.isFinite(at) ||
          at > cutoff ||
          at < cutoff - 24 * 60 * 60 * 1000)
      )
        continue
      const decision = published.get(input.seq)?.decision
      if (decision && (decision.status !== "keep" || decision.policy.standalone !== "auto"))
        continue
      if (!readReference && !decision && !pending.has(input.seq)) continue
      // 参考只读已有完整缓存，不获取详情、不补读正文，也不领取或发布已读输入。
      if (
        (readReference || !decision) &&
        options.store.processingState.material(input) !== "complete"
      )
        continue
      let context = decision?.context
      if (!context) {
        if (!contextStore) continue
        const text = sourceText(input.body.content ?? "")
        if (!text) continue
        context = processingRuleInput(contextStore, input.sourceKey, input.body, text, true)
      }
      // 已读仅作为范围参考，日常未读触发条件不应阻断同一范围内的历史事实核对。
      const matchContext = readReference ? { ...context, read: false } : context
      const instructions = compileInstructions(latest, matchContext)
      if (
        instructions.blocksFinalPresentation ||
        (instructions.policy.standalone && instructions.policy.standalone !== "auto")
      )
        continue
      if (
        matchConditions(action.when, matchContext).state !== "match" ||
        matchConditions(action.scope, matchContext).state !== "match"
      )
        continue
      const evidence = dedupeContentEvidence(input.body.content)
      if (readReference && !evidence.contentComplete) continue
      participants.push({
        entry: {
          ...evidence,
          description: truncateDedupeDescription(input.body.description),
          itemId: input.itemId,
          publishedAt: input.body.publishedAt,
          sourceTitle: source.title,
          title: input.body.title,
          urlHost: dedupeUrlHost(input.body.url),
        },
        input,
        readReference,
      })
    }
    const targetItemIds = new Set(
      participants
        .filter(
          (participant) =>
            !participant.readReference &&
            (options.targets === undefined ||
              options.targets.some(
                (target) =>
                  target.sourceKey === participant.input.sourceKey &&
                  target.itemId === participant.input.itemId,
              )),
        )
        .map((participant) => participant.input.itemId),
    )
    const fingerprints = new Set([action.fingerprint])
    const candidates = dedupeCandidates(
      participants,
      targetItemIds,
      options.store.dedupe.decidedPairKeys(fingerprints),
      options.store.dedupe.settledItemIds(fingerprints),
    )
    return { action, candidates, participants, targetItemIds }
  })
}

function dedupeCandidates(
  participants: DedupeParticipant[],
  targets: ReadonlySet<string>,
  decided: ReadonlySet<string>,
  settled?: ReadonlySet<string>,
) {
  return getSemanticDuplicateCandidates(
    participants.map((participant) => participant.entry),
    {
      decidedPairKeys: decided,
      maxCandidates: MAX_CANDIDATES_PER_RUN + 1,
      // 旧未读条目可能已登记扫描，变为已读参考后必须允许新材料重新核对。
      settledItemIds: participants.some((participant) => participant.readReference)
        ? undefined
        : settled,
      // 至少一侧是当前未读目标，在预筛额度之前排除所有已读之间的比较。
      targetItemIds: targets,
    },
  )
}

/** 发布已有统一批次的判定；未提供统一结果时仍支持独立的去重执行。 */
export async function runSemanticDedupe(
  options: SemanticDedupePreparationOptions & {
    aiConfig: AIConfigStore
    runtimeDir: string
    signal: AbortSignal
    execute?: typeof runCodexJson
    /** 先消费统一批次已有结果，缺失或换代的候选仍按正常预算判定。 */
    preparedEvaluations?: readonly PreparedDedupeEvaluation[]
    /** 单篇批次内部可只发布已有结果，把其他候选留给任务尾部。 */
    preparedOnly?: boolean
  },
): Promise<SemanticDedupeRunResult> {
  const result: SemanticDedupeRunResult = {
    batches: 0,
    candidates: 0,
    duplicates: 0,
    exactDuplicates: 0,
    pending: 0,
    usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
  }
  for (const plan of prepareSemanticDedupe(options)) {
    const { action, participants, targetItemIds } = plan
    if (options.signal.aborted) break
    const fingerprints = new Set([action.fingerprint])
    const decided = options.store.dedupe.decidedPairKeys(fingerprints)
    const settled = options.store.dedupe.settledItemIds(fingerprints)
    if (targetItemIds?.size === 0 || participants.length < 2) continue
    const entries = [...participants].sort(
      (left, right) =>
        Date.parse(right.input.body.publishedAt) - Date.parse(left.input.body.publishedAt),
    )
    // 严格同一原文先本地判定；仅记录关系，所有来源和正文仍保存在原表中。
    const exact = exactDuplicateDecisions(entries)
    const exactSaved = options.store.dedupe.saveBatch({
      configFingerprint: action.fingerprint,
      ruleId: action.ruleId,
      provider: "local",
      model: "exact-content-v1",
      decisions: exact.filter(
        (item) =>
          !decided.has(item.candidate.pairKey) &&
          (!targetItemIds ||
            targetItemIds.has(item.keep.itemId) ||
            targetItemIds.has(item.hide.itemId)),
      ),
    })
    result.duplicates += exactSaved.size
    result.exactDuplicates += exactSaved.size
    for (const pairKey of exactSaved) decided.add(pairKey)
    const validExact = options.store.dedupe.exactPairKeys(fingerprints)
    const exactHidden = new Set(
      exact
        .filter((item) => validExact.has(item.candidate.pairKey))
        .map((item) => item.hide.itemId),
    )
    const semanticEntries = entries.filter((item) => !exactHidden.has(item.input.itemId))
    const candidates = dedupeCandidates(semanticEntries, targetItemIds, decided, settled)
    result.candidates += candidates.length
    if (candidates.length === 0) {
      // 只有整轮确实无可比对象才算"扫完"，否则留待下一轮继续消化剩余候选。
      options.store.dedupe.markScanned(
        action.fingerprint,
        entries
          .filter((participant) => !targetItemIds || targetItemIds.has(participant.input.itemId))
          .map((participant) => participant.input),
      )
      continue
    }
    const entryByItemId = new Map(
      entries.map((participant) => [participant.entry.itemId, participant]),
    )
    for (
      let offset = 0;
      offset < candidates.length &&
      offset < MAX_CANDIDATES_PER_RUN &&
      result.batches < MAX_BATCHES_PER_RUN;
      offset += MAX_SEMANTIC_DUPLICATE_CANDIDATES
    ) {
      if (options.signal.aborted) break
      const slice = candidates.slice(
        offset,
        Math.min(offset + MAX_SEMANTIC_DUPLICATE_CANDIDATES, MAX_CANDIDATES_PER_RUN),
      )
      const cached = options.preparedEvaluations?.filter(
        (item) =>
          item.configFingerprint === action.fingerprint &&
          item.pairKey === item.evaluation.pairKey &&
          slice.some(
            (candidate) =>
              candidate.pairKey === item.pairKey &&
              candidate.entries.every((entry) => {
                const participant = entryByItemId.get(entry.itemId)
                return (
                  participant &&
                  item.inputs.some(
                    (expected) =>
                      expected.seq === participant.input.seq &&
                      expected.generation === participant.input.generation &&
                      expected.contentVersion === participant.input.contentVersion &&
                      expected.sourceKey === participant.input.sourceKey &&
                      expected.itemId === participant.input.itemId,
                  )
                )
              }),
          ),
      )
      const cachedKeys = new Set(cached?.map((item) => item.pairKey))
      const missing = slice.filter((item) => !cachedKeys.has(item.pairKey))
      const config =
        missing.length > 0 && !options.preparedOnly ? await options.aiConfig.read() : null
      const run = config
        ? await evaluateSemanticDuplicateCandidates({
            aiConfig: config,
            candidates: missing,
            execute: options.execute,
            qianwen: await options.aiConfig.execution(config),
            runtimeDir: options.runtimeDir,
            signal: options.signal,
          })
        : {
            executed: false,
            usage: null,
            evaluations: [] as SemanticDuplicateEvaluation[],
            model: cached?.[0]?.model ?? "unified-entry-batch",
            provider: cached?.[0]?.provider ?? "local",
          }
      result.batches += Number(run.executed)
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
        keepReference?: boolean
        model: string
        provider: string
      }> = []
      for (const evaluation of [
        ...(cached ?? []).map((item) => item.evaluation),
        ...run.evaluations,
      ]) {
        const candidate = slice.find((item) => item.pairKey === evaluation.pairKey)
        if (!candidate) continue
        // 判定失效前先确认两侧仍在当前库中：正文换代期间到达的结果不再落库。
        let keep = entryByItemId.get(evaluation.keepEntryId ?? candidate.keepEntryId)
        let hide = entryByItemId.get(evaluation.hideEntryId ?? candidate.testEntryId)
        if (!keep || !hide || keep.input.seq === hide.input.seq) continue
        if (
          ![keep, hide].every((participant) =>
            candidate.entries.some((entry) => entry.itemId === participant.entry.itemId),
          )
        )
          continue
        // 调用期间读态改变时拒绝晚到结果，不能把刚读过的条目继续当作可隐藏未读。
        if (
          ![keep, hide].every(
            (participant) =>
              inputReadState(participant.input, options.store.entry?.bind(options.store)) ===
              participant.readReference,
          )
        )
          continue
        let resolved = evaluation
        if (
          evaluation.duplicate &&
          !candidate.entries.every(
            (entry) => entry.contentComplete === true && Boolean(entry.content?.trim()),
          )
        )
          resolved = { ...evaluation, duplicate: false, keepEntryId: null, hideEntryId: null }
        // 等价优先保留已读参考；未读有补充事实时只保存否定，永远不隐藏已读。
        if (resolved.duplicate && (keep.readReference || hide.readReference)) {
          if (evaluation.verdict === "equivalent" && hide.readReference) [keep, hide] = [hide, keep]
          if (hide.readReference)
            resolved = {
              ...evaluation,
              duplicate: false,
              keepEntryId: null,
              hideEntryId: null,
              reason: "未读报道包含补充事实，保留原文与已读参考。",
            }
          else
            resolved = {
              ...evaluation,
              keepEntryId: keep.entry.itemId,
              hideEntryId: hide.entry.itemId,
            }
        }
        // 否定关系也把只读参考存为保留侧，避免要求它具备不存在的成功发布状态。
        if (!resolved.duplicate && hide.readReference) [keep, hide] = [hide, keep]
        decisions.push({
          candidate,
          evaluation: resolved,
          hide: hide.input,
          keep: keep.input,
          keepReference: keep.readReference,
          model: cached?.find((item) => item.pairKey === evaluation.pairKey)?.model ?? run.model,
          provider:
            cached?.find((item) => item.pairKey === evaluation.pairKey)?.provider ?? run.provider,
        })
      }
      // 统一批次和补充比较可能使用不同模型，来源按原结果逐组保存。
      const groups = new Map<string, typeof decisions>()
      for (const item of decisions) {
        const key = `${item.provider}\u0000${item.model}`
        const group = groups.get(key) ?? []
        group.push(item)
        groups.set(key, group)
      }
      const saved = new Set<string>()
      for (const group of groups.values()) {
        for (const pairKey of options.store.dedupe.saveBatch({
          configFingerprint: action.fingerprint,
          decisions: group,
          model: group[0]!.model,
          provider: group[0]!.provider,
          ruleId: action.ruleId,
        }))
          saved.add(pairKey)
      }
      // 用实际接受的结果计数，换代丢弃的晚到肯定不能报告成新增合并。
      result.duplicates += decisions.filter(
        (item) =>
          saved.has(item.candidate.pairKey) &&
          item.evaluation.duplicate &&
          item.evaluation.confidence >= SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
      ).length
      for (const pairKey of saved) decided.add(pairKey)
    }
    // 每条一轮仅取一对；判完本批后重新预筛，三篇两对否定不能误认第三对已穷尽。
    const remaining = dedupeCandidates(semanticEntries, targetItemIds, decided)
    result.pending += remaining.length
    if (remaining.length === 0 && !options.signal.aborted)
      options.store.dedupe.markScanned(
        action.fingerprint,
        entries
          .filter((item) => !targetItemIds || targetItemIds.has(item.input.itemId))
          .map((item) => item.input),
      )
  }
  return result
}

/** 最小安全精确层：深链身份一致且正文一致，或跨 URL 的充分长度完整正文逐字一致。 */
export function exactDuplicateDecisions(participants: DedupeParticipant[]) {
  const groups = new Map<string, DedupeParticipant[]>()
  for (const participant of participants) {
    // 不删标点、不转小写、不截断、不剥离 HTML，避免把观点、数字或正文尾部变化折叠。
    const body = participant.input.body.content?.trim()
    if (!body) continue
    const identity = contentIdentity(participant.input.body)
    const bodyFingerprint = createHash("sha256").update(body).digest("hex")
    const key =
      body.length >= 80 ? `body:${bodyFingerprint}` : `${identity}\u0000${bodyFingerprint}`
    const group = groups.get(key)
    if (group) group.push(participant)
    else groups.set(key, [participant])
  }
  return [...groups.values()].flatMap((group) => {
    const ordered = group.sort(
      (left, right) =>
        Number(right.readReference) - Number(left.readReference) ||
        Date.parse(left.input.body.publishedAt) - Date.parse(right.input.body.publishedAt),
    )
    const keep = ordered[0]!
    return ordered
      .slice(1)
      .filter((hide) => !hide.readReference && hide.input.itemId !== keep.input.itemId)
      .map((hide) => ({
        candidate: {
          entries: [keep.entry, hide.entry] as [SemanticDuplicateEntry, SemanticDuplicateEntry],
          keepEntryId: keep.entry.itemId,
          testEntryId: hide.entry.itemId,
          similarity: 1,
          pairKey: semanticDuplicatePairKey(keep.entry.itemId, hide.entry.itemId),
        },
        evaluation: {
          pairKey: semanticDuplicatePairKey(keep.entry.itemId, hide.entry.itemId),
          duplicate: true,
          confidence: 1,
          keepEntryId: keep.entry.itemId,
          hideEntryId: hide.entry.itemId,
          reason: "严格相同原文，保留全部来源与正文。",
        },
        keep: keep.input,
        keepReference: keep.readReference,
        hide: hide.input,
      }))
  })
}
