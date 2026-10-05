import type { AutomationRule, ConditionSet } from "@follow/information-core"
import type { ParseKeys } from "i18next"

import type { ProcessingEditor } from "./processing-client"

export type LocalRulePublicationState = "draft" | "active" | "disabled" | "pending"

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

/** 发布状态只由实际生效配置证明；服务端版本号变化不代表用户有待发布修改。 */
export function localRulePublicationState(
  draft: AutomationRule,
  effective: AutomationRule | undefined,
): LocalRulePublicationState {
  if (!effective) return "draft"
  const { version: draftVersion, ...draftContent } = draft
  const { version: effectiveVersion, ...effectiveContent } = effective
  void draftVersion
  void effectiveVersion
  if (canonical(draftContent) !== canonical(effectiveContent)) return "pending"
  return effective.enabled ? "active" : "disabled"
}

/** 摘要保持条件的 AND/OR 关系和操作符，避免把复杂范围简化为全部订阅。 */
export function localRuleConditionSummary(
  when: ConditionSet,
  editor: Pick<ProcessingEditor, "sources" | "subscriptionTags">,
  translate: (key: ParseKeys<"app">) => string,
) {
  if ("all" in when) return translate("automation.pack.all_sources")
  const viewLabel = (view: number) => {
    const keys = [
      "processing.view.0",
      "processing.view.1",
      "processing.view.2",
      "processing.view.3",
      "processing.view.4",
      "processing.view.5",
    ] as const
    const key = keys[view]
    return key ? translate(key) : String(view)
  }
  return when.anyOf
    .map((group) =>
      group.allOf
        .map((condition) => {
          const labels = (ids: string[], field: "source_id" | "subscription_tag") =>
            ids
              .map((id) =>
                field === "source_id"
                  ? (editor.sources.find((source) => source.key === id)?.title ?? id)
                  : (editor.subscriptionTags.tags.find((tag) => tag.id === id)?.name ?? id),
              )
              .join(", ")
          const value =
            condition.field === "source_id" || condition.field === "subscription_tag"
              ? labels(condition.value, condition.field)
              : condition.field === "category_ref"
                ? `${viewLabel(condition.value.view)} / ${condition.value.name}`
                : condition.field === "view"
                  ? viewLabel(condition.value)
                  : Array.isArray(condition.value)
                    ? condition.value.join(", ")
                    : String(condition.value)
          return `${translate(`processing.field.${condition.field}`)} ${translate(`processing.operator.${condition.operator}`)} ${value}`
        })
        .join(` ${translate("automation.feedback.and")} `),
    )
    .join(` ${translate("automation.feedback.or")} `)
}
