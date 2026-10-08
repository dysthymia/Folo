import type { EventIdentity } from "./processing-event"
import { compatibleEvents, traceableRelatedEvent } from "./processing-event"
import type { SemanticDuplicateEntry } from "./semantic-dedupe"
import { sourceText } from "./service"

/** 仅当前已确认登记关系可提供 eventIds；实体通路还会重新验证原文证据。 */
export type EventRecallMetadata = {
  eventIds: readonly string[]
  identities: readonly EventIdentity[]
}
export type EventRecallReason =
  | { type: "text" }
  | { type: "confirmed_event"; eventId: string }
  | {
      type: "evidence_identity"
      subject: string
      action: string
      object: string
      anchors: string[]
    }

function canonical(value: string) {
  const normalized = value.trim().normalize("NFKC")
  if (!/^https?:\/\//iu.test(normalized)) return normalized.toLowerCase()
  try {
    const url = new URL(normalized)
    url.hash = ""
    for (const key of [...url.searchParams.keys()])
      if (/^utm_|^(?:fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    if (["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(url.hostname)) {
      const post = /^\/[^/]+\/status\/(\d+)/u.exec(url.pathname)
      if (post) return `https://x.com/status/${post[1]}`
    }
    return url.toString().replace(/\/$/u, "")
  } catch {
    return normalized
  }
}

function anchors(identity: EventIdentity) {
  return [
    ...(identity.version ? [`version:${canonical(identity.version.value)}`] : []),
    ...(identity.round ? [`round:${canonical(identity.round.value)}`] : []),
    ...(identity.anchor?.kind === "official_reference"
      ? [`official:${canonical(identity.anchor.value)}`]
      : []),
  ]
}

export function validatedEventRecall(entry: SemanticDuplicateEntry): EventRecallMetadata {
  if (!entry.recall || !entry.contentComplete || !entry.content?.trim())
    return { eventIds: [], identities: [] }
  const text = sourceText(entry.content)
  const identities = (entry.recall?.identities ?? []).flatMap((identity) => {
    const verified = traceableRelatedEvent(identity, text)
    if (!verified || !anchors(verified).length) return []
    // 连续原文片段不可通过空白拼接扩大；已知身份只负责召回，仍不推断转载关系。
    const fields = [
      verified.subject,
      verified.action,
      verified.object,
      verified.version,
      verified.round,
      verified.anchor,
    ]
    return fields.every((field) => !field || text.includes(field.quote))
      ? [{ ...verified, kind: "event" as const }]
      : []
  })
  return {
    eventIds: [...new Set(entry.recall?.eventIds ?? [])]
      .filter((id) => /^evt_[\da-f-]+$/iu.test(id))
      .sort(),
    identities,
  }
}

/** 精确倒排只找同实体及同版本/轮次/官方引用，不以标签或标题要求交集。 */
export function eventRecallPostingKeys(metadata: EventRecallMetadata) {
  return [
    ...metadata.eventIds.map((id) => `event:${id}`),
    ...metadata.identities.flatMap((identity) => {
      const entities = [identity.subject, identity.action, identity.object].map((field) =>
        canonical(field.value),
      )
      return anchors(identity).map((anchor) => JSON.stringify([...entities, anchor]))
    }),
  ]
}

export function eventRecallReasons(
  left: EventRecallMetadata,
  right: EventRecallMetadata,
): EventRecallReason[] {
  const reasons: EventRecallReason[] = left.eventIds
    .filter((id) => right.eventIds.includes(id))
    .map((eventId) => ({ type: "confirmed_event", eventId }))
  for (const a of left.identities)
    for (const b of right.identities) {
      if (!compatibleEvents(a, b)) continue
      if (
        a.anchor?.kind === "official_reference" &&
        b.anchor?.kind === "official_reference" &&
        canonical(a.anchor.value) !== canonical(b.anchor.value)
      )
        continue
      const shared = anchors(a).filter((anchor) => anchors(b).includes(anchor))
      if (!shared.length) continue
      reasons.push({
        type: "evidence_identity",
        subject: a.subject.value,
        action: a.action.value,
        object: a.object.value,
        anchors: shared,
      })
    }
  return reasons
}
