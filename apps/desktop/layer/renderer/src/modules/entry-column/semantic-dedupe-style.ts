import type { SemanticDuplicateEntryRole } from "@follow/store/entry/semantic-dedupe"

export const getSemanticDuplicateTitleClassName = (role: SemanticDuplicateEntryRole) => {
  if (role === "duplicate") return "text-text-tertiary"
  if (role === "keeper") return "text-green"
}
