import type { AutomationRule, ConditionSet, RuleSet } from "@follow/information-core"

// 单条编辑只替换选中规则；其它草稿不能进入试运行或生效配置。
export function replaceLocalRule(config: RuleSet, rule: AutomationRule): RuleSet {
  const exists = config.rules.some((item) => item.id === rule.id)
  return {
    ...config,
    rules: exists
      ? config.rules.map((item) => (item.id === rule.id ? rule : item))
      : [...config.rules, rule],
  }
}

export function newLocalRule(
  config: RuleSet,
  name: string,
  when: ConditionSet = { all: true },
): AutomationRule {
  return {
    id: crypto.randomUUID(),
    ownerId: config.ownerId,
    name,
    enabled: true,
    order: Math.max(-1, ...config.rules.map((rule) => rule.order)) + 1,
    version: 1,
    executionLocation: "processing_service",
    when,
    actions: [],
  }
}

export const localRuleUsesAI = (rule: AutomationRule) =>
  rule.actions.some((action) => ["ai_transform", "ai_aggregate", "ai_dedupe"].includes(action.type))
