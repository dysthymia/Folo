import type {
  SemanticDuplicateCandidate,
  SemanticDuplicateEvaluation,
} from "@follow/store/entry/semantic-dedupe"
import {
  registerSemanticDuplicateEvaluator,
  SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
  useSemanticDedupeHydration,
  useSemanticDedupeStore,
} from "@follow/store/entry/semantic-dedupe"
import { useWhoami } from "@follow/store/user/hooks"
import { cn } from "@follow/utils/utils"
import { useEffect, useState } from "react"

import { ipcServices } from "~/lib/client"

const SEMANTIC_DEDUPE_DEV_ENDPOINT = "/__semantic-dedupe/evaluate"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSemanticDuplicateEvaluation = (value: unknown): value is SemanticDuplicateEvaluation => {
  if (!isRecord(value)) return false

  return (
    typeof value.pairKey === "string" &&
    typeof value.duplicate === "boolean" &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    (value.keepEntryId === undefined ||
      value.keepEntryId === null ||
      typeof value.keepEntryId === "string") &&
    (value.hideEntryId === undefined ||
      value.hideEntryId === null ||
      typeof value.hideEntryId === "string") &&
    (value.reason === undefined || value.reason === null || typeof value.reason === "string")
  )
}

const parseSemanticDedupeResponse = (payload: unknown): SemanticDuplicateEvaluation[] => {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error("Invalid semantic dedupe response.")
  }

  return payload.results.filter(isSemanticDuplicateEvaluation)
}

