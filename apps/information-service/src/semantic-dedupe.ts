import { z } from "zod"

import type { AIConfig } from "./ai-config"
import type { CodexUsage } from "./codex"
import { runCodexJson } from "./codex"

/**
 * 跨来源同事件判重（服务端）。
 *
 * 客户端 `packages/internal/store/src/modules/entry/semantic-dedupe.ts` 只能在渲染层
 * 已加载的条目上工作，且依赖 localhost localStorage 与 Electron IPC 执行器。这里把同一套
 * 口径搬到处理服务：候选预筛阈值、48 小时窗口、模型置信阈值全部保持一致，差别只在
 * 输入来自服务端的全部 current input，执行器走处理服务自己的模型配置。
 */
export const SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD = 0.85
export const SEMANTIC_DUPLICATE_PROMPT_VERSION = 1
export const MAX_SEMANTIC_DUPLICATE_CANDIDATES = 8

const CANDIDATE_TIME_WINDOW = 48 * 60 * 60 * 1000
const MAX_DESCRIPTION_LENGTH = 400
const MIN_TITLE_SIMILARITY = 0.42
const MIN_CONTEXT_SIMILARITY = 0.32

/** 模型只看到这些字段；正文不进提示词，判重依据与客户端一致。 */
export type SemanticDuplicateEntry = {
  itemId: string
  title: string
  sourceTitle: string
  description: string
  publishedAt: string
  urlHost: string
}
export type SemanticDuplicateCandidate = {
  pairKey: string
  /** 默认保留较旧的一条；模型可以推翻。 */
  keepEntryId: string
  testEntryId: string
  similarity: number
  entries: [SemanticDuplicateEntry, SemanticDuplicateEntry]
}
export type SemanticDuplicateEvaluation = {
  pairKey: string
  duplicate: boolean
  confidence: number
  keepEntryId: string | null
  hideEntryId: string | null
  reason: string | null
}
export type SemanticDuplicateRun = {
  candidates: SemanticDuplicateCandidate[]
  evaluations: SemanticDuplicateEvaluation[]
  model: string
  provider: AIConfig["provider"]
  usage: CodexUsage | null
  durationMs: number
}

export const semanticDuplicateOutputSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            pairKey: z.string().min(1).max(600),
            duplicate: z.boolean(),
            confidence: z.number().min(0).max(1),
            keepEntryId: z.string().min(1).max(300).nullable(),
            hideEntryId: z.string().min(1).max(300).nullable(),
            reason: z.string().min(1).max(2000).nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
export type SemanticDuplicateModelOutput = z.infer<typeof semanticDuplicateOutputSchema>

export function semanticDuplicatePairKey(left: string, right: string) {
  return [left, right].sort().join("::")
}

// 与渲染层的 getEntryTitleDedupeKey 保持同一归一化，避免两侧对同一标题给出不同相似度。
export function normalizeDedupeText(value: string | null | undefined) {
  const normalized = value
    ?.trim()
    .replaceAll(/\p{P}+/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase()
  return normalized || null
}

export function truncateDedupeDescription(description: string | null | undefined) {
  return (description ?? "").replaceAll(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH)
}

export function dedupeUrlHost(...urls: Array<string | null | undefined>) {
  for (const url of urls) {
    if (!url) continue
    try {
      return new URL(url).host
    } catch {
      continue
    }
  }
  return ""
}

function bigramSet(text: string) {
  const normalized = normalizeDedupeText(text)?.replaceAll(/\s+/g, "") ?? ""
  const grams = new Set<string>()
  if (normalized.length <= 1) {
    if (normalized) grams.add(normalized)
    return grams
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2))
  }
  return grams
}

function diceSimilarityWith(gramsOf: (text: string) => Set<string>, textA: string, textB: string) {
  const gramsA = gramsOf(textA)
  const gramsB = gramsOf(textB)
  if (gramsA.size === 0 || gramsB.size === 0) return 0
  let intersection = 0
  for (const gram of gramsA) if (gramsB.has(gram)) intersection += 1
  return (2 * intersection) / (gramsA.size + gramsB.size)
}

const comparableText = (entry: Pick<SemanticDuplicateEntry, "description" | "title">) =>
  `${entry.title} ${entry.description}`.trim()

