import type { SemanticEntity } from "@follow/information-core"

import type { EventIdentity } from "./processing-event"
import { compatibleEvents, occurrenceRange, traceableRelatedEvent } from "./processing-event"
import type { SemanticDuplicateEntry } from "./semantic-dedupe"
import { sourceText } from "./service"

/** 仅当前已确认登记关系可提供 eventIds；实体通路还会重新验证原文证据。 */
export type EventRecallAliasGroup = {
  name: string
  aliases: readonly string[]
  quotes: readonly string[]
  kind: SemanticEntity["kind"]
  parentName: string | null
}
export type EventRecallMetadata = {
  eventIds: readonly string[]
  identities: readonly EventIdentity[]
  aliasGroups?: readonly EventRecallAliasGroup[]
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
  const anchor = identity.anchor
  const range = anchor ? occurrenceRange(anchor) : null
  // UTC日桶仅用于有界倒排；具体时间重叠仍由 compatibleEvents 严格核验。
  const period = statisticalPeriod(identity)
  const temporal = period
    ? [`statistics:${period}`]
    : range
      ? Array.from(
          { length: Math.ceil(range[1] / 86_400_000) - Math.floor(range[0] / 86_400_000) },
          (_, offset) => `occurrence:${Math.floor(range[0] / 86_400_000) + offset}`,
        )
      : anchor?.kind === "event_date"
        ? [`date:${anchor.value}`]
        : []
  return [
    ...temporal,
    ...(identity.version ? [`version:${canonical(identity.version.value)}`] : []),
    ...(identity.round ? [`round:${canonical(identity.round.value)}`] : []),
    ...(identity.anchor?.kind === "official_reference"
      ? [`official:${canonical(identity.anchor.value)}`]
      : []),
  ]
}

function statisticalPeriod(identity: EventIdentity): string | null {
  if (identity.action.value !== "market_event" || !identity.anchor) return null
  const quote = identity.anchor.quote
  if (!/期间|统计|本周|一周|周度|每周|weekly|week|period|至|到|through|until|between/iu.test(quote))
    return null
  const dates = [...quote.matchAll(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/gu)].map(
    (match) => `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`,
  )
  // 完整起止日期只作候选身份，统计数值及口径仍须全文比较；不从发布时间推算“过去一周”。
  if (
    dates.length !== 2 ||
    dates.some(
      (date) =>
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date,
    )
  )
    return null
  return dates[0]! <= dates[1]! ? dates.join("/") : null
}

const occurrenceActions: Record<EventIdentity["action"]["value"], RegExp> = {
  announcement: /宣布|公告|announc/iu,
  product_release: /发布|上线|推出|release|launch/iu,
  campaign: /活动|开展|启动|campaign/iu,
  security_incident: /攻击|入侵|漏洞|遭|attack|breach|exploit/iu,
  regulatory_action: /监管|批准|处罚|regulat|approv/iu,
  legal_case: /起诉|判决|法院|诉讼|lawsuit|court|sued/iu,
  public_statement: /表示|发言|称|said|statement|spoke/iu,
  death: /去世|逝世|死亡|died|death/iu,
  market_event: /流入|流出|涨|跌|成交|统计|期间|截至|inflow|outflow|rose|fell|week|period/iu,
  transaction: /购买|买入|出售|交易|收购|purchase|bought|sold|acquir/iu,
  election: /选举|当选|投票|elect|vot/iu,
}

function occurrenceHasEvidence(identity: EventIdentity) {
  const anchor = identity.anchor
  if (!anchor || anchor.kind === "official_reference") return true
  // 发布时间或新闻电头只证明报道日期；发生时间还须在同一连续片段中明确承载事件动作。
  if (
    /发布时间|发表于|报道时间|published(?:\s+at|\s+on)?|posted(?:\s+at|\s+on)?/iu.test(anchor.quote)
  )
    return false
  if (
    /^(?:[^，。]*消息[，,]?\s*|[^:]*News[, :]*)?\d{4}[年/.-]\d{1,2}[月/.-]\d{1,2}日?(?:\s*消息|[，,])/iu.test(
      anchor.quote.trim(),
    )
  )
    return false
  return occurrenceActions[identity.action.value].test(anchor.quote)
}

