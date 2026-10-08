import { z } from "zod"

import type { EventIdentity, EventSelection } from "./processing-event"
import {
  eventIdentitySchema,
  eventSelectionForCatalog,
  eventSelectionSchema,
  materializeEvent,
} from "./processing-event"
import type { EvidenceCatalog } from "./processing-evidence"

const mentionRole = z.enum(["reports", "analysis_of", "tutorial_for", "mentions"])
export const eventMentionSchema = z
  .object({
    identity: eventIdentitySchema,
    role: mentionRole,
    isPrimary: z.boolean(),
  })
  .strict()
export type EventMention = z.infer<typeof eventMentionSchema>
const mentionSelection = z
  .object({
    identity: eventSelectionSchema,
    role: mentionRole,
    isPrimary: z.boolean(),
  })
  .strict()
export type EventMentionSelection = z.infer<typeof mentionSelection>

// 主事件最多一个；多事件周报可没有主事件，缺发生身份的次要提及仍能作为候选保存。
const uniquePrimary = (mentions: readonly { isPrimary: boolean }[], context: z.RefinementCtx) => {
  if (mentions.filter((item) => item.isPrimary).length > 1)
    context.addIssue({ code: "custom", message: "multiple_primary_events" })
}
export const eventMentionsSchema = z.array(eventMentionSchema).max(4).superRefine(uniquePrimary)
export const eventMentionsSelectionSchema = z
  .array(mentionSelection)
  .max(4)
  .superRefine(uniquePrimary)

export function eventMentionsSelectionForCatalog(catalog: EvidenceCatalog) {
  const identity = eventSelectionForCatalog(catalog)
  if (identity instanceof z.ZodNull) return z.array(mentionSelection).max(0)
  return z
    .array(
      mentionSelection.extend({
        // nullable legacy event 的同目录 schema，在提及中不接受空身份。
        identity: identity.unwrap(),
      }),
    )
    .max(4)
    .superRefine(uniquePrimary)
}

// legacy event 与显式主提及必须逐字段一致，不把相近名称或拼写当成实体别名。
function sameIdentity(left: EventIdentity | EventSelection, right: EventIdentity | EventSelection) {
  if (left.kind !== right.kind) return false
  return (["subject", "action", "object", "version", "round", "anchor"] as const).every((key) => {
    const a = left[key]
    const b = right[key]
    if (!a || !b) return a === b
    if (a.value !== b.value) return false
    if (("quote" in a ? a.quote : a.evidenceId) !== ("quote" in b ? b.quote : b.evidenceId))
      return false
    if (key === "anchor") {
      const first = left.anchor!
      const second = right.anchor!
      if (first.kind !== second.kind || (first.timeZone ?? null) !== (second.timeZone ?? null))
        return false
    }
    return true
  })
}

export function validateEventMentionRelationship(input: {
  event?: EventIdentity | EventSelection | null
  eventMentions?: readonly (EventMention | EventMentionSelection)[]
}): boolean {
  // 旧缓存无新字段时由单事件兼容入口处理，不能主动重跑历史材料。
  if (input.eventMentions === undefined) return true
  const primary = input.eventMentions.filter((item) => item.isPrimary)
  if (primary.length > 1) return false
  if (!input.event) return primary.length === 0
  return primary.length === 1 && sameIdentity(input.event, primary[0]!.identity)
}

// wire 仅携带编号；落盘时恢复同一目录的原始连续片段，primary 不参与猜测事件身份。
export function materializeEventMentions(
  catalog: EvidenceCatalog,
  selection: readonly EventMentionSelection[],
): EventMention[] {
  const selected = eventMentionsSelectionForCatalog(catalog).parse(selection)
  return eventMentionsSchema.parse(
    selected.map((mention) => ({
      ...mention,
      identity: materializeEvent(catalog, mention.identity),
    })),
  )
}

export function normalizeEventMentions(input: {
  event?: EventIdentity | null
  eventMentions?: readonly EventMention[]
}): EventMention[] {
  if (input.eventMentions !== undefined) return eventMentionsSchema.parse(input.eventMentions)
  if (!input.event) return []
  return [
    {
      identity: input.event,
      role:
        input.event.kind === "analysis"
          ? "analysis_of"
          : input.event.kind === "tutorial"
            ? "tutorial_for"
            : "reports",
      isPrimary: true,
    },
  ]
}

