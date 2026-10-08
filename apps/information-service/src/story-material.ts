import type { SourceEntry } from "./folo"
import type { ProcessingDecision } from "./processing-decision"

// 标题、阅读状态和收藏属于展示；实际正文、外链、媒体和来源身份任何变化都需要重新综合。
export function unchangedStoryMaterial(
  previous: { body: SourceEntry; decision: ProcessingDecision },
  current: { body: SourceEntry; decision: ProcessingDecision },
): boolean {
  const material = (entry: SourceEntry) =>
    [
      entry.id,
      entry.sourceKey,
      entry.feedId,
      entry.feedKind,
      entry.url,
      entry.publishedAt,
      entry.content,
      entry.description,
      entry.author,
      entry.language,
      entry.imageCount,
      entry.mediaLength,
      entry.attachmentsDuration,
      entry.originalContent,
      entry.linkedMaterials,
      entry.context,
    ].map((value) => value ?? null)
  const complete = ({ body, decision }: typeof previous) =>
    Boolean(body.content?.trim()) &&
    (!decision.semanticProfile || decision.semanticProfile.coverage === "complete") &&
    (!decision.context.content_completeness ||
      decision.context.content_completeness === "complete") &&
    ((body.imageCount ?? 0) === 0 || body.context?.images === "complete") &&
    (body.mediaLength ?? 0) <= (body.imageCount ?? 0) &&
    (body.attachmentsDuration ?? 0) === 0 &&
    Object.values(body.context ?? {}).every((state) => state === "complete") &&
    (body.linkedMaterials ?? []).every((item) => item.status === "complete")
  const license = (decision: ProcessingDecision) => ({
    status: decision.status,
    policy: decision.policy,
    sourceRole: decision.sourceRole,
    facts: decision.facts,
    event: decision.semantic?.event ?? null,
    eventMentions: decision.semantic?.eventMentions ?? null,
  })
  return (
    complete(previous) &&
    complete(current) &&
    previous.decision.facts.length > 0 &&
    JSON.stringify(material(previous.body)) === JSON.stringify(material(current.body)) &&
    JSON.stringify(license(previous.decision)) === JSON.stringify(license(current.decision))
  )
}
