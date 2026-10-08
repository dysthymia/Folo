import type {
  EntryAttention,
  RuleSet,
  SemanticEntity,
  TagAssessment,
} from "@follow/information-core"
import { matchConditions, semanticEntityId, semanticTagDefinition } from "@follow/information-core"

import type { ProcessingDecision } from "./processing-decision"

const substantiveTags = new Set([
  "event:security_incident",
  "event:incentive_airdrop",
  "event:tokenomics_change",
  "event:listing_trading_support",
  "event:regulation",
  "event:macro_change",
  "event:product_launch",
  "event:feature_update",
  "event:funding",
  "event:institutional_accumulation",
  "event:fund_flow",
  "event:business_expansion",
  "event:institutional_investment",
  "signal:original_data",
  "signal:reasoned_analysis",
  "form:tutorial",
  "form:review",
  "signal:concrete_experience",
])
const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase()
const hasEvidence = (ids: readonly string[], evidence: Record<string, string>) =>
  ids.length > 0 && ids.every((id) => Boolean(evidence[id]?.trim()))

// 只读当前客观证据和用户偏好；修改关注配置不需要新增语义请求或改动读态。
export function processingAttention(options: {
  config: RuleSet | null
  decision: ProcessingDecision
  assessments?: readonly TagAssessment[]
  entities?: readonly SemanticEntity[]
  now?: number
}): EntryAttention {
  const { config, decision } = options
  const profile = decision.semanticProfile
  const evidence = profile?.evidence ?? {}
  const deadlines = extractAttentionDeadlines(evidence)
  const result: EntryAttention = { level: "none", reasons: [], matchedWatchIds: [], deadlines }
  if (!config || config.global.attention?.enabled === false) return result
  const assessments = options.assessments ?? profile?.assessments ?? []
  const present = assessments.filter(
    (tag) =>
      tag.state === "present" &&
      (tag.confidence ?? 0) >= 0.9 &&
      semanticTagDefinition(tag.tagId)?.definitionVersion === tag.definitionVersion &&
      hasEvidence(tag.evidenceIds, evidence),
  )
  const entities = (options.entities ?? profile?.entities ?? []).filter(
    (entity) => entity.confidence >= 0.9 && hasEvidence(entity.evidenceIds, evidence),
  )
  const watches = config.global.attention?.watchlist ?? []
  const matchedWatches = watches.filter((watch) =>
    entities.some(
      (entity) =>
        watch.id === semanticEntityId(entity) ||
        [watch.name, ...watch.aliases].some((name) =>
          [entity.name, ...entity.aliases].map(normalize).includes(normalize(name)),
        ),
    ),
  )
  result.matchedWatchIds = matchedWatches.map((watch) => watch.id)
  const matchedEntities = entities.filter((entity) =>
    matchedWatches.some(
      (watch) =>
        watch.id === semanticEntityId(entity) ||
        [watch.name, ...watch.aliases].some((name) =>
          [entity.name, ...entity.aliases].map(normalize).includes(normalize(name)),
        ),
    ),
  )
  const watchEvidence = new Set(matchedEntities.flatMap((entity) => entity.evidenceIds))
  // 背景提到关注对象，不等于另一对象的事故或期限与用户相关；只能用明确共有证据。
  const relatedEvidence = (ids: readonly string[]) =>
    action !== undefined || ids.some((id) => watchEvidence.has(id))
  const context = { ...decision.context, entry_tag: [...assessments] }
  // 仍按显式顺序选择首条匹配关注规则；未知条件不能当作匹配。
  const matchedRule = [...config.rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.order - b.order)
    .find(
      (rule) =>
        rule.actions.some((action) => action.type === "attention") &&
        matchConditions(rule.when, context).state === "match",
    )
  const action = matchedRule?.actions.find((item) => item.type === "attention")
  const contribution = profile?.substantiveContribution
  const substantive =
    present.some((tag) => substantiveTags.has(tag.tagId) && relatedEvidence(tag.evidenceIds)) ||
    (contribution?.state === "present" &&
      (contribution.confidence ?? 0) >= 0.9 &&
      hasEvidence(contribution.evidenceIds, evidence) &&
      relatedEvidence(contribution.evidenceIds))
  const related = matchedWatches.length > 0 || action !== undefined
  const now = options.now ?? Date.now()
  const nearDeadline = deadlines.some(
    (deadline) =>
      relatedEvidence([deadline.evidenceId]) &&
      deadline.status === "known" &&
      deadline.at !== null &&
      Date.parse(deadline.at) > now &&
      Date.parse(deadline.at) - now <=
        (config.global.attention?.nearDeadlineHours ?? 48) * 3_600_000,
  )
  const security = present.some(
    (tag) => tag.tagId === "event:security_incident" && relatedEvidence(tag.evidenceIds),
  )
  if (related && (security || nearDeadline) && (action === undefined || action.level === "urgent"))
    result.level = "urgent"
  else if (related && (substantive || security || nearDeadline)) result.level = "important"
  if (result.level !== "none") {
    if (matchedWatches.length)
      result.reasons.push(`涉及关注清单：${matchedWatches.map((watch) => watch.name).join("、")}`)
    if (action?.type === "attention") result.reasons.push(action.reason)
    if (security) result.reasons.push("有原文证据支持的安全事件")
    if (nearDeadline) result.reasons.push("原文明确的截止时间已临近")
    if (result.level === "important" && action?.type === "attention" && action.level === "urgent")
      result.reasons.push("本条尚无安全事故或可计算近期限支撑，按重要关注显示")
    if (result.level === "important") result.reasons.push("存在有据的实质变化或可用贡献")
  }
  return result
}