// 主报道可附带其他事件；只允许证据完全落在主身份片段且不碰次事件片段的事实进入综述。
// 同片段混写、重复摘引或无法定位的证据保守拒绝，不能用实体关键词猜测事实归属。
function legacyFactsForPrimaryEvent<T extends { quote: string }>(
  facts: readonly T[],
  semantic: { event?: EventIdentity | null; eventMentions?: readonly EventMention[] },
  text: string,
): T[] {
  const mentions = normalizeEventMentions(semantic)
  const primary = mentions.filter((mention) => mention.isPrimary)
  if (
    !validateEventMentionRelationship(semantic) ||
    primary.length !== 1 ||
    primary[0]!.role !== "reports" ||
    primary[0]!.identity.kind !== "event"
  )
    return []
  if (mentions.length === 1) return [...facts]
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim()
  const original = normalize(text)
  const ranges = (quote: string): Array<[number, number]> => {
    const value = normalize(quote)
    const result: Array<[number, number]> = []
    if (!value) return result
    let start = original.indexOf(value)
    while (start >= 0) {
      result.push([start, start + value.length])
      start = original.indexOf(value, start + 1)
    }
    return result
  }
  const evidence = (identity: EventIdentity) =>
    [
      identity.subject,
      identity.action,
      identity.object,
      identity.version,
      identity.round,
      identity.anchor,
    ].flatMap((field) => (field ? [field.quote] : []))
  const primaryRanges = evidence(primary[0]!.identity).flatMap(ranges)
  const secondaryQuotes = mentions
    .filter((mention) => !mention.isPrimary)
    .flatMap((mention) => evidence(mention.identity))
  if (secondaryQuotes.some((quote) => ranges(quote).length === 0)) return []
  const secondaryRanges = secondaryQuotes.flatMap(ranges)
  return facts.filter((fact) => {
    const spans = ranges(fact.quote)
    if (spans.length !== 1) return false
    const [start, end] = spans[0]!
    return (
      primaryRanges.some(([left, right]) => left <= start && end <= right) &&
      !secondaryRanges.some(([left, right]) => start < right && left < end)
    )
  })
}

// 逐事实序号只绑定同一输出中的有序提及，不把无法归属的内容塞进主事件。
type EventFactReference = { quote?: string; evidenceId?: string; eventMentionIndex?: number | null }
type MentionedSemantics = { event?: EventIdentity | null; eventMentions?: readonly EventMention[] }

function mentionQuotes(identity: EventIdentity | EventSelection, catalog?: EvidenceCatalog) {
  return [
    identity.subject,
    identity.action,
    identity.object,
    identity.version,
    identity.round,
    identity.anchor,
  ].flatMap((field) => {
    if (!field) return []
    const quote = "quote" in field ? field.quote : catalog?.resolve(field.evidenceId)
    return quote ? [quote] : []
  })
}

// 原文位置必须唯一且完整落在目标身份证据内；其他事件的片段重叠会使归属不确定。
function quoteBelongsToMention(
  quote: string,
  mentions: readonly (EventMention | EventMentionSelection)[],
  text: string,
  mentionIndex: number,
  catalog?: EvidenceCatalog,
) {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim()
  const original = normalize(text)
  const ranges = (value: string): Array<[number, number]> => {
    const fragment = normalize(value)
    const spans: Array<[number, number]> = []
    if (!fragment) return spans
    let start = original.indexOf(fragment)
    while (start >= 0) {
      spans.push([start, start + fragment.length])
      start = original.indexOf(fragment, start + 1)
    }
    return spans
  }
  const selected = mentions[mentionIndex]
  const factSpans = ranges(quote)
  if (!selected || factSpans.length !== 1) return false
  const [start, end] = factSpans[0]!
  const targetRanges = mentionQuotes(selected.identity, catalog).flatMap(ranges)
  const others = mentions.flatMap((mention, index) =>
    index === mentionIndex ? [] : mentionQuotes(mention.identity, catalog),
  )
  // 别的身份证据若不在原文内同样拒绝，不能借遗漏片段证明唯一归属。
  if (others.some((value) => ranges(value).length === 0)) return false
  return (
    targetRanges.some(([left, right]) => left <= start && end <= right) &&
    !others.flatMap(ranges).some(([left, right]) => start < right && left < end)
  )
}

