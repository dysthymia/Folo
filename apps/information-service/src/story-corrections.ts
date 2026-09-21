import type {
  StoryCitation,
  StoryRevision,
  StoryRevisionDraft,
  StorySentence,
  StorySourceSpan,
  StoryStore,
} from "./story-store"
import { StoryStoreError } from "./story-store"

type CurrentStory = { storyId: string; revision: StoryRevision }

function invalidReference(): never {
  throw new StoryStoreError("invalid_reference")
}

function current(store: StoryStore, storyId: string, expectedRevision: number): CurrentStory {
  const link = store.resolveLink(storyId)
  if (link.kind !== "current" || link.revision.revision !== expectedRevision) invalidReference()
  return { storyId, revision: link.revision }
}

function groupedMembers(revisions: readonly StoryRevision[], selected: ReadonlySet<number>) {
  const members = new Map<number, StoryRevision["members"][number]>()
  for (const revision of revisions)
    for (const member of revision.members) {
      if (!selected.has(member.inputSeq)) continue
      const previous = members.get(member.inputSeq)
      if (previous && previous.decisionId !== member.decisionId) invalidReference()
      members.set(member.inputSeq, member)
    }
  if (members.size !== selected.size) invalidReference()
  return [...members.values()].sort((left, right) => left.inputSeq - right.inputSeq)
}

function revisionFragment(revision: StoryRevision, selected: ReadonlySet<number>, prefix: string) {
  const spanIds = new Map<string, string>()
  const spans: StorySourceSpan[] = revision.sourceSpans.flatMap((span) => {
    if (!selected.has(span.inputSeq)) return []
    const id = `${prefix}-span-${span.id}`
    spanIds.set(span.id, id)
    return [{ ...span, id }]
  })
  const citationIds = new Map<string, string>()
  const citations: StoryCitation[] = revision.citations.flatMap((citation) => {
    const sourceSpanId = spanIds.get(citation.sourceSpanId)
    if (!sourceSpanId) return []
    const id = `${prefix}-citation-${citation.id}`
    citationIds.set(citation.id, id)
    return [
      { ...citation, id, sourceSpanId, sentenceId: `${prefix}-sentence-${citation.sentenceId}` },
    ]
  })
  const sentences: StorySentence[] = revision.sentences.flatMap((sentence) => {
    const citationIdsForSentence = sentence.citationIds.flatMap((id) => {
      const mapped = citationIds.get(id)
      return mapped ? [mapped] : []
    })
    if (!sentence.text.trim() || citationIdsForSentence.length === 0) return []
    return [
      { ...sentence, id: `${prefix}-sentence-${sentence.id}`, citationIds: citationIdsForSentence },
    ]
  })
  const sentenceIds = new Set(sentences.map((sentence) => sentence.id))
  const usableCitations = new Set(
    citations
      .filter((citation) => sentenceIds.has(citation.sentenceId))
      .map((citation) => citation.id),
  )
  const factIds = new Map(revision.facts.map((fact) => [fact.id, `${prefix}-fact-${fact.id}`]))
  let facts = revision.facts.flatMap((fact) => {
    const citationIdsForFact = fact.citationIds.filter((id) => {
      const mapped = citationIds.get(id)
      return mapped !== undefined && usableCitations.has(mapped)
    })
    const id = factIds.get(fact.id)
    if (!id || !fact.text.trim() || citationIdsForFact.length === 0) return []
    return [
      {
        ...fact,
        id,
        citationIds: citationIdsForFact.map((citationId) => citationIds.get(citationId)!),
        dependsOnFactIds: fact.dependsOnFactIds.flatMap((factId) => {
          const mapped = factIds.get(factId)
          return mapped ? [mapped] : []
        }),
      },
    ]
  })
  // 推断必须仍有完整的事实依赖；缺一项就不把旧推断带进新的人工分组。
  let changed = true
  while (changed) {
    const retained = new Set(facts.map((fact) => fact.id))
    const next = facts.filter(
      (fact) => fact.kind !== "inference" || fact.dependsOnFactIds.every((id) => retained.has(id)),
    )
    changed = next.length !== facts.length
    facts = next
  }
  const usedCitations = new Set([
    ...sentences.flatMap((sentence) => sentence.citationIds),
    ...facts.flatMap((fact) => fact.citationIds),
  ])
  return {
    spans,
    citations: citations.filter((citation) => usedCitations.has(citation.id)),
    sentences,
    facts,
  }
}

