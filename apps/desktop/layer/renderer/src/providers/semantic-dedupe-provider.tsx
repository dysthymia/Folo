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

export const SemanticDedupeProvider = () => {
  const user = useWhoami()

  useSemanticDedupeHydration(user?.id)

  useEffect(() => {
    const semanticDedupeService = ipcServices?.semanticDedupe
    if (!window.electron || !semanticDedupeService) {
      return registerSemanticDuplicateEvaluator(null)
    }

    return registerSemanticDuplicateEvaluator(async (candidates: SemanticDuplicateCandidate[]) => {
      const result = await semanticDedupeService.evaluateCandidates({ candidates })
      return result.results as SemanticDuplicateEvaluation[]
    })
  }, [])

  return null
}
