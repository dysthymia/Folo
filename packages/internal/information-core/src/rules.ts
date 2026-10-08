import { RE2JS } from "re2js"
import { z } from "zod"

import type { SemanticTagId, TagAssessment } from "./semantic-tags"
import {
  semanticTagDefinition,
  semanticTagIds,
  semanticTagIdSchema,
  tagAssessmentSchema,
} from "./semantic-tags"

// 隐藏预设从高置信判断起步；规则可显式调整阈值。
export const defaultSemanticMinConfidence = 0.9

const identifier = z.string().trim().min(1).max(200)
const view = z.number().int().min(0).max(5)
const textFields = z.enum([
  "title",
  "category",
  "site_url",
  "feed_url",
  "entry_title",
  "entry_content",
  "entry_url",
  "entry_author",
  "language",
  "platform",
  "content_completeness",
])
const textCondition = z
  .object({
    field: textFields,
    operator: z.enum(["eq", "not_eq", "contains", "not_contains", "regex"]),
    value: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine((condition, context) => {
    if (condition.operator !== "regex") return
    // 正则使用线性匹配引擎，并限制模式大小；不把复杂表达式交给回溯式 RegExp。
    try {
      if (condition.value.length > 256) throw new Error("regex_too_long")
      RE2JS.compile(condition.value)
    } catch {
      context.addIssue({ code: "custom", path: ["value"], message: "invalid_or_unsupported_regex" })
    }
  })
const numericCondition = z
  .object({
    field: z.enum(["entry_media_length", "entry_attachments_duration", "visible_length", "view"]),
    operator: z.enum(["eq", "not_eq", "gt", "lt", "gte", "lte"]),
    value: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (condition.field === "view" && !view.safeParse(condition.value).success)
      context.addIssue({ code: "custom", path: ["value"], message: "invalid_view" })
  })
const selectionCondition = z
  .object({
    field: z.enum(["source_id", "subscription_tag", "list_id"]),
    operator: z.enum(["in", "not_in", "contains_any", "contains_all", "not_contains_any"]),
    value: z.array(identifier).min(1).max(1000),
  })
  .strict()
export const conditionSchema = z.union([
  textCondition,
  numericCondition,
  selectionCondition,
  z
    .object({
      field: z.literal("entry_tag"),
      operator: z.enum(["contains_any", "contains_all", "not_contains_any"]),
      value: z.array(semanticTagIdSchema).min(1).max(1000),
      minConfidence: z.number().finite().min(0).max(1).optional(),
    })
    .strict(),
  z
    .object({
      field: z.literal("category_ref"),
      operator: z.enum(["eq", "not_eq"]),
      value: z.object({ view, name: identifier }).strict(),
    })
    .strict(),
  z
    .object({
      field: z.literal("status"),
      operator: z.enum(["eq", "not_eq"]),
      value: z.enum(["read", "unread", "collected"]),
    })
    .strict(),
  z
    .object({
      field: z.literal("updated_at"),
      operator: z.enum(["gt", "gte", "lt", "lte", "eq", "not_eq"]),
      value: z.iso.datetime({ offset: true }),
    })
    .strict(),
])
// ALL 必须显式写出；空条件组、非法字段和半成品条件均不得退化为全局匹配。
export const conditionSetSchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z
    .object({
      anyOf: z
        .array(z.object({ allOf: z.array(conditionSchema).min(1).max(30) }).strict())
        .min(1)
        .max(30),
    })
    .strict(),
])
export const presentationPolicySchema = z
  .object({
    standalone: z.enum(["auto", "always", "never"]).optional(),
    aggregation: z.enum(["allow", "deny"]).optional(),
    rewrite: z.enum(["allow", "deny"]).optional(),
  })
  .strict()
export const presetRefSchema = z
  .object({ id: identifier, version: z.number().int().positive() })
  .strict()
