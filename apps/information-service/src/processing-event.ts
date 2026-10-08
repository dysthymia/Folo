import { z } from "zod"

import type { EvidenceCatalog } from "./processing-evidence"

const identityValue = z.string().trim().min(1).max(300)
const actionValue = z.enum([
  "announcement",
  "product_release",
  "campaign",
  "security_incident",
  "regulatory_action",
  "legal_case",
  "public_statement",
  "death",
  "market_event",
  "transaction",
  "election",
])
const evidenceValue = z
  .object({ value: identityValue, quote: z.string().min(1).max(4000) })
  .strict()
const anchorKind = z.enum(["event_date", "event_time", "official_reference"])
const anchorZone = z.string().trim().min(1).max(80).nullable().optional()
// 模型的严格输出格式要求所有属性都在 required 中；未知时区明确返回 null。
// 持久化身份仍兼容旧记录省略 timeZone，不能为修正请求格式破坏已有事件。
const selectedAnchorZone = anchorZone.unwrap()

// 名称只允许原文可追溯的规范实体；优先使用材料明确提供的稳定URL/ID，不按主题或标题聚类。
export const eventIdentitySchema = z
  .object({
    kind: z.enum(["event", "analysis", "tutorial"]),
    subject: evidenceValue,
    action: evidenceValue.extend({ value: actionValue }),
    object: evidenceValue,
    version: evidenceValue.nullable(),
    round: evidenceValue.nullable(),
    anchor: evidenceValue.extend({ kind: anchorKind, timeZone: anchorZone }).nullable(),
  })
  .strict()
export type EventIdentity = z.infer<typeof eventIdentitySchema>

const selectedValue = z
  .object({ value: identityValue, evidenceId: z.string().min(1).max(80) })
  .strict()
export const eventSelectionSchema = z
  .object({
    kind: z.enum(["event", "analysis", "tutorial"]),
    subject: selectedValue,
    action: selectedValue.extend({ value: actionValue }),
    object: selectedValue,
    version: selectedValue.nullable(),
    round: selectedValue.nullable(),
    anchor: selectedValue.extend({ kind: anchorKind, timeZone: selectedAnchorZone }).nullable(),
  })
  .strict()
export type EventSelection = z.infer<typeof eventSelectionSchema>

export function eventSelectionForCatalog(catalog: EvidenceCatalog) {
  const ids = catalog.fragments.map((fragment) => fragment.evidenceId)
  if (!ids.length) return z.null()
  const value = selectedValue.extend({ evidenceId: z.enum(ids as [string, ...string[]]) })
  return eventSelectionSchema
    .extend({
      subject: value,
      action: value.extend({ value: actionValue }),
      object: value,
      version: value.nullable(),
      round: value.nullable(),
      anchor: value.extend({ kind: anchorKind, timeZone: selectedAnchorZone }).nullable(),
    })
    .nullable()
}

// 编号必须来自本次原文（或已验证长文分块），模型不能自由生成身份字段的quote。
export function materializeEvent(
  catalog: EvidenceCatalog,
  event: EventSelection | null,
): EventIdentity | null {
  if (!event) return null
  const restore = (field: z.infer<typeof selectedValue>) => {
    const quote = catalog.resolve(field.evidenceId)
    if (quote === null) throw new Error("invalid_event_evidence")
    return { value: field.value, quote }
  }
  return eventIdentitySchema.parse({
    kind: event.kind,
    subject: restore(event.subject),
    action: restore(event.action),
    object: restore(event.object),
    version: event.version ? restore(event.version) : null,
    round: event.round ? restore(event.round) : null,
    anchor: event.anchor
      ? { ...restore(event.anchor), kind: event.anchor.kind, timeZone: event.anchor.timeZone }
      : null,
  })
}

function canonical(value: string) {
  const normalized = value.trim().normalize("NFKC")
  // 只去跟踪参数，保留公告ID等有身份含义的查询参数；URL路径大小写不能被误合并。
  if (/^https?:\/\//iu.test(normalized)) {
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
  return normalized.toLowerCase()
}

function calendarDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null
}

function zoneOffset(zone: string): number | null {
  if (zone === "UTC" || zone === "Z") return 0
  const match = /^(?:UTC)?([+-])(\d{2}):(\d{2})$/u.exec(zone)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null
  return (match[1] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000
}

// 只换算原文明确提供的时区；夏令时按本地两次午夜分别计算，不假定每天都是24小时。
function midnightInZone(day: number, zone: string): number | null {
  const offset = zoneOffset(zone)
  if (offset !== null) return day - offset
  if (!/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/u.test(zone)) return null
  try {
    const format = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    let instant = day
    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = format.formatToParts(instant)
      const number = (key: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === key)?.value)
      const local = Date.UTC(
        number("year"),
        number("month") - 1,
        number("day"),
        number("hour"),
        number("minute"),
        number("second"),
      )
      if (local === day) return instant
      instant += day - local
    }
  } catch {
    // 无效时区或午夜不存在时保持未知，不猜算发生时间。
  }
  return null
}