// 缺年份、明确时间或时区时只保留原文期限；广告中的“紧急”不能生成可计算截止时间。
export function extractAttentionDeadlines(
  evidence: Record<string, string>,
): EntryAttention["deadlines"] {
  const result: EntryAttention["deadlines"] = []
  const seen = new Set<string>()
  for (const [evidenceId, quote] of Object.entries(evidence)) {
    for (const text of quote
      .split(/[。！？\n；;，,]/u)
      .map((part) => part.trim())
      .filter(Boolean)) {
      if (
        !/截止|截至|最后期限|领取|申领|有效期|deadline|claim|expires?|ends?\s+(?:at|on)|closes?\s+(?:at|on)/iu.test(
          text,
        )
      )
        continue
      if (
        !/\d{4}[-年/]\d|\d{1,2}月\d|\d{1,2}:\d{2}|\d{1,2}[-/]\d{1,2}|明天|后天|今日|今天|今晚|\d+\s*(?:小时|天|days?|hours?)|tomorrow|today|tonight/iu.test(
          text,
        )
      )
        continue
      if (seen.has(text)) continue
      seen.add(text)
      const isEnd =
        /截止|截至|最后期限|deadline|expires?|ends?\s+(?:at|on)|closes?\s+(?:at|on)|claim\s+(?:by|until|before)/iu.test(
          text,
        )
      const match =
        /(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})(?:日[T\s]*|[T\s]+)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2}|(?:UTC|GMT)(?:\s*[+-]\d{1,2}(?::\d{2})?)?|北京时间|中国标准时间)/iu.exec(
          text,
        )
      let at: string | null = null
      if (isEnd && match) {
        const [, year, month, day, hour, minute, second = "00", rawZone] = match
        const zone = zoneOffset(rawZone!)
        const iso = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}T${hour!.padStart(2, "0")}:${minute}:${second}${zone}`
        // Date.parse 会纠正不存在的日历日期，必须在转换前单独检查年月日。
        const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
        if (
          calendar.getUTCFullYear() === Number(year) &&
          calendar.getUTCMonth() === Number(month) - 1 &&
          calendar.getUTCDate() === Number(day) &&
          Number(hour) < 24 &&
          Number(minute) < 60 &&
          Number(second) < 60 &&
          Number.isFinite(Date.parse(iso))
        )
          at = iso
      }
      result.push({
        status: at ? "known" : "unknown",
        at,
        text,
        evidenceId,
        reason: at
          ? "原文明确给出绝对日期、截止时间和时区"
          : "原文期限缺少可确定的年份、截止时间或时区，未推测",
      })
    }
  }
  return result
}

function zoneOffset(zone: string): string {
  if (/^(?:Z|UTC|GMT)$/iu.test(zone)) return "Z"
  if (/^(?:北京时间|中国标准时间)$/u.test(zone)) return "+08:00"
  const offset = zone.replace(/^(?:UTC|GMT)\s*/iu, "")
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/u.exec(offset)
  return match ? `${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}` : offset
}

// 多材料综述只汇总成员已有关注，不改综述读态或原文展示资格。
export function mergeAttention(items: readonly EntryAttention[]): EntryAttention {
  return {
    level: items.some((item) => item.level === "urgent")
      ? "urgent"
      : items.some((item) => item.level === "important")
        ? "important"
        : "none",
    reasons: [...new Set(items.flatMap((item) => item.reasons))],
    matchedWatchIds: [...new Set(items.flatMap((item) => item.matchedWatchIds))],
    deadlines: [
      ...new Map(
        items.flatMap((item) => item.deadlines).map((deadline) => [deadline.text, deadline]),
      ).values(),
    ],
  }
}
