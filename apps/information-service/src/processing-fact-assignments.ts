import type { EventMentionSelection } from "./processing-event-mentions"
import { validateFactEventAssignments } from "./processing-event-mentions"
import type { EvidenceCatalog } from "./processing-evidence"

// 归属是目录位置的确定性关系，不能让模型用语义相近替代唯一、完整的证据包含。
export function assignFactsToEventMentions<T extends { evidenceId: string }>(
  facts: readonly T[],
  eventMentions: readonly EventMentionSelection[],
  catalog: EvidenceCatalog,
) {
  return facts.map((fact) => {
    const matches = eventMentions.flatMap((_, eventMentionIndex) =>
      validateFactEventAssignments(
        { facts: [{ ...fact, eventMentionIndex }], eventMentions },
        catalog,
      )
        ? [eventMentionIndex]
        : [],
    )
    return { ...fact, eventMentionIndex: matches.length === 1 ? matches[0]! : null }
  })
}