function eventInstant(value: string): number | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    )
  if (
    !match ||
    calendarDate(match[1]!) === null ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4] ?? "0") > 59 ||
    zoneOffset(match[5]!) === null
  )
    return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

// 召回复用身份确认的时间区间，避免重复实现时区与夏令时规则。
export function occurrenceRange(
  anchor: NonNullable<EventIdentity["anchor"]>,
): [number, number] | null {
  if (anchor.kind === "event_time") {
    const instant = eventInstant(anchor.value)
    return instant === null ? null : [instant, instant + 1]
  }
  if (anchor.kind !== "event_date" || !anchor.timeZone) return null
  const day = calendarDate(anchor.value)
  if (day === null) return null
  const start = midnightInZone(day, anchor.timeZone)
  const end = midnightInZone(day + 86_400_000, anchor.timeZone)
  return start === null || end === null || start >= end ? null : [start, end]
}

export function traceableEvent(event: unknown, text: string): EventIdentity | null {
  const parsed = eventIdentitySchema.safeParse(event)
  if (!parsed.success || parsed.data.kind !== "event") return null
  const fields = [
    parsed.data.subject,
    parsed.data.action,
    parsed.data.object,
    parsed.data.version,
    parsed.data.round,
    parsed.data.anchor,
  ]
  const original = text.replace(/\s+/gu, " ")
  if (fields.some((field) => field && !original.includes(field.quote.replace(/\s+/gu, " "))))
    return null
  // 无发生锚点、官方原帖、版本或轮次时仍可独立阅读，不能把泛主题当成同事件身份。
  if (!parsed.data.version && !parsed.data.round && !parsed.data.anchor) return null
  if (parsed.data.anchor?.kind === "event_date") {
    if (calendarDate(parsed.data.anchor.value) === null) return null
    if (parsed.data.anchor.timeZone && !occurrenceRange(parsed.data.anchor)) return null
  }
  if (parsed.data.anchor?.kind === "event_time" && eventInstant(parsed.data.anchor.value) === null)
    return null
  if (
    parsed.data.anchor?.kind === "official_reference" &&
    !/^https?:\/\//u.test(parsed.data.anchor.value)
  )
    return null
  return parsed.data
}

// 已知版本/轮次/发生区间冲突一律拒绝；截止、资格和领取条件不属于事件身份，允许更新。
export function compatibleEvents(left: EventIdentity, right: EventIdentity): boolean {
  if (left.kind !== "event" || right.kind !== "event") return false
  if (
    ["subject", "action", "object"].some((key) => {
      const field = key as "subject" | "action" | "object"
      return canonical(left[field].value) !== canonical(right[field].value)
    })
  )
    return false
  for (const key of ["version", "round"] as const) {
    if (left[key] && right[key] && canonical(left[key].value) !== canonical(right[key].value))
      return false
  }
  const leftRange = left.anchor ? occurrenceRange(left.anchor) : null
  const rightRange = right.anchor ? occurrenceRange(right.anchor) : null
  const sharedOccurrence =
    !!leftRange && !!rightRange && leftRange[0] < rightRange[1] && rightRange[0] < leftRange[1]
  if (leftRange && rightRange && !sharedOccurrence) return false
  // 必须共享至少一种发生锚点，不能靠“同主体同动作”拼接不同次公告。
  return (
    sharedOccurrence ||
    ["version", "round"].some((key) => {
      const field = key as "version" | "round"
      return (
        !!left[field] &&
        !!right[field] &&
        canonical(left[field].value) === canonical(right[field].value)
      )
    }) ||
    (!!left.anchor &&
      !!right.anchor &&
      left.anchor.kind === right.anchor.kind &&
      left.anchor.kind !== "event_time" &&
      canonical(left.anchor.value) === canonical(right.anchor.value))
  )
}

// 单篇展示仅检查身份完整性；原文quote的归属仍由请求证据目录和聚合持久化边界核验。
export function hasConfirmedEvent(event: unknown): boolean {
  const parsed = eventIdentitySchema.safeParse(event)
  if (!parsed.success) return false
  const fields = [
    parsed.data.subject,
    parsed.data.action,
    parsed.data.object,
    parsed.data.version,
    parsed.data.round,
    parsed.data.anchor,
  ]
  return (
    traceableEvent(
      parsed.data,
      fields.flatMap((field) => (field ? [field.quote] : [])).join("\n"),
    ) !== null
  )
}

