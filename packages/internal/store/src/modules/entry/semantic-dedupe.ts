import { useEffect, useMemo } from "react"

import { createImmerSetter, createZustandStore } from "../../lib/helper"
import { getFeedById } from "../feed/getter"
import { getSubscriptionByEntryId } from "../subscription/getter"
import { getEntry } from "./getter"
import type { EntryModel } from "./types"
import { getEntryTitleDedupeKey } from "./utils"

export const SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD = 0.85

const STORAGE_PREFIX = "follow:semantic-dedupe:v1"
const CANDIDATE_TIME_WINDOW = 48 * 60 * 60 * 1000
const MAX_CANDIDATES_PER_RUN = 16
const MAX_DESCRIPTION_LENGTH = 800
const MIN_TITLE_SIMILARITY = 0.42
const MIN_CONTEXT_SIMILARITY = 0.32

export interface SemanticDuplicateEntryContext {
  id: string
  title: string
  feedTitle: string
  description: string
  publishedAt: string
  urlHost: string
}

export interface SemanticDuplicateCandidate {
  pairKey: string
  keepEntryId: string
  testEntryId: string
  similarity: number
  entries: [SemanticDuplicateEntryContext, SemanticDuplicateEntryContext]
}

export interface SemanticDuplicateEvaluation {
  pairKey: string
  duplicate: boolean
  confidence: number
  keepEntryId?: string | null
  hideEntryId?: string | null
  reason?: string | null
}

export type SemanticDuplicateEvaluator = (
  candidates: SemanticDuplicateCandidate[],
) => Promise<SemanticDuplicateEvaluation[]>

export type SemanticDuplicateEvaluatorSource = "custom" | "dev-server" | "electron" | "none"

export interface SemanticDuplicateDecision extends SemanticDuplicateEvaluation {
  entryIds: [string, string]
  updatedAt: string
}

export type SemanticDuplicateEntryRole = "duplicate" | "keeper" | null

export interface SemanticDedupeEvaluatorRunInfo {
  candidateCount: number
  command: string | null
  durationMs: number | null
  fallbackUsed: boolean
  inputCandidateCount: number
  reasoningEffort: string | null
  requestedModel: string | null
  usedModel: string | null
}

export interface SemanticDedupeDebugRecentCandidate {
  pairKey: string
  similarity: number
  titles: [string, string]
}

export interface SemanticDedupeDebugRecentEvaluation {
  confidence: number
  duplicate: boolean
  pairKey: string
  reason: string | null
}

interface SemanticDedupeDebugState {
  evaluatorSource: SemanticDuplicateEvaluatorSource
  isProcessing: boolean
  lastCandidateCount: number
  lastDuplicateCount: number
  lastError: string | null
  lastQueuedAt: string | null
  lastEvaluationCount: number
  lastRunDurationMs: number | null
  lastRunFinishedAt: string | null
  lastRunStartedAt: string | null
  lastScanAt: string | null
  lastScannedEntryCount: number
  lastEvaluatorRun: SemanticDedupeEvaluatorRunInfo | null
  queuedEntryCount: number
  recentCandidates: SemanticDedupeDebugRecentCandidate[]
  recentEvaluations: SemanticDedupeDebugRecentEvaluation[]
  totalErrors: number
  totalRuns: number
}

interface SemanticDedupeStore {
  debug: SemanticDedupeDebugState
  decisions: Record<string, SemanticDuplicateDecision>
  isHydrated: boolean
  ownerKey: string | null
  pendingPairKeys: Record<string, true>
  revision: number
}

const createDefaultDebugState = (): SemanticDedupeDebugState => ({
  evaluatorSource: "none",
  isProcessing: false,
  lastCandidateCount: 0,
  lastDuplicateCount: 0,
  lastError: null,
  lastQueuedAt: null,
  lastEvaluationCount: 0,
  lastRunDurationMs: null,
  lastRunFinishedAt: null,
  lastRunStartedAt: null,
  lastScanAt: null,
  lastScannedEntryCount: 0,
  lastEvaluatorRun: null,
  queuedEntryCount: 0,
  recentCandidates: [],
  recentEvaluations: [],
  totalErrors: 0,
  totalRuns: 0,
})

const defaultState: SemanticDedupeStore = {
  debug: createDefaultDebugState(),
  decisions: {},
  isHydrated: false,
  ownerKey: null,
  pendingPairKeys: {},
  revision: 0,
}

const getLocalStorage = () => {
  if (typeof window === "undefined") return null
  return window.localStorage
}

