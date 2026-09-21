import type { ConditionSet, RuleSet } from "@follow/information-core"

export type ProcessingExportScope = "public" | "private"

function publicConditions(conditions: ConditionSet): ConditionSet {
  if ("all" in conditions) return conditions
  return {
    anyOf: conditions.anyOf.map((group) => ({
      allOf: group.allOf.map((condition) => {
        switch (condition.field) {
          case "source_id":
          case "subscription_tag":
          case "list_id":
            return { ...condition, value: [`REPLACE_${condition.field.toUpperCase()}`] }
          case "category_ref":
            return { ...condition, value: { ...condition.value, name: "REPLACE_CATEGORY" } }
          case "category":
          case "title":
          case "feed_url":
          case "site_url":
            return { ...condition, value: `REPLACE_${condition.field.toUpperCase()}` }
          default:
            return condition
        }
      }),
    })),
  }
}

// 公开模板保留条件结构但移除私人身份；所有规则默认停用，避免占位条件变成宽泛匹配。
export function processingExport(config: RuleSet, scope: ProcessingExportScope): RuleSet {
  if (scope === "private") return structuredClone(config)
  return {
    ...config,
    ownerId: "shared-template",
    rules: config.rules.map((rule, index) => ({
      ...rule,
      id: `shared-rule-${index + 1}`,
      ownerId: "shared-template",
      name: `Rule ${index + 1}`,
      enabled: false,
      when: publicConditions(rule.when),
      actions: rule.actions.map((action) =>
        action.type === "ai_aggregate"
          ? { ...action, scope: publicConditions(action.scope) }
          : action,
      ),
    })),
  }
}