export const actionSchema = z.discriminatedUnion("type", [
  // 标签分类只申请客观判断，不改变阅读可见性或自动创建综述。
  z
    .object({
      type: z.literal("ai_classify"),
      // 上限随稳定标签清单扩展，每个标签只能申请一次。
      tagIds: z
        .array(semanticTagIdSchema)
        .min(1)
        .max(semanticTagIds.length)
        .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate_tag_ids" }),
    })
    .strict(),
  // 普通本地动作继续由客户端执行，不生成模型指令或触发模型调用。
  // 虚化只改变客户端的显示强度，沿用普通动作的条件匹配和离线缓存。
  z.object({ type: z.literal("local_filter"), mode: z.enum(["block", "silence", "dim"]) }).strict(),
  z
    .object({
      type: z.literal("ai_transform"),
      prompt: z.string().min(1).max(30000),
      preset: presetRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ai_aggregate"),
      createPrompt: z.string().min(1).max(30000),
      updatePrompt: z.string().max(30000),
      scope: conditionSetSchema,
      mode: z.enum(["same_event", "topic"]),
      presets: z
        .object({ create: presetRefSchema.optional(), update: presetRefSchema.optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ai_dedupe"),
      // 判重标准是固定的保守分类器，用户只决定参与范围，不撰写 Prompt。
      scope: conditionSetSchema,
    })
    .strict(),
  z.object({ type: z.literal("presentation"), policy: presentationPolicySchema }).strict(),
  z
    .object({
      type: z.literal("reading_decision"),
      visibility: z.enum(["show", "hide"]).optional(),
      aggregationEligibility: z.enum(["allow", "deny"]).optional(),
    })
    .strict()
    .refine(
      (action) => action.visibility !== undefined || action.aggregationEligibility !== undefined,
      { message: "empty_action" },
    ),
  z
    .object({
      type: z.literal("display"),
      language: identifier.optional(),
      summaryMaxGraphemes: z.number().int().min(1).max(30000).optional(),
    })
    .strict(),
])
export const ruleSchema = z
  .object({
    id: identifier,
    ownerId: identifier,
    name: identifier,
    enabled: z.boolean(),
    order: z.number().int().nonnegative(),
    when: conditionSetSchema,
    actions: z.array(actionSchema).min(1).max(30),
    version: z.number().int().positive(),
    executionLocation: z.literal("processing_service"),
  })
  .strict()
  .superRefine((rule, context) => {
    const assigned = new Set<string>()
    rule.actions.forEach((action, index) => {
      const fields =
        action.type === "presentation"
          ? Object.keys(action.policy)
          : action.type === "reading_decision"
            ? [
                ...(action.visibility === undefined ? [] : ["standalone"]),
                ...(action.aggregationEligibility === undefined ? [] : ["aggregation"]),
              ]
            : action.type === "display"
              ? Object.keys(action).filter((key) => key !== "type")
              : action.type === "ai_aggregate" ||
                  action.type === "ai_dedupe" ||
                  action.type === "ai_classify"
                ? [action.type]
                : []
      // 空的显式动作属于未完成编辑，不能发布为貌似有效的规则。
      if ((action.type === "presentation" || action.type === "display") && fields.length === 0)
        context.addIssue({ code: "custom", path: ["actions", index], message: "empty_action" })
      for (const field of fields) {
        if (assigned.has(field))
          context.addIssue({
            code: "custom",
            path: ["actions", index],
            message: `duplicate_setting:${field}`,
          })
        assigned.add(field)
      }
    })
  })
// 创建接口只省略服务生成字段，完整规则仍在保存草稿时统一校验。
export const createRuleSchema = z
  .object({
    name: ruleSchema.shape.name,
    enabled: ruleSchema.shape.enabled,
    when: ruleSchema.shape.when,
    actions: ruleSchema.shape.actions,
    executionLocation: ruleSchema.shape.executionLocation,
  })
  .strict()
export const ruleSetSchema = z
  .object({
    formatVersion: z.union([z.literal(4), z.literal(5)]),
    ownerId: identifier,
    global: z
      .object({
        markdown: z.string().max(60000),
        version: z.number().int().positive(),
        preset: presetRefSchema.optional(),
      })
      .strict(),
    rules: z.array(ruleSchema).max(200),
  })
  .strict()
  .superRefine((ruleSet, context) => {
    const ids = new Set<string>()
    const orders = new Set<number>()
    ruleSet.rules.forEach((rule, index) => {
      if (ids.has(rule.id) || orders.has(rule.order) || rule.ownerId !== ruleSet.ownerId)
        context.addIssue({
          code: "custom",
          path: ["rules", index],
          message: "duplicate_rule_order_or_wrong_owner",
        })
      // 新语义契约必须显式使用 v5，避免旧客户端误读成即时本地过滤。
      if (
        ruleSet.formatVersion === 4 &&
        (ruleRequiresSemantics(rule) ||
          rule.actions.some((action) => action.type === "reading_decision"))
      )
        context.addIssue({
          code: "custom",
          path: ["rules", index],
          message: "semantic_rules_require_v5",
        })
      ids.add(rule.id)
      orders.add(rule.order)
    })
  })
export type Condition = z.infer<typeof conditionSchema>
export type ConditionSet = z.infer<typeof conditionSetSchema>
export type AutomationRule = z.infer<typeof ruleSchema>
export type RuleSet = z.infer<typeof ruleSetSchema>
export type PresentationPolicy = z.infer<typeof presentationPolicySchema>
export const ruleUsesAI = (rule: Pick<AutomationRule, "actions">): boolean =>
  rule.actions.some((action) =>
    ["ai_classify", "ai_transform", "ai_aggregate", "ai_dedupe"].includes(action.type),
  )
export type MatchState = "match" | "no_match" | "unknown"
export type RuleInput = Partial<Record<z.infer<typeof textFields>, string | null>> & {
  source_id: string | null
  contextId: string
  view?: number | null
  category_ref?: { view: number; name: string } | null
  subscription_tag?: string[] | null
  entry_tag?: TagAssessment[] | null
  // 每个列表单独记录资格，未同步／不完整必须保留 null，不能变成空集合。
  list_id?: Record<string, boolean | null>
  read?: boolean | null
  collected?: boolean | null
  entry_media_length?: number | null
  entry_attachments_duration?: number | null
  visible_length?: number | null
  updated_at?: string | null
}

const state = (matches: boolean): MatchState => (matches ? "match" : "no_match")
export const andStates = (states: MatchState[]): MatchState =>
  states.includes("no_match") ? "no_match" : states.includes("unknown") ? "unknown" : "match"
export const orStates = (states: MatchState[]): MatchState =>
  states.includes("match") ? "match" : states.includes("unknown") ? "unknown" : "no_match"

function compare(actual: number | string, expected: number | string, operator: string): boolean {
  switch (operator) {
    case "eq":
      return actual === expected
    case "not_eq":
      return actual !== expected
    case "gt":
      return actual > expected
    case "lt":
      return actual < expected
    case "gte":
      return actual >= expected
    case "lte":
      return actual <= expected
    case "contains":
      return String(actual).includes(String(expected))
    case "not_contains":
      return !String(actual).includes(String(expected))
    case "regex":
      return RE2JS.compile(String(expected)).matcher(String(actual)).find()
    default:
      throw new Error("unsupported_operator")
  }
}

function matchCondition(condition: Condition, input: RuleInput): MatchState {
  if (condition.field === "entry_tag") {
    const checks = condition.value.map((id): MatchState => {
      const definition = semanticTagDefinition(id)
      const assessments = input.entry_tag?.filter((item) => item.tagId === id) ?? []
      // 重复、过期或低置信判断均保留未知；缺项绝不等价于 absent。
      if (!definition?.enabled || assessments.length !== 1) return "unknown"
      const parsed = tagAssessmentSchema.safeParse(assessments[0])
      if (!parsed.success) return "unknown"
      const assessment = parsed.data
      if (
        assessment.definitionVersion !== definition.definitionVersion ||
        assessment.state === "unknown" ||
        assessment.confidence === null ||
        assessment.confidence < (condition.minConfidence ?? defaultSemanticMinConfidence)
      )
        return "unknown"
      return state(assessment.state === "present")
    })
    const result = condition.operator === "contains_all" ? andStates(checks) : orStates(checks)
    return condition.operator === "not_contains_any" && result !== "unknown"
      ? result === "match"
        ? "no_match"
        : "match"
      : result
  }
  if (condition.field === "category_ref") {
    const category = input.category_ref
    if (!category) return "unknown"
    const equal = category.view === condition.value.view && category.name === condition.value.name
    return state(condition.operator === "eq" ? equal : !equal)
  }
  if (condition.field === "status") {
    const actual = condition.value === "collected" ? input.collected : input.read
    if (actual === null || actual === undefined) return "unknown"
    const equal = condition.value === "unread" ? !actual : actual
    return state(condition.operator === "eq" ? equal : !equal)
  }
  if (
    condition.field === "source_id" ||
    condition.field === "subscription_tag" ||
    condition.field === "list_id"
  ) {
    const checks = condition.value.map((id): MatchState => {
      if (condition.field === "source_id")
        return input.source_id === null ? "unknown" : state(input.source_id === id)
      if (condition.field === "subscription_tag")
        return input.subscription_tag == null
          ? "unknown"
          : state(input.subscription_tag.includes(id))
      const member = input.list_id?.[id]
      return member == null ? "unknown" : state(member)
    })
    const result = condition.operator === "contains_all" ? andStates(checks) : orStates(checks)
    if (condition.operator === "not_in" || condition.operator === "not_contains_any")
      return result === "unknown" ? result : result === "match" ? "no_match" : "match"
    return result
  }
  const actual = input[condition.field]
  if (
    actual === null ||
    actual === undefined ||
    (typeof actual === "number" && !Number.isFinite(actual))
  )
    return "unknown"
  if (condition.field === "updated_at") {
    const timestamp = Date.parse(String(actual))
    return Number.isFinite(timestamp)
      ? state(compare(timestamp, Date.parse(condition.value), condition.operator))
      : "unknown"
  }
  if (Array.isArray(condition.value)) throw new Error("unsupported_condition")
  return state(compare(actual, condition.value, condition.operator))
}

export function matchConditions(conditions: ConditionSet, input: RuleInput) {
  const parsed = conditionSetSchema.parse(conditions)
  if ("all" in parsed) return { state: "match" as MatchState, groups: [] }
  const groups = parsed.anyOf.map((group) =>
    group.allOf.map((condition) => ({ condition, state: matchCondition(condition, input) })),
  )
  return {
    state: orStates(groups.map((group) => andStates(group.map((item) => item.state)))),
    groups,
  }
}

// 语义依赖与是否包含 AI 动作分别计算，纯阅读动作也能触发必要的分类。
const conditionTagIds = (conditions: ConditionSet): SemanticTagId[] =>
  "all" in conditions
    ? []
    : conditions.anyOf.flatMap((group) =>
        group.allOf.flatMap((condition) =>
          condition.field === "entry_tag" ? condition.value : [],
        ),
      )
const ruleConditionSets = (rule: Pick<AutomationRule, "when" | "actions">): ConditionSet[] => [
  rule.when,
  ...rule.actions.flatMap((action) =>
    action.type === "ai_aggregate" || action.type === "ai_dedupe" ? [action.scope] : [],
  ),
]
export const ruleRequiresSemantics = (rule: Pick<AutomationRule, "when" | "actions">): boolean =>
  rule.actions.some((action) => action.type === "ai_classify") ||
  ruleConditionSets(rule).some((conditions) => conditionTagIds(conditions).length > 0)

export function requiredSemanticTagIds(ruleSet: RuleSet, input?: RuleInput): SemanticTagId[] {
  const ids = new Set<SemanticTagId>()
  const presemanticInput = input ? { ...input, entry_tag: null } : undefined
  for (const rule of ruleSet.rules) {
    if (
      !rule.enabled ||
      (presemanticInput && matchConditions(rule.when, presemanticInput).state === "no_match")
    )
      continue
    // 显式分类动作无需借隐藏条件请求标签，仍由本条规则的来源/类别约束选材。
    for (const action of rule.actions)
      if (action.type === "ai_classify") for (const id of action.tagIds) ids.add(id)
    for (const conditions of ruleConditionSets(rule)) {
      if (presemanticInput && matchConditions(conditions, presemanticInput).state === "no_match")
        continue
      for (const id of conditionTagIds(conditions)) ids.add(id)
    }
  }
  return [...ids].sort()
}

// 输入必须是已清理 HTML 的原帖正文；缺失或不完整材料不计为零字。
export function visibleLength(text: string | null | undefined, complete: boolean): number | null {
  if (text == null || !complete) return null
  const visible = text.replace(/(?:https?:\/\/|www\.)[^\s<>]+/gu, "").replace(/\s/gu, "")
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(visible)].length
}

export function compileInstructions(ruleSet: RuleSet, input: RuleInput) {
  const parsed = ruleSetSchema.parse(ruleSet)
  const matched: AutomationRule[] = []
  const pending: AutomationRule[] = []
  const matches = parsed.rules
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.order - b.order)
    .map((rule) => {
      const result = matchConditions(rule.when, input)
      if (result.state === "match") matched.push(rule)
      else if (result.state === "unknown") pending.push(rule)
      return { ruleId: rule.id, ...result }
    })
  const policy: PresentationPolicy = {}
  const winnerOrders: Partial<Record<keyof PresentationPolicy, number>> = {}
  const display: { language?: string; summaryMaxGraphemes?: number } = {}
  const resolvedBy: Record<string, string> = {}
  const shadowed: { field: string; ruleId: string; winnerRuleId: string }[] = []
  for (const rule of matched) {
    for (const action of rule.actions) {
      const explicit =
        action.type === "presentation"
          ? action.policy
          : action.type === "reading_decision"
            ? {
                ...(action.visibility === undefined
                  ? {}
                  : { standalone: action.visibility === "show" ? "always" : "never" }),
                ...(action.aggregationEligibility === undefined
                  ? {}
                  : { aggregation: action.aggregationEligibility }),
              }
            : action.type === "display"
              ? action
              : null
      if (!explicit) continue
      for (const field of Object.keys(explicit).filter(
        (key) => key !== "type" && explicit[key as keyof typeof explicit] !== undefined,
      )) {
        if (resolvedBy[field])
          shadowed.push({ field, ruleId: rule.id, winnerRuleId: resolvedBy[field]! })
        else {
          resolvedBy[field] = rule.id
          if (action.type === "presentation" || action.type === "reading_decision") {
            Object.assign(policy, { [field]: explicit[field as keyof typeof explicit] })
            winnerOrders[field as keyof PresentationPolicy] = rule.order
          }
          if (action.type === "display")
            Object.assign(display, { [field]: action[field as "language" | "summaryMaxGraphemes"] })
        }
      }
    }
  }
  // 只有排在已知赢家之前的未知规则能悬置该字段，互不相关的字段继续发布。
  const policyFields: Array<keyof PresentationPolicy> = ["standalone", "aggregation", "rewrite"]
  const pendingPolicyFields = policyFields.filter((field) =>
    pending.some((rule) => {
      if (winnerOrders[field] !== undefined && rule.order > winnerOrders[field]!) return false
      return rule.actions.some((action) => {
        if (action.type === "ai_transform") return true
        if (action.type === "presentation") return action.policy[field] !== undefined
        if (action.type === "reading_decision")
          return field === "standalone"
            ? action.visibility !== undefined
            : field === "aggregation" && action.aggregationEligibility !== undefined
        if (action.type === "ai_aggregate") return field === "aggregation"
        if (action.type === "ai_dedupe") return field === "standalone"
        return false
      })
    }),
  )
  const blocksFinalPresentation = pendingPolicyFields.length > 0
  return {
    global: parsed.global,
    matched,
    pendingRuleIds: pending.map((rule) => rule.id),
    matches,
    policy,
    display,
    resolvedBy,
    shadowed,
    blocksFinalPresentation,
    pendingPolicyFields,
    semanticTagIds: requiredSemanticTagIds(parsed, input),
    transformations: matched.flatMap((rule) =>
      rule.actions
        .filter((action) => action.type === "ai_transform")
        .map((action) => ({
          ruleId: rule.id,
          version: rule.version,
          order: rule.order,
          prompt: action.prompt,
        })),
    ),
    aggregates: matched.flatMap((rule) =>
      rule.actions
        .filter((action) => action.type === "ai_aggregate")
        .map((action) => ({
          ruleId: rule.id,
          version: rule.version,
          order: rule.order,
          ...action,
          updatePrompt: action.updatePrompt || action.createPrompt,
        })),
    ),
    dedupes: matched.flatMap((rule) =>
      rule.actions
        .filter((action) => action.type === "ai_dedupe")
        .map((action) => ({
          ruleId: rule.id,
          version: rule.version,
          order: rule.order,
          scope: action.scope,
        })),
    ),
  }
}
