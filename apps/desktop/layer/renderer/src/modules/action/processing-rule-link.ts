import type { AutomationRule, Condition, ConditionSet, RuleSet } from "@follow/information-core"

const contextParam = "processingContext"

export type ProcessingRuleContext =
  | { kind: "source"; sourceId: string }
  | { kind: "category"; view: number; name: string }
  | { kind: "view"; view: number }

const isSupportedView = (value: number) => Number.isInteger(value) && value >= 0 && value <= 5

export function buildProcessingRuleUrl(context: ProcessingRuleContext, returnTo?: string) {
  const search = new URLSearchParams({ scope: "processing_service", [contextParam]: context.kind })
  if (context.kind === "source") search.set("sourceId", context.sourceId)
  if (context.kind === "category") {
    search.set("view", String(context.view))
    search.set("category", context.name)
  }
  if (context.kind === "view") search.set("view", String(context.view))
  if (returnTo && validReadingReturnPath(returnTo)) search.set("returnTo", returnTo)
  return `/action?${search.toString()}`
}

export function openProcessingRuleEditor(context: ProcessingRuleContext) {
  // 把原来的条目深链与筛选一并带回，保存后可返回相同阅读目标。
  window.location.assign(
    buildProcessingRuleUrl(
      context,
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ),
  )
}

function validReadingReturnPath(path: string) {
  // 返回入口限定同域阅读路径，不能被 query 注入外站跳转或管理操作。
  return /^\/(?:timeline(?:\/|\?|$)|events(?:\/|\?|$))[^\\]*$/u.test(path)
}

export function parseProcessingReadingReturn(search: string) {
  const path = new URLSearchParams(search).get("returnTo")
  return path && validReadingReturnPath(path) ? path : null
}

export function parseProcessingRuleContext(search: string): ProcessingRuleContext | null {
  // 只接受规则引擎已经支持的稳定标识，避免把展示标题误当作来源身份。
  const params = new URLSearchParams(search)
  const kind = params.get(contextParam)
  if (kind === "source") {
    const sourceId = params.get("sourceId")?.trim()
    return sourceId ? { kind, sourceId } : null
  }
  if (kind === "category") {
    const view = Number(params.get("view"))
    const name = params.get("category")?.trim()
    return name && isSupportedView(view) ? { kind, view, name } : null
  }
  if (kind === "view") {
    const view = Number(params.get("view"))
    return isSupportedView(view) ? { kind, view } : null
  }
  return null
}

export function processingRuleCondition(context: ProcessingRuleContext): ConditionSet {
  let condition: Condition
  if (context.kind === "source")
    condition = { field: "source_id", operator: "in", value: [context.sourceId] }
  else if (context.kind === "category")
    condition = {
      field: "category_ref",
      operator: "eq",
      value: { view: context.view, name: context.name },
    }
  else condition = { field: "view", operator: "eq", value: context.view }
  return { anyOf: [{ allOf: [condition] }] }
}

function containsContextCondition(rule: AutomationRule, context: ProcessingRuleContext) {
  if (!("anyOf" in rule.when)) return false
  return rule.when.anyOf.some((group) =>
    group.allOf.some((condition) => {
      if (context.kind === "source")
        return (
          condition.field === "source_id" &&
          condition.operator === "in" &&
          condition.value.includes(context.sourceId)
        )
      if (context.kind === "category")
        return (
          condition.field === "category_ref" &&
          condition.operator === "eq" &&
          condition.value.view === context.view &&
          condition.value.name === context.name
        )
      return (
        condition.field === "view" &&
        condition.operator === "eq" &&
        condition.value === context.view
      )
    }),
  )
}

export function findProcessingRuleForContext(
  rules: readonly AutomationRule[],
  context: ProcessingRuleContext,
) {
  return rules.find((rule) => containsContextCondition(rule, context)) ?? null
}

export function prepareProcessingRuleContext(
  ruleSet: RuleSet,
  context: ProcessingRuleContext,
  draft: { id: string; name: string },
) {
  const existing = findProcessingRuleForContext(ruleSet.rules, context)
  if (existing) return { ruleSet, ruleId: existing.id, created: false as const }

  // 这里只扩展内存中的编辑草稿；持久化仍由原有“保存”和“发布”按钮控制。
  const next: RuleSet = {
    ...ruleSet,
    rules: [
      ...ruleSet.rules,
      {
        id: draft.id,
        ownerId: ruleSet.ownerId,
        name: draft.name,
        enabled: true,
        order: Math.max(-1, ...ruleSet.rules.map((rule) => rule.order)) + 1,
        version: 1,
        executionLocation: "processing_service",
        when: processingRuleCondition(context),
        actions: [{ type: "ai_transform", prompt: "" }],
      },
    ],
  }
  return { ruleSet: next, ruleId: draft.id, created: true as const }
}

/** 去重管理沿用单规则编辑器，入口本身不写入后台。 */
export function buildDedupeManagementUrl(ruleId?: string) {
  const search = new URLSearchParams({ scope: "processing_service", dedupe: "1" })
  if (ruleId) search.set("ruleId", ruleId)
  return `/action?${search.toString()}`
}

export function prepareDedupeRule(
  draft: RuleSet,
  effective: RuleSet | null,
  coverage: readonly { ruleId: string; sourceKeys: string[] }[],
  name: string,
): AutomationRule | null {
  const existing = draft.rules.find((rule) =>
    rule.actions.some((action) => action.type === "ai_dedupe"),
  )
  if (existing) return structuredClone(existing)
  // 只从实际启用的后台 AI 规则取得已授权范围，空范围不能退化成全部来源。
  const authorizedIds = new Set(
    effective?.rules
      .filter(
        (rule) =>
          rule.enabled &&
          rule.actions.some((action) =>
            ["ai_transform", "ai_aggregate", "ai_dedupe"].includes(action.type),
          ),
      )
      .map((rule) => rule.id),
  )
  const sourceKeys = [
    ...new Set(
      coverage.filter((item) => authorizedIds.has(item.ruleId)).flatMap((item) => item.sourceKeys),
    ),
  ]
  if (!sourceKeys.length) return null
  return {
    id: crypto.randomUUID(),
    ownerId: draft.ownerId,
    name,
    enabled: false,
    order: Math.max(-1, ...draft.rules.map((rule) => rule.order)) + 1,
    version: 1,
    executionLocation: "processing_service",
    when: { anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: sourceKeys }] }] },
    actions: [{ type: "ai_dedupe", scope: { all: true } }],
  }
}