function containsName(text: string, name: string) {
  const escaped = canonical(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return new RegExp(
    `${/^[a-z0-9]/u.test(name) ? "(?<![a-z0-9])" : ""}${escaped}${/[a-z0-9]$/iu.test(name) ? "(?![a-z0-9])" : ""}`,
    "iu",
  ).test(canonical(text))
}

function explicitAliasQuote(name: string, alias: string, quote: string) {
  const escaped = (value: string) => value.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const expression = (first: string, second: string) =>
    `${escaped(first)}\\s*(?:[（(]\\s*${escaped(second)}\\s*[）)]|[,，]?\\s*(?:又称|亦称|简称|别名(?:为)?|中文名(?:为)?|英文名(?:为)?|也称|also known as|aka|abbreviated as)\\s*[:：]?\\s*${escaped(second)}(?![a-z0-9]))`
  return new RegExp(`${expression(name, alias)}|${expression(alias, name)}`, "iu").test(
    quote.normalize("NFKC"),
  )
}

export function validatedEventRecall(entry: SemanticDuplicateEntry): EventRecallMetadata {
  const content = entry.fullContentComplete
    ? entry.fullContent
    : entry.contentComplete
      ? entry.content
      : null
  if (!entry.recall || !content?.trim()) return { eventIds: [], identities: [] }
  const text = sourceText(content)
  const identities = (entry.recall?.identities ?? []).flatMap((identity) => {
    const verified = traceableRelatedEvent(identity, text)
    if (!verified || !anchors(verified).length || !occurrenceHasEvidence(verified)) return []
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
  const aliasGroups = (entry.recall.aliasGroups ?? [])
    .slice(0, 8)
    .filter(
      (group) =>
        group.aliases.length > 0 &&
        group.aliases.length <= 4 &&
        group.quotes.length > 0 &&
        group.quotes.every((quote) => text.includes(quote)) &&
        (!group.parentName ||
          group.quotes.some((quote) => containsName(quote, group.parentName!))) &&
        group.aliases.every((alias) =>
          group.quotes.some(
            (quote) =>
              containsName(quote, group.name) &&
              containsName(quote, alias) &&
              explicitAliasQuote(group.name, alias, quote),
          ),
        ),
    )
  return {
    ...(aliasGroups.length ? { aliasGroups } : {}),
    eventIds: [...new Set(entry.recall?.eventIds ?? [])]
      .filter((id) => /^evt_[\da-f-]+$/iu.test(id))
      .sort(),
    identities,
  }
}

const aliasIndexes = new WeakMap<readonly EventRecallAliasGroup[], Map<string, string[]>>()
function aliasNames(value: string, groups: readonly EventRecallAliasGroup[]) {
  let index = aliasIndexes.get(groups)
  if (!index) {
    const owners = new Map<string, { owner: string; names: Set<string>; ambiguous: boolean }>()
    for (const group of groups) {
      const owner = JSON.stringify([group.kind, group.parentName, canonical(group.name)])
      const names = [group.name, ...group.aliases].map(canonical)
      for (const name of names) {
        const previous = owners.get(name)
        if (!previous) owners.set(name, { owner, names: new Set(names), ambiguous: false })
        else if (previous.owner !== owner) previous.ambiguous = true
        else for (const alias of names) previous.names.add(alias)
      }
    }
    index = new Map(
      [...owners].map(([name, entry]) => [
        name,
        entry.ambiguous
          ? []
          : entry.names.size > 5
            ? [name]
            : [...entry.names].filter((alias) => !owners.get(alias)?.ambiguous),
      ]),
    )
    aliasIndexes.set(groups, index)
  }
  // 不同类别/所属对象共享缩写时拒绝扩展，禁止靠ticker串联项目。
  return index.get(canonical(value)) ?? [canonical(value)]
}

/** 精确倒排只找同主体动作对象及发生身份，不以标签或标题要求交集。 */

export function eventRecallPostingKeys(
  metadata: EventRecallMetadata,
  groups = metadata.aliasGroups ?? [],
) {
  return [
    ...metadata.eventIds.map((id) => `event:${id}`),
    ...metadata.identities.flatMap((identity) => {
      return aliasNames(identity.subject.value, groups).flatMap((subject) =>
        aliasNames(identity.object.value, groups).flatMap((object) =>
          anchors(identity).map((anchor) =>
            JSON.stringify([subject, canonical(identity.action.value), object, anchor]),
          ),
        ),
      )
    }),
  ]
}

export function eventRecallReasons(
  left: EventRecallMetadata,
  right: EventRecallMetadata,
  aliasGroups = [...(left.aliasGroups ?? []), ...(right.aliasGroups ?? [])],
): EventRecallReason[] {
  const reasons: EventRecallReason[] = left.eventIds
    .filter((id) => right.eventIds.includes(id))
    .map((eventId) => ({ type: "confirmed_event", eventId }))
  for (const a of left.identities)
    for (const b of right.identities) {
      const groups = aliasGroups
      if (
        [a, b].some((identity) =>
          [identity.subject, identity.object].some(
            (field) => !aliasNames(field.value, groups).length,
          ),
        )
      )
        continue
      const mapped = (identity: EventIdentity) => ({
        ...identity,
        subject: {
          ...identity.subject,
          value: aliasNames(identity.subject.value, groups).sort()[0]!,
        },
        object: { ...identity.object, value: aliasNames(identity.object.value, groups).sort()[0]! },
      })
      const periodA = statisticalPeriod(a),
        periodB = statisticalPeriod(b)
      if (periodA !== periodB && (periodA || periodB)) continue
      if (
        a.anchor?.kind === "event_date" &&
        b.anchor?.kind === "event_date" &&
        (a.anchor.timeZone ?? null) === (b.anchor.timeZone ?? null) &&
        a.anchor.value !== b.anchor.value
      )
        continue
      if (!compatibleEvents(mapped(a), mapped(b))) continue
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