function buildDraft(
  revisions: readonly StoryRevision[],
  selected: ReadonlySet<number>,
): StoryRevisionDraft {
  if (revisions.length === 0) invalidReference()
  const [first] = revisions
  if (
    revisions.some(
      (revision) =>
        revision.aggregationRuleId !== first!.aggregationRuleId ||
        revision.aggregationScopeVersion !== first!.aggregationScopeVersion,
    )
  )
    throw new StoryStoreError("invalid_story")
  const members = groupedMembers(revisions, selected)
  const fragments = revisions.map((revision, index) =>
    revisionFragment(revision, selected, `r${index + 1}`),
  )
  const sourceSpans = fragments.flatMap((fragment) => fragment.spans)
  const citations = fragments.flatMap((fragment) => fragment.citations)
  const sentences = fragments.flatMap((fragment) => fragment.sentences)
  const facts = fragments.flatMap((fragment) => fragment.facts)
  if (!sourceSpans.length || !citations.length || !sentences.length || !facts.length)
    invalidReference()
  return {
    // 标题和正文只复用现有已验证句子，不由浏览器或此编排层新写事实。
    title: first!.title,
    body: sentences.map((sentence) => sentence.text).join("\n\n"),
    aggregationRuleId: first!.aggregationRuleId,
    aggregationScopeVersion: first!.aggregationScopeVersion,
    appliedRuleSetVersion: Math.max(...revisions.map((revision) => revision.appliedRuleSetVersion)),
    instructionFingerprint: `manual:${revisions
      .map((revision) => revision.instructionFingerprint)
      .sort()
      .join("+")}`,
    members,
    sourceSpans,
    citations,
    sentences,
    facts,
  }
}

// 人工纠正只指定现有 Story 与成员分组，所有新 revision 都由服务端已验证快照派生。
export class StoryCorrectionService {
  constructor(private readonly stories: StoryStore) {}

  merge(input: {
    keepStoryId: string
    mergeStoryId: string
    expectedKeepRevision: number
    expectedMergedRevision: number
  }) {
    const keep = current(this.stories, input.keepStoryId, input.expectedKeepRevision)
    const merged = current(this.stories, input.mergeStoryId, input.expectedMergedRevision)
    const selected = new Set([
      ...keep.revision.members.map((member) => member.inputSeq),
      ...merged.revision.members.map((member) => member.inputSeq),
    ])
    return this.stories.merge({
      ...input,
      revision: buildDraft([keep.revision, merged.revision], selected),
    })
  }

  split(input: {
    storyId: string
    expectedRevision: number
    groups: number[][]
    independentInputSeqs?: number[]
  }) {
    const parent = current(this.stories, input.storyId, input.expectedRevision)
    const independentInputSeqs = input.independentInputSeqs ?? []
    if (input.groups.length + independentInputSeqs.length < 2) invalidReference()
    const parentMembers = new Set(parent.revision.members.map((member) => member.inputSeq))
    const assigned = new Set<number>()
    const children = input.groups.map((group) => {
      const selected = new Set(group)
      // 单篇内容只能回到独立条目，不伪造一个没有综合语义的单源 Story。
      if (
        selected.size < 2 ||
        group.length !== selected.size ||
        [...selected].some((id) => !parentMembers.has(id))
      )
        invalidReference()
      for (const inputSeq of selected) {
        if (assigned.has(inputSeq)) invalidReference()
        assigned.add(inputSeq)
      }
      return { revision: buildDraft([parent.revision], selected) }
    })
    for (const inputSeq of independentInputSeqs) {
      if (!parentMembers.has(inputSeq) || assigned.has(inputSeq)) invalidReference()
      assigned.add(inputSeq)
    }
    if (assigned.size !== parentMembers.size) invalidReference()
    return this.stories.split({
      storyId: input.storyId,
      expectedCurrentRevision: input.expectedRevision,
      children,
      independentInputSeqs,
    })
  }
}
