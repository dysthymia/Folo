import type {
  SemanticDuplicateCandidate,
  SemanticDuplicateEvaluation,
} from "@follow/store/entry/semantic-dedupe"
import {
  registerSemanticDuplicateEvaluator,
  useSemanticDedupeHydration,
} from "@follow/store/entry/semantic-dedupe"
import { useWhoami } from "@follow/store/user/hooks"
import { useEffect } from "react"

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
      )
    }

    if (import.meta.env.DEV) {
      return registerSemanticDuplicateEvaluator(evaluateCandidatesWithDevServer)
    }

    return registerSemanticDuplicateEvaluator(null)
  }, [])

  return null
}
