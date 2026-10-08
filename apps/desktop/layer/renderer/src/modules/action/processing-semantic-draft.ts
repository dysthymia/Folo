import type { AutomationRule, ConditionSet, RuleSet } from "@follow/information-core"

const hasSemanticCondition = (conditions: ConditionSet) =>
  "anyOf" in conditions &&
  conditions.anyOf.some((group) => group.allOf.some((condition) => condition.field === "entry_tag"))

// 新增语义字段时立即升级草稿，包括尚未选值的条件；旧规则维持原格式。
export function upgradeSemanticDraft(draft: RuleSet): RuleSet {
  const requiresVersion5 = draft.rules.some(
    (rule) =>
      hasSemanticCondition(rule.when) ||
      rule.actions.some(
        (action) =>
          action.type === "reading_decision" ||
          action.type === "ai_classify" ||
          ((action.type === "ai_aggregate" || action.type === "ai_dedupe") &&
            hasSemanticCondition(action.scope)),
      ),
  )
  return requiresVersion5 && draft.formatVersion !== 5 ? { ...draft, formatVersion: 5 } : draft
}

export function createSemanticNoiseDraft(draft: RuleSet, id: string, name: string): AutomationRule {
  return {
    id,
    ownerId: draft.ownerId,
    name,
    enabled: false,
    order: Math.max(-1, ...draft.rules.map((rule) => rule.order)) + 1,
    version: 1,
    executionLocation: "processing_service",
    when: {
      anyOf: [
        {
          allOf: [
            // 模板不推断来源授权，用户必须明确选择来源才能保存和启用。
            { field: "source_id", operator: "in", value: [] },
            {
              field: "entry_tag",
              operator: "contains_any",
              value: ["signal:social_chatter", "form:pure_entertainment", "signal:pure_promotion"],
              minConfidence: 0.8,
            },
          ],
        },
      ],
    },
    actions: [{ type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" }],
  }
}