export function isWithinDedupeWindow(leftAt: number, rightAt: number) {
  return (
    Number.isFinite(leftAt) &&
    Number.isFinite(rightAt) &&
    Math.abs(leftAt - rightAt) <= CANDIDATE_TIME_WINDOW
  )
}

/**
 * 预筛候选对。
 *
 * 条目按发布时间从新到旧排序后两两比较，内层循环一旦超出 48 小时窗口就结束，因此代价
 * 与"每个时间窗口内的条目数"相关，而不是全库条数的平方。默认保留较旧的一条，与客户端
 * "entry ids are passed in timeline order" 的约定一致。`decidedPairKeys` 是仍然有效的既有
 * 判定，`settledItemIds` 是已完成整轮扫描且无可比对象的条目，两者都被跳过。
 */
export function getSemanticDuplicateCandidates(
  entries: SemanticDuplicateEntry[],
  options: {
    maxCandidates?: number
    decidedPairKeys?: ReadonlySet<string>
    settledItemIds?: ReadonlySet<string>
  } = {},
): SemanticDuplicateCandidate[] {
  const gramsCache = new Map<string, Set<string>>()
  const gramsOf = (text: string) => {
    let grams = gramsCache.get(text)
    if (!grams) {
      grams = bigramSet(text)
      gramsCache.set(text, grams)
    }
    return grams
  }
  const ordered = entries
    .map((entry) => ({ at: Date.parse(entry.publishedAt), entry }))
    .filter((item) => Number.isFinite(item.at))
    .sort((left, right) => right.at - left.at)
  const candidates: Array<SemanticDuplicateCandidate & { index: number }> = []
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex]!
      // 时间已按从新到旧排序，越界之后的对只会更远。
      if (!isWithinDedupeWindow(left.at, right.at)) break
      const pairKey = semanticDuplicatePairKey(left.entry.itemId, right.entry.itemId)
      if (options.decidedPairKeys?.has(pairKey)) continue
      if (
        options.settledItemIds?.has(left.entry.itemId) &&
        options.settledItemIds?.has(right.entry.itemId)
      )
        continue
      const titleSimilarity = diceSimilarityWith(gramsOf, left.entry.title, right.entry.title)
      const contextSimilarity = diceSimilarityWith(
        gramsOf,
        comparableText(left.entry),
        comparableText(right.entry),
      )
      const similarity = Math.max(titleSimilarity, contextSimilarity)
      if (titleSimilarity < MIN_TITLE_SIMILARITY && contextSimilarity < MIN_CONTEXT_SIMILARITY)
        continue
      candidates.push({
        entries: [left.entry, right.entry],
        index: leftIndex,
        keepEntryId: right.entry.itemId,
        pairKey,
        similarity,
        testEntryId: left.entry.itemId,
      })
    }
  }
  const selectedTestEntryIds = new Set<string>()
  return candidates
    .sort((left, right) => {
      if (left.index !== right.index) return left.index - right.index
      if (right.similarity !== left.similarity) return right.similarity - left.similarity
      return left.testEntryId.localeCompare(right.testEntryId)
    })
    .filter((candidate) => {
      // 每个"待判"条目一轮只占用一个名额，避免同一篇对多条旧文重复付费。
      if (selectedTestEntryIds.has(candidate.testEntryId)) return false
      selectedTestEntryIds.add(candidate.testEntryId)
      return true
    })
    .slice(0, options.maxCandidates ?? MAX_SEMANTIC_DUPLICATE_CANDIDATES)
}

export function createSemanticDuplicatePrompt(candidates: SemanticDuplicateCandidate[]) {
  return `你是严格的重复新闻分类器。判断每一对候选是否描述同一个核心事件。

规则：
- 只有当两条条目描述同一个核心事件、同一组主体、同一组事实与同一结论时，才返回 duplicate=true。
- 只是同一话题、后一条是后续进展、数字不同、时间窗口不同、关键事实有变化时，返回 duplicate=false。
- sourceTitle 和 urlHost 只是辅助上下文，不能单独作为判重依据。
- 除非另一条明显更完整或明显更好，否则默认保留 keepEntryId。
- 只使用 title 与 description，不要推断未出现的事实。
- 保守优先：不确定就 duplicate=false，或让 confidence 低于 0.85。

只返回符合 schema 的 JSON。

候选：
${JSON.stringify({ candidates }, null, 2)}
`
}

