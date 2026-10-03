import type { AutomationRule, Condition, ConditionSet } from "./rules"
import { conditionSchema, ruleSchema } from "./rules"

export type LocalActionUpgradeIssue = { path: string; reason: string }
export type LocalActionUpgradeResult =
  { success: true; rule: AutomationRule } | { success: false; issues: LocalActionUpgradeIssue[] }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const textFields = new Set([
  "category",
  "entry_author",
  "entry_content",
  "entry_title",
  "entry_url",
  "feed_url",
  "site_url",
  "title",
])
const numericFields = new Set(["entry_media_length", "entry_attachments_duration", "view"])

// 旧状态是“收藏优先”的三态字符串，不能直接替换成相互独立的 read/collected 布尔判断。
const legacyStatusConditions = (status: "read" | "unread" | "collected"): Condition[] =>
  status === "collected"
    ? [{ field: "status", operator: "eq", value: "collected" }]
    : [
        { field: "status", operator: "eq", value: status },
        { field: "status", operator: "not_eq", value: "collected" },
      ]

function convertCondition(value: unknown): Condition[][] | null {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["field", "operator", "value"].includes(key)) ||
    typeof value.field !== "string" ||
    typeof value.operator !== "string" ||
    (typeof value.value !== "string" && typeof value.value !== "number") ||
    String(value.value).length === 0
  )
    return null
  const { field, operator } = value
  // 旧规则使用 JS 正则，新匹配器使用 RE2；不以自动改写假定两种引擎语义一致。
  if (operator === "regex") return null
  if (field === "status") {
    if (!["eq", "not_eq", "contains", "not_contains"].includes(operator)) return null
    const expected = String(value.value)
    return (["read", "unread", "collected"] as const)
      .filter((status) => {
        if (operator === "eq") return status === expected
        if (operator === "not_eq") return status !== expected
        if (operator === "contains") return status.includes(expected)
        return !status.includes(expected)
      })
      .map(legacyStatusConditions)
  }
  const numeric = numericFields.has(field)
  if (
    (!numeric && !textFields.has(field)) ||
    !(
      numeric ? ["eq", "not_eq", "gt", "lt"] : ["eq", "not_eq", "contains", "not_contains"]
    ).includes(operator)
  )
    return null
  const candidate = conditionSchema.safeParse({
    field,
    operator,
    value: numeric ? Number(value.value) : String(value.value),
  })
  return candidate.success ? [[candidate.data]] : null
}

/** 将旧本地规则升级成唯一服务端规则；任何未识别语义都会返回原因，绝不退化成全部匹配。 */
export function convertLocalActionRule(
  input: unknown,
  options: { ownerId: string; order: number },
): LocalActionUpgradeResult {
  const issues: LocalActionUpgradeIssue[] = []
  const fail = (path: string, reason: string) => issues.push({ path, reason })
  if (!record(input)) return { success: false, issues: [{ path: "rule", reason: "invalid_rule" }] }
  if (typeof input.localId !== "string" || !/^[\w-]{1,160}$/.test(input.localId))
    fail("localId", "missing_stable_local_id")
  if (!Array.isArray(input.condition)) fail("condition", "invalid_condition_groups")

  const anyOf: Array<{ allOf: Condition[] }> = []
  if (Array.isArray(input.condition)) {
    input.condition.forEach((group, groupIndex) => {
      if (!Array.isArray(group) || group.length === 0) {
        fail(`condition.${groupIndex}`, "incomplete_condition_group")
        return
      }
      let alternatives: Condition[][] = [[]]
      group.forEach((condition, conditionIndex) => {
        const converted = convertCondition(condition)
        if (!converted || converted.length === 0) {
          fail(`condition.${groupIndex}.${conditionIndex}`, "unsupported_condition")
          return
        }
        alternatives = alternatives.flatMap((prefix) =>
          converted.map((suffix) => [...prefix, ...suffix]),
        )
        if (alternatives.length > 30 || alternatives.some((items) => items.length > 30)) {
          fail(`condition.${groupIndex}`, "condition_expansion_limit")
          alternatives = []
        }
      })
      anyOf.push(...alternatives.map((allOf) => ({ allOf })))
    })
  }
  const actions: AutomationRule["actions"] = []
  if (!record(input.result)) fail("result", "invalid_actions")
  else {
    for (const [key, value] of Object.entries(input.result)) {
      if (!["block", "silence", "disabled"].includes(key) || typeof value !== "boolean")
        fail(`result.${key}`, "unsupported_action")
      else if (value && (key === "block" || key === "silence"))
        actions.push({ type: "local_filter", mode: key })
    }
    if (actions.length === 0) fail("result", "missing_action")
  }
  if (issues.length > 0) return { success: false, issues }
  const when: ConditionSet =
    Array.isArray(input.condition) && input.condition.length === 0 ? { all: true } : { anyOf }
  const parsed = ruleSchema.safeParse({
    id: `local-${input.localId}`,
    ownerId: options.ownerId,
    order: options.order,
    name: input.name,
    enabled: record(input.result) && input.result.disabled !== true,
    when,
    actions,
    version: 1,
    executionLocation: "processing_service",
  })
  if (!parsed.success)
    return {
      success: false,
      issues: parsed.error.issues.map((item) => ({
        path: item.path.join("."),
        reason: "invalid_rule",
      })),
    }
  return { success: true, rule: parsed.data }
}