// related 身份允许分析/教程指向底层具体事件；Story 的 traceableEvent 仍只接受 kind=event。
export function traceableRelatedEvent(event: unknown, text: string): EventIdentity | null {
  const parsed = eventIdentitySchema.safeParse(event)
  if (!parsed.success) return null
  const identity = parsed.data
  if (!traceableEvent({ ...identity, kind: "event" }, text)) return null
  // 名称、版本和轮次必须受其本身的连续证据支持，不借相邻片段或记忆中的别名补足。
  for (const field of [identity.subject, identity.object, identity.version, identity.round]) {
    if (field && !supportsIdentityValue(field.value, field.quote)) return null
  }
  const { anchor } = identity
  if (anchor?.kind === "official_reference" && !supportsIdentityValue(anchor.value, anchor.quote))
    return null
  if (anchor?.kind === "event_date" || anchor?.kind === "event_time") {
    if (!supportsEventDate(anchor.value.slice(0, 10), anchor.quote)) return null
    if (anchor.timeZone && !supportsEventZone(anchor.timeZone, anchor.quote)) return null
    if (anchor.kind === "event_time") {
      const localTime = anchor.value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/u)
      if (!localTime) return null
      const hour = Number(localTime[1])
      const minute = Number(localTime[2])
      const second = Number(localTime[3] ?? "0")
      const supportedTime = [
        ...anchor.quote.matchAll(
          /(?:^|\D)(\d{1,2})(?::|时)(\d{1,2})(?::(\d{1,2})|分(\d{1,2})秒)?/gu,
        ),
      ].some(
        (match) =>
          Number(match[1]) === hour &&
          Number(match[2]) === minute &&
          Number(match[3] ?? match[4] ?? "0") === second,
      )
      const offset = /(?:Z|[+-]\d{2}:\d{2})$/u.exec(anchor.value)?.[0]
      if (!supportedTime || !offset || !supportsEventZone(offset, anchor.quote)) return null
    }
  }
  return identity
}

function supportsIdentityValue(value: string, quote: string): boolean {
  if (/^https?:\/\//iu.test(value)) {
    const urls = quote.match(/https?:\/\/[^\s<>"'，。；）)]+/gu) ?? []
    return urls.some((url) => canonical(url) === canonical(value))
  }
  // 仅消除中英文排版空格和合法数字千分位；保留拉丁词间空格及版本边界，避免拼接不同名称。
  const normalized = (text: string) =>
    text
      .normalize("NFKC")
      .replace(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])/gu, (number) => number.replaceAll(",", ""))
      .replace(/(?<=\p{Script=Han})\s+|\s+(?=\p{Script=Han})/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase()
  const original = normalized(quote)
  const name = normalized(value)
  const latin = /[a-z0-9_]/u
  let position = original.indexOf(name)
  while (position >= 0) {
    const before = original[position - 1] ?? ""
    const after = original[position + name.length] ?? ""
    if (
      (!latin.test(name[0]!) || !latin.test(before)) &&
      (!latin.test(name.at(-1)!) || !latin.test(after))
    )
      return true
    position = original.indexOf(name, position + 1)
  }
  return false
}

function supportsEventDate(value: string, quote: string): boolean {
  const [year, month, day] = value.split("-").map(Number)
  for (const match of quote.matchAll(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/gu))
    if (Number(match[1]) === year && Number(match[2]) === month && Number(match[3]) === day)
      return true
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ]
  const monthName = months[month! - 1]
  if (!monthName) return false
  const name = `(?:${monthName}|${monthName.slice(0, 3)}\\.?)`
  return new RegExp(
    `\\b(?:${name}\\s+0?${day}(?:st|nd|rd|th)?[,]?\\s+${year}|0?${day}\\s+${name}\\s+${year})\\b`,
    "iu",
  ).test(quote)
}

function supportsEventZone(zone: string, quote: string): boolean {
  // UTC-04:00 不能支持 UTC，时区缩写必须有完整边界，不能按子串升级。
  if (/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/u.test(zone) && quote.includes(zone)) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone }).format(0)
      return true
    } catch {
      return false
    }
  }
  if (zone === "Z" && /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/u.test(quote)) return true
  const offset = zone === "Z" || zone === "UTC" ? "+00:00" : zone
  if (offset === "+00:00" && /\b(?:UTC|GMT)(?![+-])\b/u.test(quote)) return true
  // 北京时间是明确时区名称，国家名等宽泛地理信息不能用于推算。
  if (
    ["Asia/Shanghai", "+08:00", "UTC+08:00"].includes(zone) &&
    /北京时间|Beijing time/iu.test(quote)
  )
    return true
  const match = /^(?:UTC)?([+-])(\d{2}):(\d{2})$/u.exec(offset)
  if (!match) return false
  const sign = match[1] === "+" ? "\\+" : "-"
  const minute = match[3] === "00" ? "(?::00|00)?" : `(?::${match[3]}|${match[3]})`
  return new RegExp(`(?:UTC|GMT)?${sign}0?${Number(match[2])}${minute}(?![:\\d])`, "u").test(quote)
}
