import type { Condition, ConditionSet, RuleSet } from "@follow/information-core"
import { conditionSetSchema, ruleUsesAI } from "@follow/information-core"

import { AutomationError } from "./automation-store"
import type { Store } from "./store"

export type RuleUpgradePreview = {
  required: boolean
  expectedRevision: number
  expectedScheduleRevision: number
  affectedRules: Array<{ id: string; name: string }>
  sourceCount: number
  supported: boolean
  reason?: "unsupported_legacy_sources" | "draft_conflict" | "condition_limit"
}

function sameRule(left: RuleSet["rules"][number] | undefined, right: RuleSet["rules"][number]) {
  return (
    left !== undefined &&
    JSON.stringify({ ...left, version: 0 }) === JSON.stringify({ ...right, version: 0 })
  )
}

function inheritedCondition(store: Store): Condition | null {
  const scope = store.schedule.snapshot().config?.scope
  if (scope?.mode === "fixed")
    return { field: "source_id", operator: "in", value: [...scope.sourceKeys] }
  if (scope?.mode === "category")
    return {
      field: "category_ref",
      operator: "eq",
      value: { view: scope.view, name: scope.category },
    }
  return null
}

function constrain(when: ConditionSet, inherited: Condition | null): ConditionSet {
  if (!inherited) return when
  // 旧范围与每个 OR 分支取交集，不改变原来的条件组合语义。
  return {
    anyOf:
      "all" in when
        ? [{ allOf: [inherited] }]
        : when.anyOf.map((group) => ({ allOf: [...group.allOf, inherited] })),
  }
}

export function legacyRuleUpgradePreview(store: Store): RuleUpgradePreview {
  const draft = store.automation.draft()
  const active = store.automation.effective().config
  const schedule = store.schedule.snapshot()
  const rules = active?.rules.filter(ruleUsesAI) ?? []
  const required = !!schedule.config && schedule.config.scope.mode !== "rules" && rules.length > 0
  const preview: RuleUpgradePreview = {
    required,
    expectedRevision: draft.revision,
    expectedScheduleRevision: schedule.revision,
    affectedRules: required ? rules.map(({ id, name }) => ({ id, name })) : [],
    sourceCount: schedule.config?.sourceKeys.length ?? 0,
    supported: true,
  }
  if (!required) return preview
  const scope = schedule.config!.scope
  // List 是运行容器，不能当作 feed 身份转换，否则会漏掉材料或扩大旧范围。
  if (scope.mode === "fixed" && scope.sourceKeys.some((key) => !/^feed\/[^/\s]+$/u.test(key)))
    return { ...preview, supported: false, reason: "unsupported_legacy_sources" }
  // 有未发布旧规则时不猜测合并意图，让用户先解决草稿冲突再升级。
  if (
    rules.some(
      (rule) =>
        !sameRule(
          draft.config.rules.find((item) => item.id === rule.id),
          rule,
        ),
    )
  )
    return { ...preview, supported: false, reason: "draft_conflict" }
  const inherited = inheritedCondition(store)
  if (rules.some((rule) => !conditionSetSchema.safeParse(constrain(rule.when, inherited)).success))
    return { ...preview, supported: false, reason: "condition_limit" }
  return preview
}

export function prepareLegacyRuleUpgrade(store: Store, expectedScheduleRevision: number) {
  const preview = legacyRuleUpgradePreview(store)
  if (preview.expectedScheduleRevision !== expectedScheduleRevision)
    throw new AutomationError("revision_conflict")
  if (!preview.required) throw new AutomationError("invalid_target")
  if (!preview.supported) throw new AutomationError("legacy_scope_upgrade_blocked")
  const active = store.automation.effective().config!
  const draft = store.automation.draft().config
  const inherited = inheritedCondition(store)
  const updated = new Map(
    active.rules
      .filter(ruleUsesAI)
      .map((rule) => [rule.id, { ...rule, when: constrain(rule.when, inherited) }]),
  )
  return {
    config: { ...draft, rules: draft.rules.map((rule) => updated.get(rule.id) ?? rule) },
    effectiveConfig: { ...active, rules: active.rules.map((rule) => updated.get(rule.id) ?? rule) },
  }
}