export function validateFactEventAssignments(
  input: {
    facts?: readonly EventFactReference[]
    eventMentions?: readonly (EventMention | EventMentionSelection)[]
  },
  catalog?: EvidenceCatalog,
) {
  const mentions = input.eventMentions ?? []
  const text = catalog
    ? catalog.fragments.map((item) => item.quote).join("")
    : [
        ...(input.facts ?? []).flatMap((fact) => (fact.quote ? [fact.quote] : [])),
        ...mentions.flatMap((mention) => mentionQuotes(mention.identity)),
      ]
        .filter((quote, index, quotes) => quotes.indexOf(quote) === index)
        .join("\n")
  return (input.facts ?? []).every((fact) => {
    const index = fact.eventMentionIndex
    if (index === undefined || index === null) return true
    if (!Number.isInteger(index) || index < 0 || index >= mentions.length) return false
    const quote = fact.quote ?? (fact.evidenceId ? catalog?.resolve(fact.evidenceId) : null)
    return Boolean(quote && quoteBelongsToMention(quote, mentions, text, index, catalog))
  })
}

// 显式关联可支持并列周报及分析/教程关系；是否可进具体事件综述仍由已确认登记决定。
export function factsForEvent<T extends { quote: string; eventMentionIndex?: number | null }>(
  facts: readonly T[],
  semantic: MentionedSemantics,
  text: string,
  mentionIndex: number,
): T[] {
  const mentions = normalizeEventMentions(semantic)
  if (
    !Number.isInteger(mentionIndex) ||
    !mentions[mentionIndex] ||
    !validateEventMentionRelationship(semantic)
  )
    return []
  const legacy = new Set(
    legacyFactsForPrimaryEvent(
      facts.filter((fact) => fact.eventMentionIndex === undefined),
      semantic,
      text,
    ),
  )
  return facts.filter((fact) =>
    fact.eventMentionIndex === undefined
      ? mentions[mentionIndex]!.isPrimary && legacy.has(fact)
      : fact.eventMentionIndex === mentionIndex &&
        quoteBelongsToMention(fact.quote, mentions, text, mentionIndex),
  )
}

export function factsForPrimaryEvent<
  T extends { quote: string; eventMentionIndex?: number | null },
>(facts: readonly T[], semantic: MentionedSemantics, text: string): T[] {
  const mentions = normalizeEventMentions(semantic)
  const index = mentions.findIndex(
    (mention) =>
      mention.isPrimary && mention.role === "reports" && mention.identity.kind === "event",
  )
  return index < 0 ? [] : factsForEvent(facts, semantic, text, index)
}

// 长文独立保留身份字段证据，不能因 facts 上限或摘要压缩丢掉次要事件。
export function eventMentionEvidenceIds(mentions: readonly EventMentionSelection[]): string[] {
  return [
    ...new Set(
      mentions.flatMap(({ identity }) =>
        [
          identity.subject,
          identity.action,
          identity.object,
          identity.version,
          identity.round,
          identity.anchor,
        ].flatMap((field) => (field ? [field.evidenceId] : [])),
      ),
    ),
  ]
}

export function remapEventMentionEvidence(
  mentions: readonly EventMentionSelection[],
  remap: (evidenceId: string) => string,
): EventMentionSelection[] {
  return mentions.map((mention) => {
    const { identity } = mention
    const field = <T extends { evidenceId: string }>(value: T): T => ({
      ...value,
      evidenceId: remap(value.evidenceId),
    })
    return {
      ...mention,
      identity: {
        ...identity,
        subject: field(identity.subject),
        action: field(identity.action),
        object: field(identity.object),
        version: identity.version ? field(identity.version) : null,
        round: identity.round ? field(identity.round) : null,
        anchor: identity.anchor ? field(identity.anchor) : null,
      },
    }
  })
}