const getStorageKey = (ownerKey: string) => `${STORAGE_PREFIX}:${ownerKey}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeDecision = (value: unknown): SemanticDuplicateDecision | null => {
  if (!isRecord(value)) return null
  if (typeof value.pairKey !== "string") return null
  if (!Array.isArray(value.entryIds) || value.entryIds.length !== 2) return null
  if (typeof value.entryIds[0] !== "string" || typeof value.entryIds[1] !== "string") return null
  if (typeof value.duplicate !== "boolean") return null
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) return null

  return {
    confidence: Math.max(0, Math.min(1, value.confidence)),
    duplicate: value.duplicate,
    entryIds: [value.entryIds[0], value.entryIds[1]],
    hideEntryId: typeof value.hideEntryId === "string" ? value.hideEntryId : null,
    keepEntryId: typeof value.keepEntryId === "string" ? value.keepEntryId : null,
    pairKey: value.pairKey,
    reason: typeof value.reason === "string" ? value.reason : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  }
}

const readDecisionsFromStorage = (ownerKey: string): Record<string, SemanticDuplicateDecision> => {
  const storage = getLocalStorage()
  if (!storage) return {}

  const raw = storage.getItem(getStorageKey(ownerKey))
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    const decisions = isRecord(parsed) ? parsed.decisions : parsed
    if (!isRecord(decisions)) return {}

    return Object.fromEntries(
      Object.entries(decisions)
        .map(([key, decision]) => [key, normalizeDecision(decision)] as const)
        .filter((entry): entry is readonly [string, SemanticDuplicateDecision] => !!entry[1]),
    )
  } catch {
    return {}
  }
}

const writeDecisionsToStorage = (
  ownerKey: string,
  decisions: Record<string, SemanticDuplicateDecision>,
) => {
  const storage = getLocalStorage()
  if (!storage) return

  storage.setItem(
    getStorageKey(ownerKey),
    JSON.stringify({
      decisions,
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
  )
}

export const useSemanticDedupeStore = createZustandStore<SemanticDedupeStore>("semantic-dedupe")(
  () => defaultState,
)

const set = createImmerSetter(useSemanticDedupeStore)

let semanticDuplicateEvaluator: SemanticDuplicateEvaluator | null = null
let isProcessingCandidates = false
let queuedEntryIds: string[] | null = null
let lastFailedEntryIdsKey: string | null = null

const hasSemanticDuplicateEvaluator = () => semanticDuplicateEvaluator !== null

export const registerSemanticDuplicateEvaluator = (
  evaluator: SemanticDuplicateEvaluator | null,
  source: SemanticDuplicateEvaluatorSource = evaluator ? "custom" : "none",
) => {
  semanticDuplicateEvaluator = evaluator
  lastFailedEntryIdsKey = null
  if (!evaluator) {
    queuedEntryIds = null
  }
  set((state) => {
    state.debug.evaluatorSource = evaluator ? source : "none"
    state.debug.lastEvaluatorRun = evaluator ? state.debug.lastEvaluatorRun : null
    state.debug.queuedEntryCount = evaluator ? state.debug.queuedEntryCount : 0
    state.revision += 1
  })

  return () => {
    if (semanticDuplicateEvaluator === evaluator) {
      semanticDuplicateEvaluator = null
      queuedEntryIds = null
      set((state) => {
        state.debug.evaluatorSource = "none"
        state.debug.lastEvaluatorRun = null
        state.debug.queuedEntryCount = 0
        state.revision += 1
      })
    }
  }
}

export const semanticDedupeActions = {
  hydrate: (ownerKey: string | undefined) => {
    queuedEntryIds = null
    lastFailedEntryIdsKey = null
    set((state) => {
      state.ownerKey = ownerKey ?? null
      state.decisions = ownerKey ? readDecisionsFromStorage(ownerKey) : {}
      state.pendingPairKeys = {}
      state.debug.lastEvaluatorRun = null
      state.debug.queuedEntryCount = 0
      state.isHydrated = true
      state.revision += 1
    })
  },
  markCandidatesPending: (candidates: SemanticDuplicateCandidate[]) => {
    if (candidates.length === 0) return

    set((state) => {
      for (const candidate of candidates) {
        state.pendingPairKeys[candidate.pairKey] = true
      }
      state.revision += 1
    })
  },
  clearPendingCandidates: (pairKeys: string[]) => {
    if (pairKeys.length === 0) return

    set((state) => {
      for (const pairKey of pairKeys) {
        delete state.pendingPairKeys[pairKey]
      }
      state.revision += 1
    })
  },
  recordProcessingFailed: (error: unknown) => {
    const finishedAt = new Date().toISOString()
    const message = error instanceof Error ? error.message : "Semantic duplicate evaluation failed."

    set((state) => {
      state.debug.isProcessing = false
      state.debug.lastError = message
      state.debug.lastRunDurationMs = getRunDuration(state.debug.lastRunStartedAt, finishedAt)
      state.debug.lastRunFinishedAt = finishedAt
      state.debug.totalErrors += 1
    })
  },
  recordEvaluatorRun: (runInfo: SemanticDedupeEvaluatorRunInfo) => {
    set((state) => {
      state.debug.lastEvaluatorRun = runInfo
    })
  },
  recordProcessingFinished: (evaluations: SemanticDuplicateEvaluation[]) => {
    const finishedAt = new Date().toISOString()

    set((state) => {
      state.debug.isProcessing = false
      state.debug.lastDuplicateCount = evaluations.filter(
        (evaluation) =>
          evaluation.duplicate && evaluation.confidence >= SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
      ).length
      state.debug.lastError = null
      state.debug.lastEvaluationCount = evaluations.length
      state.debug.lastRunDurationMs = getRunDuration(state.debug.lastRunStartedAt, finishedAt)
      state.debug.lastRunFinishedAt = finishedAt
      state.debug.recentEvaluations = evaluations.slice(0, 5).map((evaluation) => ({
        confidence: evaluation.confidence,
        duplicate: evaluation.duplicate,
        pairKey: evaluation.pairKey,
        reason: evaluation.reason ?? null,
      }))
      state.debug.totalRuns += 1
    })
  },
  recordProcessingQueued: (entryCount: number) => {
    set((state) => {
      state.debug.lastQueuedAt = new Date().toISOString()
      state.debug.queuedEntryCount = entryCount
    })
  },
  recordProcessingStarted: (candidates: SemanticDuplicateCandidate[]) => {
    set((state) => {
      state.debug.isProcessing = true
      state.debug.lastError = null
      state.debug.lastEvaluationCount = 0
      state.debug.lastRunDurationMs = null
      state.debug.lastRunFinishedAt = null
      state.debug.lastRunStartedAt = new Date().toISOString()
      state.debug.recentCandidates = candidates.slice(0, 5).map((candidate) => ({
        pairKey: candidate.pairKey,
        similarity: candidate.similarity,
        titles: [candidate.entries[0].title, candidate.entries[1].title],
      }))
    })
  },
  recordScan: (entryCount: number, candidates: SemanticDuplicateCandidate[]) => {
    set((state) => {
      state.debug.lastCandidateCount = candidates.length
      state.debug.lastScanAt = new Date().toISOString()
      state.debug.lastScannedEntryCount = entryCount
      state.debug.recentCandidates = candidates.slice(0, 5).map((candidate) => ({
        pairKey: candidate.pairKey,
        similarity: candidate.similarity,
        titles: [candidate.entries[0].title, candidate.entries[1].title],
      }))
    })
  },
  upsertEvaluations: (
    candidates: SemanticDuplicateCandidate[],
    evaluations: SemanticDuplicateEvaluation[],
  ) => {
    if (candidates.length === 0) return

    const candidateByPairKey = new Map(
      candidates.map((candidate) => [candidate.pairKey, candidate]),
    )
    const updatedAt = new Date().toISOString()

    set((state) => {
      for (const evaluation of evaluations) {
        const candidate = candidateByPairKey.get(evaluation.pairKey)
        if (!candidate) continue

        const confidence = Math.max(0, Math.min(1, evaluation.confidence))
        const keepEntryId =
          evaluation.duplicate && evaluation.keepEntryId
            ? evaluation.keepEntryId
            : evaluation.duplicate
              ? candidate.keepEntryId
              : null
        const hideEntryId =
          evaluation.duplicate && evaluation.hideEntryId
            ? evaluation.hideEntryId
            : evaluation.duplicate
              ? candidate.testEntryId
              : null

        state.decisions[evaluation.pairKey] = {
          confidence,
          duplicate: evaluation.duplicate,
          entryIds: [candidate.keepEntryId, candidate.testEntryId],
          hideEntryId,
          keepEntryId,
          pairKey: evaluation.pairKey,
          reason: evaluation.reason ?? null,
          updatedAt,
        }
        delete state.pendingPairKeys[evaluation.pairKey]
      }

      for (const candidate of candidates) {
        delete state.pendingPairKeys[candidate.pairKey]
      }

      if (state.ownerKey) {
        writeDecisionsToStorage(state.ownerKey, state.decisions)
      }
      state.revision += 1
    })
  },
}

const getPairKey = (entryIdA: string, entryIdB: string) => [entryIdA, entryIdB].sort().join("::")

const getRunDuration = (startedAt: string | null, finishedAt: string) => {
  if (!startedAt) return null

  const duration = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

const truncateDescription = (description: string | null | undefined) =>
  (description ?? "").replaceAll(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH)

const getUrlHost = (...urls: Array<string | null | undefined>) => {
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

const buildEntryContext = (entryId: string): SemanticDuplicateEntryContext | null => {
  const entry = getEntry(entryId)
  if (!entry?.title) return null

  const feed = entry.feedId ? getFeedById(entry.feedId) : undefined
  const subscription = getSubscriptionByEntryId(entry.id)

  return {
    description: truncateDescription(entry.description),
    feedTitle: subscription?.title || feed?.title || "",
    id: entry.id,
    publishedAt: entry.publishedAt?.toISOString?.() ?? "",
    title: entry.title,
    urlHost: getUrlHost(entry.url, feed?.siteUrl, feed?.url),
  }
}

const getComparableText = (context: Pick<SemanticDuplicateEntryContext, "description" | "title">) =>
  `${context.title} ${context.description}`.trim()

const getBigramSet = (text: string) => {
  const normalized = getEntryTitleDedupeKey(text)?.replaceAll(/\s+/g, "") ?? ""
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

const getDiceSimilarity = (textA: string, textB: string) => {
  const gramsA = getBigramSet(textA)
  const gramsB = getBigramSet(textB)

  if (gramsA.size === 0 || gramsB.size === 0) return 0

  let intersection = 0
  for (const gram of gramsA) {
    if (gramsB.has(gram)) {
      intersection += 1
    }
  }

  return (2 * intersection) / (gramsA.size + gramsB.size)
}

const isWithinCandidateWindow = (
  entryA: EntryModel | undefined,
  entryB: EntryModel | undefined,
) => {
  if (!entryA?.publishedAt || !entryB?.publishedAt) return true
  return (
    Math.abs(entryA.publishedAt.getTime() - entryB.publishedAt.getTime()) <= CANDIDATE_TIME_WINDOW
  )
}

const shouldEvaluateCandidate = (
  contextA: SemanticDuplicateEntryContext,
  contextB: SemanticDuplicateEntryContext,
) => {
  const titleSimilarity = getDiceSimilarity(contextA.title, contextB.title)
  const contextSimilarity = getDiceSimilarity(
    getComparableText(contextA),
    getComparableText(contextB),
  )

  return {
    isCandidate:
      titleSimilarity >= MIN_TITLE_SIMILARITY || contextSimilarity >= MIN_CONTEXT_SIMILARITY,
    similarity: Math.max(titleSimilarity, contextSimilarity),
  }
}

export const getSemanticDuplicateCandidates = (
  entryIds: string[],
  options: { maxCandidates?: number } = {},
) => {
  const state = useSemanticDedupeStore.getState()
  const contexts = entryIds
    .map((entryId, index) => {
      const context = buildEntryContext(entryId)
      if (!context) return null
      return { context, index }
    })
    .filter((item): item is { context: SemanticDuplicateEntryContext; index: number } => !!item)

  const candidates: Array<SemanticDuplicateCandidate & { index: number }> = []

  for (let leftIndex = 0; leftIndex < contexts.length; leftIndex += 1) {
    const left = contexts[leftIndex]!
    const leftEntry = getEntry(left.context.id)

    for (let rightIndex = leftIndex + 1; rightIndex < contexts.length; rightIndex += 1) {
      const right = contexts[rightIndex]!
      const rightEntry = getEntry(right.context.id)
      const pairKey = getPairKey(left.context.id, right.context.id)

      if (state.decisions[pairKey] || state.pendingPairKeys[pairKey]) continue
      if (!isWithinCandidateWindow(leftEntry, rightEntry)) continue

      const { isCandidate, similarity } = shouldEvaluateCandidate(left.context, right.context)
      if (!isCandidate) continue

      candidates.push({
        entries: [left.context, right.context],
        index: left.index,
        keepEntryId: left.context.id,
        pairKey,
        similarity,
        testEntryId: right.context.id,
      })
    }
  }

  const selectedTestEntryIds = new Set<string>()
  return candidates
    .sort((candidateA, candidateB) => {
      // Entry ids are passed in timeline order, so newer entries should be evaluated first.
      if (candidateA.index !== candidateB.index) {
        return candidateA.index - candidateB.index
      }
      if (candidateB.similarity !== candidateA.similarity) {
        return candidateB.similarity - candidateA.similarity
      }
      return candidateA.testEntryId.localeCompare(candidateB.testEntryId)
    })
    .filter((candidate) => {
      if (selectedTestEntryIds.has(candidate.testEntryId)) return false
      selectedTestEntryIds.add(candidate.testEntryId)
      return true
    })
    .slice(0, options.maxCandidates ?? MAX_CANDIDATES_PER_RUN)
}

const isConfidentDuplicateDecision = (decision: SemanticDuplicateDecision) =>
  decision.duplicate &&
  decision.confidence >= SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD &&
  !!decision.hideEntryId &&
  !!decision.keepEntryId

const getSemanticDuplicateEntryRoleFromDecisions = (
  decisions: Record<string, SemanticDuplicateDecision>,
  entryId: string,
): SemanticDuplicateEntryRole => {
  let isKeeper = false

  for (const decision of Object.values(decisions)) {
    if (!isConfidentDuplicateDecision(decision)) continue

    if (decision.hideEntryId === entryId) {
      return "duplicate"
    }
    if (decision.keepEntryId === entryId) {
      isKeeper = true
    }
  }

  return isKeeper ? "keeper" : null
}

export const getSemanticDuplicateEntryRole = (entryId: string) =>
  getSemanticDuplicateEntryRoleFromDecisions(useSemanticDedupeStore.getState().decisions, entryId)

export const useSemanticDuplicateEntryRole = (entryId: string) =>
  useSemanticDedupeStore((state) =>
    getSemanticDuplicateEntryRoleFromDecisions(state.decisions, entryId),
  )

export const useSemanticDedupeRevision = () => useSemanticDedupeStore((state) => state.revision)
const useSemanticDedupeIsReady = () =>
  useSemanticDedupeStore((state) => state.isHydrated && !!state.ownerKey)

export const useSemanticDedupeHydration = (ownerKey: string | null | undefined) => {
  useEffect(() => {
    semanticDedupeActions.hydrate(ownerKey ?? undefined)
  }, [ownerKey])
}

const processQueuedSemanticDedupeEntries = async () => {
  if (isProcessingCandidates) return
  if (!semanticDuplicateEvaluator) return

  const entryIds = queuedEntryIds
  queuedEntryIds = null
  if (!entryIds) return

  const evaluator = semanticDuplicateEvaluator
  const candidates = getSemanticDuplicateCandidates(entryIds)
  semanticDedupeActions.recordScan(entryIds.length, candidates)
  if (candidates.length === 0) {
    semanticDedupeActions.recordProcessingQueued(0)
    return
  }

  isProcessingCandidates = true
  semanticDedupeActions.recordProcessingQueued(0)
  semanticDedupeActions.recordProcessingStarted(candidates)
  semanticDedupeActions.markCandidatesPending(candidates)

  try {
    const evaluations = await evaluator(candidates)
    semanticDedupeActions.upsertEvaluations(candidates, evaluations)
    semanticDedupeActions.recordProcessingFinished(evaluations)

    if (!queuedEntryIds && semanticDuplicateEvaluator === evaluator) {
      queuedEntryIds = entryIds
      semanticDedupeActions.recordProcessingQueued(entryIds.length)
    }
  } catch (error) {
    lastFailedEntryIdsKey = entryIds.join("\n")
    queuedEntryIds = null
    semanticDedupeActions.clearPendingCandidates(candidates.map((candidate) => candidate.pairKey))
    semanticDedupeActions.recordProcessingFailed(error)
  } finally {
    isProcessingCandidates = false

    if (queuedEntryIds && hasSemanticDuplicateEvaluator()) {
      queueMicrotask(() => {
        void processQueuedSemanticDedupeEntries()
      })
    }
  }
}

const enqueueSemanticDedupeEntries = (entryIds: string[]) => {
  const entryIdsKey = entryIds.join("\n")
  if (entryIdsKey === lastFailedEntryIdsKey) return

  queuedEntryIds = entryIds
  semanticDedupeActions.recordProcessingQueued(entryIds.length)
  void processQueuedSemanticDedupeEntries()
}

export const useSemanticDedupeProcessor = (entryIds: string[]) => {
  const isReady = useSemanticDedupeIsReady()
  const revision = useSemanticDedupeRevision()
  const stableEntryIds = useMemo(() => entryIds.join("\n"), [entryIds])

  useEffect(() => {
    void revision

    if (!isReady) return
    if (!semanticDuplicateEvaluator) return
    const currentEntryIds = stableEntryIds ? stableEntryIds.split("\n") : []
    enqueueSemanticDedupeEntries(currentEntryIds)
  }, [isReady, revision, stableEntryIds])
}