function normalizeEvaluation(
  candidateByPairKey: Map<string, SemanticDuplicateCandidate>,
  evaluation: SemanticDuplicateModelOutput["results"][number],
): SemanticDuplicateEvaluation | null {
  const candidate = candidateByPairKey.get(evaluation.pairKey)
  if (!candidate) return null
  const confidence = Math.max(0, Math.min(1, Number(evaluation.confidence)))
  if (!Number.isFinite(confidence)) return null
  // 模型只能在这两条之间选择保留哪一条；越界或缺失一律回到候选的默认方向。
  const keepEntryId =
    evaluation.duplicate && evaluation.keepEntryId ? evaluation.keepEntryId : candidate.keepEntryId
  const hideEntryId =
    evaluation.duplicate && evaluation.hideEntryId ? evaluation.hideEntryId : candidate.testEntryId
  const validKeepEntryId =
    keepEntryId === candidate.keepEntryId || keepEntryId === candidate.testEntryId
      ? keepEntryId
      : candidate.keepEntryId
  const validHideEntryId =
    hideEntryId === candidate.keepEntryId || hideEntryId === candidate.testEntryId
      ? hideEntryId
      : candidate.testEntryId
  // 保留与隐藏落在同一条时判定自相矛盾，按未去重处理。
  const consistent = validKeepEntryId !== validHideEntryId
  return {
    confidence,
    duplicate: evaluation.duplicate && consistent,
    hideEntryId: evaluation.duplicate && consistent ? validHideEntryId : null,
    keepEntryId: evaluation.duplicate && consistent ? validKeepEntryId : null,
    pairKey: evaluation.pairKey,
    reason: evaluation.reason,
  }
}

const fallbackEvaluation = (
  candidate: SemanticDuplicateCandidate,
): SemanticDuplicateEvaluation => ({
  confidence: 0,
  duplicate: false,
  hideEntryId: null,
  keepEntryId: null,
  pairKey: candidate.pairKey,
  reason: "模型未返回该候选的判定。",
})

export async function evaluateSemanticDuplicateCandidates(input: {
  candidates: SemanticDuplicateCandidate[]
  aiConfig: AIConfig
  runtimeDir: string
  signal: AbortSignal
  qianwen?: { apiKey: string }
  execute?: typeof runCodexJson
}): Promise<Omit<SemanticDuplicateRun, "candidates">> {
  const candidates = input.candidates.slice(0, MAX_SEMANTIC_DUPLICATE_CANDIDATES)
  if (candidates.length === 0)
    return {
      durationMs: 0,
      evaluations: [],
      model: input.aiConfig.model,
      provider: input.aiConfig.provider,
      usage: null,
    }
  const execute = input.execute ?? runCodexJson
  const response = await execute({
    purpose: "dedupe",
    prompt: createSemanticDuplicatePrompt(candidates),
    schema: z.toJSONSchema(semanticDuplicateOutputSchema),
    validate: (value): value is SemanticDuplicateModelOutput =>
      semanticDuplicateOutputSchema.safeParse(value).success,
    model: input.aiConfig.model,
    reasoningEffort: "low",
    runtimeDir: input.runtimeDir,
    signal: input.signal,
    qianwen: input.qianwen,
  })
  const candidateByPairKey = new Map(candidates.map((candidate) => [candidate.pairKey, candidate]))
  const evaluationByPairKey = new Map(
    response.result.results
      .map((evaluation) => normalizeEvaluation(candidateByPairKey, evaluation))
      .filter((evaluation): evaluation is SemanticDuplicateEvaluation => !!evaluation)
      .map((evaluation) => [evaluation.pairKey, evaluation]),
  )
  return {
    durationMs: response.durationMs,
    // 缺失的候选写入否定判定：同一对不会因为模型漏答而在下一轮重复付费。
    evaluations: candidates.map(
      (candidate) => evaluationByPairKey.get(candidate.pairKey) ?? fallbackEvaluation(candidate),
    ),
    model: input.aiConfig.model,
    provider: input.aiConfig.provider,
    usage: response.usage,
  }
}
