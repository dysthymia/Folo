import type { PublishedDecision } from "./processing-decision"
import type { ActiveStory } from "./story-store"

export type StoryDeltaCandidate = PublishedDecision & { text: string }

// 只规范空白，不比较生成标题/摘要，也不把相似措辞当成已经覆盖的事实。
const normalized = (text: string) => text.replace(/\s+/gu, " ").trim()

function completeMaterial(candidate: PublishedDecision) {
  const entry = candidate.input.body
  // 与去重的完整度约束一致：数量和模型 coverage 都不能代替实际读取图片/引用/附件。
  if (
    ((entry.imageCount ?? 0) > 0 && entry.context?.images !== "complete") ||
    (entry.mediaLength ?? 0) > (entry.imageCount ?? 0) ||
    (entry.attachmentsDuration ?? 0) > 0 ||
    Object.values(entry.context ?? {}).some((state) => state !== "complete") ||
    entry.linkedMaterials?.some((material) => material.status !== "complete")
  )
    return false
  if (
    candidate.decision.semanticProfile &&
    candidate.decision.semanticProfile.coverage !== "complete"
  )
    return false
  const completeness = candidate.decision.context.content_completeness
  // 旧决定未保存完整度时延续已有正文资格；明确不完整的材料不能证明全篇被覆盖。
  return completeness === undefined || completeness === "complete"
}

function contextIdentity(candidate: PublishedDecision) {
  const entry = candidate.input.body
  return JSON.stringify({
    images: entry.imageCount ?? 0,
    media: entry.mediaLength ?? 0,
    duration: entry.attachmentsDuration ?? 0,
    context: Object.entries(entry.context ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    linked: entry.linkedMaterials ?? [],
    // 图片位置与 src 也是材料的一部分，去标签后的相同文字不能证明两张图片相同。
    imageBody: (entry.imageCount ?? 0) > 0 ? entry.content : null,
  })
}

function plainTextMaterial(candidate: PublishedDecision) {
  const entry = candidate.input.body
  return (
    !(entry.imageCount ?? 0) &&
    !(entry.mediaLength ?? 0) &&
    !(entry.attachmentsDuration ?? 0) &&
    !entry.linkedMaterials?.length &&
    !Object.keys(entry.context ?? {}).length
  )
}

// Story 只使用已获单篇许可证据；两份同原文或同事实转载不能冒充两份独立信息贡献。
// 此筛选只控制是否生成 Story，不改变原文可见性、读态或去重结论。
export function independentStoryContributors<T extends StoryDeltaCandidate>(
  candidates: readonly T[],
): T[] {
  const selected: T[] = []
  const texts: string[] = []
  const facts = new Set<string>()
  const quotes: string[] = []
  for (const candidate of candidates) {
    const text = normalized(candidate.text)
    if (
      completeMaterial(candidate) &&
      texts.includes(JSON.stringify([text, contextIdentity(candidate)]))
    )
      continue
    const licensed = candidate.decision.facts.filter((fact) => {
      const quote = normalized(fact.quote)
      return quote && text.includes(quote)
    })
    const addsEvidence = licensed.some((fact) => {
      const quote = normalized(fact.quote)
      return !facts.has(normalized(fact.text)) && !quotes.some((known) => known.includes(quote))
    })
    if (!addsEvidence) continue
    selected.push(candidate)
    if (completeMaterial(candidate)) texts.push(JSON.stringify([text, contextIdentity(candidate)]))
    for (const fact of licensed) {
      facts.add(normalized(fact.text))
      quotes.push(normalized(fact.quote))
    }
  }
  return selected
}

// 事实子集不足以证明没有增量；只有完整原文已被当前 Story 的实际材料覆盖时才跳过。
// 同原文的抽取措辞/kind 变化不是新来源，也不能刷新实质未读状态。
export function storyCandidatesWithDelta<T extends StoryDeltaCandidate>(
  candidates: readonly T[],
  existing: readonly ActiveStory[],
  publishedMaterials: readonly StoryDeltaCandidate[],
): T[] {
  const byMember = new Map(
    publishedMaterials.map((item) => [`${item.input.seq}:${item.decisionId}`, item]),
  )
  const priorMaterials = existing.flatMap((story) =>
    story.revision.members.flatMap((member) => {
      const material = byMember.get(`${member.inputSeq}:${member.decisionId}`)
      return material && completeMaterial(material) ? [material] : []
    }),
  )
  const knownEvidence = [
    ...existing.flatMap((story) =>
      story.revision.sourceSpans.map((span) => normalized(span.quote)),
    ),
    ...priorMaterials.map((material) => normalized(material.text)),
  ]
  const knownFacts = new Set([
    ...existing.flatMap((story) => story.revision.facts.map((fact) => normalized(fact.text))),
    ...priorMaterials.flatMap((material) =>
      material.decision.facts.map((fact) => normalized(fact.text)),
    ),
  ])
  return candidates.filter((candidate) => {
    const alreadyProcessed = existing.some((story) =>
      story.revision.members.some(
        (member) =>
          member.inputSeq === candidate.input.seq && member.decisionId === candidate.decisionId,
      ),
    )
    if (alreadyProcessed) return false
    if (!completeMaterial(candidate)) return true
    const text = normalized(candidate.text)
    if (!text) return true
    // 先比较已发布事实及其原文证据；抽取措辞和 kind 改变不构成独立信息。
    const factsCovered = candidate.decision.facts.every((fact) => {
      const quote = normalized(fact.quote)
      return (
        quote &&
        text.includes(quote) &&
        (knownFacts.has(normalized(fact.text)) ||
          knownEvidence.some((evidence) => evidence.includes(quote)))
      )
    })
    if (!factsCovered) return true
    // 必须覆盖当前完整材料，不能仅凭 facts 的有限摘引抹去未抽取的新事实/限制/反证。
    const quotedFullText =
      plainTextMaterial(candidate) &&
      existing.some((story) =>
        story.revision.sourceSpans.some((span) => normalized(span.quote).includes(text)),
      )
    const previousFullMaterial = priorMaterials.some(
      (material) =>
        contextIdentity(material) === contextIdentity(candidate) &&
        normalized(material.text).includes(text),
    )
    return !quotedFullText && !previousFullMaterial
  })
}
