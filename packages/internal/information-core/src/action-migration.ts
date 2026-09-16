import type { AutomationRule, ConditionSet } from "./rules"
import { actionSchema, conditionSchema } from "./rules"

export type MigratedActionRule = Pick<
  AutomationRule,
  "name" | "enabled" | "when" | "actions" | "executionLocation"
>

export type ActionMigrationIssueCode =
  | "invalid_export"
  | "unknown_field"
  | "invalid_rule"
  | "unsupported_condition"
  | "unsupported_action"
  | "external_side_effect"

export type ActionMigrationIssue = {
  code: ActionMigrationIssueCode
  path: string
}

export type ActionMigrationRow = {
  index: number
  name: string
  status: "supported" | "unsupported"
  legacyCondition?: unknown
  legacyResult?: unknown
  rule?: MigratedActionRule
  issues: ActionMigrationIssue[]
}

export type ActionMigrationPreview = {
  valid: boolean
  rows: ActionMigrationRow[]
  supported: MigratedActionRule[]
  fatalIssues: ActionMigrationIssue[]
}

type RecordValue = Record<string, unknown>

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: RecordValue, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

const issue = (code: ActionMigrationIssueCode, path: string): ActionMigrationIssue => ({
  code,
  path,
})

const conditionFieldsWithNumericValues = new Set([
  "entry_media_length",
  "entry_attachments_duration",
  "visible_length",
  "view",
])

const conditionFieldsWithListValues = new Set(["source_id", "subscription_tag", "list_id"])

const migrateCondition = (value: unknown, path: string) => {
  const issues: ActionMigrationIssue[] = []
  if (!Array.isArray(value)) {
    issues.push(issue("unsupported_condition", path))
    return { condition: null, issues }
  }

  // 旧 Actions 用 [] 或 [[{}]] 表示没有筛选；只识别这个完整占位结构，半成品不会变成 ALL。
  if (
    value.length === 0 ||
    (value.length === 1 &&
      Array.isArray(value[0]) &&
      value[0].length === 1 &&
      isRecord(value[0][0]) &&
      Object.keys(value[0][0]).length === 0)
  )
    return { condition: { all: true } as const, issues }

  if (!value.every((group) => Array.isArray(group))) {
    issues.push(issue("unsupported_condition", path))
    return { condition: null, issues }
  }

  const anyOf: Array<{ allOf: Array<NonNullable<ReturnType<typeof conditionSchema.parse>>> }> = []
  value.forEach((group, groupIndex) => {
    if (!Array.isArray(group) || group.length === 0) {
      issues.push(issue("unsupported_condition", `${path}[${groupIndex}]`))
      return
    }
    const allOf: Array<NonNullable<ReturnType<typeof conditionSchema.parse>>> = []
    group.forEach((rawCondition, conditionIndex) => {
      const conditionPath = `${path}[${groupIndex}][${conditionIndex}]`
      if (!isRecord(rawCondition) || !hasOnlyKeys(rawCondition, ["field", "operator", "value"])) {
        issues.push(issue("unsupported_condition", conditionPath))
        return
      }

      const candidate: RecordValue = { ...rawCondition }
      if (typeof candidate.field !== "string" || typeof candidate.operator !== "string") {
        issues.push(issue("unsupported_condition", conditionPath))
        return
      }
      // 旧端使用回溯式 RegExp，新引擎使用 RE2JS；即使模式当前都能解析，也不能假定边界语义相同。
      if (candidate.operator === "regex") {
        issues.push(issue("unsupported_condition", conditionPath))
        return
      }
      if (
        conditionFieldsWithNumericValues.has(candidate.field) &&
        typeof candidate.value === "string"
      ) {
        const numericValue = Number(candidate.value)
        if (Number.isFinite(numericValue)) candidate.value = numericValue
      }
      if (conditionFieldsWithListValues.has(candidate.field) && typeof candidate.value === "string")
        candidate.value = [candidate.value]

      const parsed = conditionSchema.safeParse(candidate)
      if (!parsed.success) {
        issues.push(issue("unsupported_condition", conditionPath))
        return
      }
      allOf.push(parsed.data)
    })
    if (allOf.length > 0 && allOf.length === group.length) anyOf.push({ allOf })
  })

  if (issues.length > 0 || anyOf.length !== value.length)
    return {
      condition: null,
      issues: issues.length > 0 ? issues : [issue("unsupported_condition", path)],
    }
  return { condition: { anyOf } as ConditionSet, issues }
}

const externalActions = new Set([
  "block",
  "silence",
  "webhooks",
  "newEntryNotification",
  "star",
  "disabled",
])

const knownLegacyActions = new Set([
  "summary",
  "translation",
  "readability",
  "sourceContent",
  "rewriteRules",
  ...externalActions,
])

const migrateExplicitAction = (
  type: "ai_transform" | "ai_aggregate" | "presentation" | "display",
  value: unknown,
) => {
  if (typeof value === "string" && type === "ai_transform")
    return actionSchema.safeParse({ type, prompt: value })
  if (!isRecord(value)) return { success: false as const, error: null }
  return actionSchema.safeParse({ ...value, type })
}