const evaluateCandidatesWithDevServer = async (candidates: SemanticDuplicateCandidate[]) => {
  const response = await fetch(SEMANTIC_DEDUPE_DEV_ENDPOINT, {
    body: JSON.stringify({ candidates }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })

  if (!response.ok) {
    throw new Error(`Semantic dedupe dev server failed with ${response.status}.`)
  }

  return parseSemanticDedupeResponse((await response.json()) as unknown)
}

export const SemanticDedupeProvider = () => {
  const user = useWhoami()

  useSemanticDedupeHydration(user?.id)

  useEffect(() => {
    const semanticDedupeService = ipcServices?.semanticDedupe
    if (window.electron && semanticDedupeService) {
      return registerSemanticDuplicateEvaluator(
        async (candidates: SemanticDuplicateCandidate[]) => {
          const result = await semanticDedupeService.evaluateCandidates({ candidates })
          return result.results as SemanticDuplicateEvaluation[]
        },
        "electron",
      )
    }

    if (import.meta.env.DEV) {
      return registerSemanticDuplicateEvaluator(evaluateCandidatesWithDevServer, "dev-server")
    }

    return registerSemanticDuplicateEvaluator(null)
  }, [])

  if (!import.meta.env.DEV) return null

  return <SemanticDedupeDebugPanel />
}

const evaluatorSourceLabel = {
  custom: "custom",
  "dev-server": "Chrome dev",
  electron: "Electron IPC",
  none: "none",
} as const

const formatTime = (value: string | null) => {
  if (!value) return "never"

  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

const formatDuration = (duration: number | null) => {
  if (duration === null) return "-"
  if (duration < 1000) return `${duration}ms`

  return `${(duration / 1000).toFixed(1)}s`
}

const formatPercent = (value: number) => `${Math.round(value * 100)}%`

const truncate = (value: string, length = 34) =>
  value.length > length ? `${value.slice(0, length - 1)}...` : value

const SemanticDedupeDebugPanel = () => {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const snapshot = useSemanticDedupeStore((state) => {
    const decisions = Object.values(state.decisions)
    const confidentDuplicateCount = decisions.filter(
      (decision) =>
        decision.duplicate &&
        decision.confidence >= SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD &&
        !!decision.hideEntryId &&
        !!decision.keepEntryId,
    ).length

    return {
      debug: state.debug,
      decisionCount: decisions.length,
      isHydrated: state.isHydrated,
      ownerKey: state.ownerKey,
      pendingCount: Object.keys(state.pendingPairKeys).length,
      revision: state.revision,
      confidentDuplicateCount,
    }
  })
  const { debug } = snapshot
  const status = debug.isProcessing
    ? "processing"
    : debug.evaluatorSource === "none"
      ? "off"
      : "idle"
  const statusLabel = `${status} · pending ${snapshot.pendingCount} · decisions ${snapshot.decisionCount}`

  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-4 right-4 z-[99999] max-w-[calc(100vw-2rem)] print:hidden",
        isCollapsed ? "w-[300px]" : "w-[360px]",
      )}
    >
      <div className="pointer-events-auto rounded-md border border-border bg-popover text-xs text-text shadow-xl backdrop-blur-background">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 font-medium">
            <span
              className={cn(
                "size-2 rounded-full",
                debug.isProcessing && "animate-pulse bg-orange",
                !debug.isProcessing && debug.evaluatorSource !== "none" && "bg-green",
                debug.evaluatorSource === "none" && "bg-red",
              )}
            />
            <span className="shrink-0">语义去重</span>
            <span className="min-w-0 truncate text-text-tertiary">{statusLabel}</span>
          </div>
          <button
            type="button"
            aria-label={isCollapsed ? "展开语义去重调试信息" : "折叠语义去重调试信息"}
            className="center -mr-1 size-6 shrink-0 rounded-md text-text-tertiary duration-150 hover:bg-fill-secondary hover:text-text"
            onClick={() => setIsCollapsed((value) => !value)}
            title={isCollapsed ? "展开" : "折叠"}
          >
            <i
              className={cn(
                "i-mingcute-down-line size-4 duration-150",
                isCollapsed ? "rotate-180" : "",
              )}
            />
          </button>
        </div>

        {!isCollapsed && (
          <div className="max-h-[min(560px,calc(100vh-7rem))] overflow-y-auto px-3 pb-2">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-text-secondary">
              <DebugMetric label="evaluator" value={evaluatorSourceLabel[debug.evaluatorSource]} />
              <DebugMetric
                label="ready"
                value={snapshot.isHydrated && snapshot.ownerKey ? "yes" : "no"}
              />
              <DebugMetric
                label="scan"
                value={`${debug.lastScannedEntryCount} / ${debug.lastCandidateCount}`}
              />
              <DebugMetric label="pending" value={snapshot.pendingCount.toString()} />
              <DebugMetric
                label="decisions"
                value={`${snapshot.decisionCount} (${snapshot.confidentDuplicateCount})`}
              />
              <DebugMetric label="last run" value={formatDuration(debug.lastRunDurationMs)} />
              <DebugMetric
                label="updated"
                value={formatTime(debug.lastRunFinishedAt ?? debug.lastScanAt)}
              />
              <DebugMetric label="revision" value={snapshot.revision.toString()} />
            </div>

            {debug.lastError && (
              <div className="mt-2 rounded border border-red/30 bg-red/10 px-2 py-1 text-red">
                {truncate(debug.lastError, 96)}
              </div>
            )}

            {debug.recentCandidates.length > 0 && (
              <div className="mt-2 border-t border-border pt-2">
                <div className="mb-1 text-text-tertiary">recent candidates</div>
                <div className="space-y-1">
                  {debug.recentCandidates.slice(0, 3).map((candidate) => (
                    <div key={candidate.pairKey} className="min-w-0 text-text-secondary">
                      <span className="mr-1 text-text-tertiary">
                        {formatPercent(candidate.similarity)}
                      </span>
                      <span className="text-text">{truncate(candidate.titles[0], 24)}</span>
                      <span className="mx-1 text-text-quaternary">vs</span>
                      <span>{truncate(candidate.titles[1], 24)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {debug.recentEvaluations.length > 0 && (
              <div className="mt-2 border-t border-border pt-2">
                <div className="mb-1 text-text-tertiary">recent results</div>
                <div className="space-y-1">
                  {debug.recentEvaluations.slice(0, 3).map((evaluation) => (
                    <div key={evaluation.pairKey} className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5",
                          evaluation.duplicate
                            ? "bg-green/15 text-green"
                            : "bg-fill-secondary text-text-tertiary",
                        )}
                      >
                        {evaluation.duplicate ? "dup" : "keep"}
                      </span>
                      <span className="shrink-0 text-text-tertiary">
                        {formatPercent(evaluation.confidence)}
                      </span>
                      <span className="truncate text-text-secondary">
                        {truncate(evaluation.reason ?? evaluation.pairKey, 46)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const DebugMetric = ({ label, value }: { label: string; value: string }) => (
  <div className="flex min-w-0 items-center justify-between gap-2">
    <span className="shrink-0 text-text-tertiary">{label}</span>
    <span className="truncate text-right text-text">{value}</span>
  </div>
)