const migrateActions = (value: unknown, path: string) => {
  const issues: ActionMigrationIssue[] = []
  if (!isRecord(value)) {
    issues.push(issue("invalid_rule", path))
    return { actions: null, issues }
  }

  const actions: AutomationRule["actions"] = []
  const keys = Object.keys(value)
  if (keys.includes("actions")) {
    // 允许旧导出附带明确为 false 的已知动作；其它附带字段仍必须逐项拒绝。
    for (const key of keys.filter((item) => item !== "actions")) {
      const rawAction = value[key]
      if (!knownLegacyActions.has(key)) {
        issues.push(issue("unknown_field", `${path}.${key}`))
      } else if (typeof rawAction !== "boolean" || rawAction) {
        issues.push(
          issue(
            externalActions.has(key) ? "external_side_effect" : "unsupported_action",
            `${path}.${key}`,
          ),
        )
      }
    }
    if (!Array.isArray(value.actions)) {
      issues.push(issue("unsupported_action", `${path}.actions`))
      return { actions: null, issues }
    }
    const parsed = value.actions.map((item) => actionSchema.safeParse(item))
    parsed.forEach((item, index) => {
      if (!item.success) issues.push(issue("unsupported_action", `${path}.actions[${index}]`))
      else actions.push(item.data)
    })
    if (actions.length === 0 && issues.length === 0) issues.push(issue("unsupported_action", path))
    return { actions: issues.length === 0 ? actions : null, issues }
  }

  for (const key of keys) {
    const rawAction = value[key]
    if (key === "ai_transform" || key === "aiTransform") {
      const parsed = migrateExplicitAction("ai_transform", rawAction)
      if (!parsed.success) issues.push(issue("unsupported_action", `${path}.${key}`))
      else actions.push(parsed.data)
      continue
    }
    if (key === "ai_aggregate" || key === "aiAggregate") {
      const parsed = migrateExplicitAction("ai_aggregate", rawAction)
      if (!parsed.success) issues.push(issue("unsupported_action", `${path}.${key}`))
      else actions.push(parsed.data)
      continue
    }
    if (key === "presentation" || key === "display") {
      const parsed = migrateExplicitAction(key, rawAction)
      if (!parsed.success) issues.push(issue("unsupported_action", `${path}.${key}`))
      else actions.push(parsed.data)
      continue
    }
    if (knownLegacyActions.has(key)) {
      if (typeof rawAction !== "boolean") {
        issues.push(
          issue(
            externalActions.has(key) ? "external_side_effect" : "unsupported_action",
            `${path}.${key}`,
          ),
        )
      } else if (rawAction) {
        issues.push(
          issue(
            externalActions.has(key) ? "external_side_effect" : "unsupported_action",
            `${path}.${key}`,
          ),
        )
      }
      continue
    }
    issues.push(issue("unknown_field", `${path}.${key}`))
  }

  if (actions.length === 0 && issues.length === 0) issues.push(issue("unsupported_action", path))
  return { actions: issues.length === 0 ? actions : null, issues }
}

const migrateRule = (value: unknown, index: number): ActionMigrationRow => {
  const rawName = isRecord(value) && typeof value.name === "string" ? value.name : `#${index + 1}`
  const legacyCondition = isRecord(value) ? value.condition : undefined
  const legacyResult = isRecord(value) ? value.result : undefined
  const issues: ActionMigrationIssue[] = []
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "condition", "result"])) {
    issues.push(issue(isRecord(value) ? "unknown_field" : "invalid_rule", `rules[${index}]`))
    return { index, name: rawName, status: "unsupported", legacyCondition, legacyResult, issues }
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0)
    issues.push(issue("invalid_rule", `rules[${index}].name`))
  const condition = migrateCondition(value.condition, `rules[${index}].condition`)
  issues.push(...condition.issues)
  const actions = migrateActions(value.result, `rules[${index}].result`)
  issues.push(...actions.issues)
  if (issues.length > 0 || !condition.condition || !actions.actions)
    return { index, name: rawName, status: "unsupported", legacyCondition, legacyResult, issues }
  return {
    index,
    name: rawName,
    status: "supported",
    legacyCondition,
    legacyResult,
    rule: {
      name: rawName,
      enabled: true,
      when: condition.condition,
      actions: actions.actions,
      executionLocation: "processing_service",
    },
    issues,
  }
}

export const previewActionMigration = (input: unknown): ActionMigrationPreview => {
  const fatalIssues: ActionMigrationIssue[] = []
  if (!isRecord(input) || !hasOnlyKeys(input, ["version", "exportDate", "rules"])) {
    fatalIssues.push(issue("invalid_export", "export"))
    return { valid: false, rows: [], supported: [], fatalIssues }
  }
  if (input.version !== "1.0" || !Array.isArray(input.rules)) {
    fatalIssues.push(issue("invalid_export", "export"))
    return { valid: false, rows: [], supported: [], fatalIssues }
  }
  if (input.exportDate !== undefined && typeof input.exportDate !== "string")
    fatalIssues.push(issue("invalid_export", "export.exportDate"))
  const rows = input.rules.map(migrateRule)
  return {
    valid: fatalIssues.length === 0,
    rows,
    supported: rows.flatMap((row) => (row.rule ? [row.rule] : [])),
    fatalIssues,
  }
}
