import type { AutomationRule } from "@follow/information-core"
import { applyPreset } from "@follow/information-core"
import { useTranslation } from "react-i18next"

import { createSameEventAggregateAction } from "./processing-action-preset"
import type { ProcessingEditor } from "./processing-client"
import {
  processingButtonClass,
  ProcessingConditionEditor,
  processingInputClass,
} from "./processing-condition-editor"
import { SemanticTagPicker } from "./semantic-tag-picker"

type Action = AutomationRule["actions"][number]
type NewAction =
  | "block"
  | "silence"
  | "dim"
  | "filter"
  | "summary"
  | "translate"
  | "custom"
  | "dedupe"
  | "aggregate"
  | "presentation"
  | "display"
const policyOptions = {
  standalone: ["auto", "always", "never"],
  aggregation: ["allow", "deny"],
  rewrite: ["allow", "deny"],
} as const
type PolicyValue = "auto" | "always" | "never" | "allow" | "deny"

// 新增 AI 动作时预填有效且可编辑的指令，避免保存时才暴露空 Prompt 错误。
export const defaultLocalRulePrompts = {
  filter:
    "判断这篇内容是否符合我的关注主题。符合时设置 disposition=keep；不应保留时设置 disposition=hide 并说明理由；证据不足时设置 disposition=needs_context。",
  summary: "保留原条目，设置 disposition=keep；用简洁的中文概括关键信息，并保留重要事实。",
  custom: "保留原条目，设置 disposition=keep；请根据这篇内容进行分析，提取关键事实和有价值的结论。",
} as const

// 聚合需要允许材料参与综述；用户已经明确设定的拒绝和独立展示策略保持原样。
export function addLocalRuleAction(actions: Action[], kind: NewAction): Action[] {
  switch (kind) {
    // 虚化与普通动作共用保存和执行链，无需额外参数或 AI 指令。
    case "block":
    case "silence":
    case "dim":
      return [...actions, { type: "local_filter", mode: kind }]
    case "filter":
    case "summary":
    case "custom":
      return [...actions, { type: "ai_transform", prompt: defaultLocalRulePrompts[kind] }]
    case "translate": {
      // 复用翻译预设和现有执行链，预设标识随规则保存，重新打开仍能识别翻译动作。
      const translation = applyPreset("P13", { targetLanguage: "简体中文" })
      return [
        ...actions,
        {
          type: "ai_transform",
          preset: translation.presetRef,
          prompt: `${translation.prompt}\n将当前提供的标题和正文逐段翻译为简体中文，保留段落、列表与链接；不要用摘要代替翻译。已有中文无需重复翻译。\n翻译本身不改变其他筛选规则的决定；没有筛选要求时保留原条目。若正文不完整或输出长度不足以容纳全部译文，明确注明译文范围，不将部分翻译称为全文翻译。`,
        },
      ]
    }
    case "dedupe":
      return actions.some((action) => action.type === "ai_dedupe")
        ? actions
        : [...actions, { type: "ai_dedupe", scope: { all: true } }]
    case "aggregate": {
      if (actions.some((action) => action.type === "ai_aggregate")) return actions
      const presentationIndex = actions.findIndex((action) => action.type === "presentation")
      const next = [...actions, createSameEventAggregateAction()]
      if (presentationIndex < 0)
        return [...next, { type: "presentation", policy: { aggregation: "allow" } }]
      return next.map((action, index) =>
        index === presentationIndex && action.type === "presentation"
          ? {
              ...action,
              policy: { aggregation: "allow" as const, ...action.policy },
            }
          : action,
      )
    }
    case "presentation":
      return actions.some((action) => action.type === "presentation")
        ? actions
        : [...actions, { type: "presentation", policy: { standalone: "auto" } }]
    case "display":
      return actions.some((action) => action.type === "display")
        ? actions
        : [...actions, { type: "display", language: "zh-CN" }]
  }
}

// 仅移除选中的动作，保留同一规则中的其他设置和执行顺序。
export const removeLocalRuleAction = (actions: Action[], index: number): Action[] =>
  actions.filter((_, itemIndex) => itemIndex !== index)

export function LocalRuleActions({
  actions,
  onChange,
  sources,
  tags,
  listMemberships,
  sourceInventoryKnown = false,
}: {
  actions: AutomationRule["actions"]
  onChange: (actions: AutomationRule["actions"]) => void
  sources: ProcessingEditor["sources"]
  tags: ProcessingEditor["subscriptionTags"]["tags"]
  listMemberships: ProcessingEditor["listMemberships"]
  sourceInventoryKnown?: boolean
}) {
  const { t } = useTranslation("app")
  const update = (index: number, action: Action) =>
    onChange(actions.map((item, itemIndex) => (itemIndex === index ? action : item)))
  const policy = actions.find((action) => action.type === "presentation")

  return (
    <div className="space-y-3">
      {actions.map((action, index) => (
        <div key={index} className="space-y-2 rounded-lg bg-fill-quinary p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium">
              {action.type === "local_filter"
                ? t(`automation.action.${action.mode}`)
                : action.type === "ai_classify"
                  ? t("processing.type.ai_classify")
                  : action.type === "ai_transform" && action.preset?.id === "P13"
                    ? t("automation.action.translation")
                    : t(`automation.action.${action.type}`)}
            </h4>
            <button
              type="button"
              className={processingButtonClass}
              aria-label={`${t("automation.action.remove")} ${index + 1}`}
              onClick={() => onChange(removeLocalRuleAction(actions, index))}
            >
              {t("automation.action.remove")}
            </button>
          </div>
          {action.type === "local_filter" && action.mode === "dim" && (
            <p className="text-sm text-text-secondary">{t("automation.action.dim_hint")}</p>
          )}
          {/* 当前统一规则编辑器也使用同一多选入口，完整保留分类动作的其他字段。 */}
          {action.type === "ai_classify" && (
            <>
              <p className="text-sm text-text-secondary">{t("processing.classify_hint")}</p>
              <SemanticTagPicker
                value={action.tagIds}
                onChange={(tagIds) => update(index, { ...action, tagIds })}
              />
            </>
          )}
          {action.type === "ai_transform" && (
            <label className="block space-y-1 text-sm">
              {t("automation.action.requirement")}
              <textarea
                className={processingInputClass}
                rows={3}
                maxLength={30000}
                value={action.prompt}
                onChange={(event) => update(index, { ...action, prompt: event.target.value })}
              />
            </label>
          )}
          {action.type === "ai_dedupe" && (
            <p className="text-sm text-text-secondary">{t("automation.action.dedupe_hint")}</p>
          )}
          {action.type === "ai_aggregate" && (
            <>
              <p className="text-sm text-text-secondary">{t("automation.action.aggregate_hint")}</p>
              {policy?.type === "presentation" &&
                (policy.policy.aggregation === "deny" || policy.policy.standalone === "always") && (
                  <p className="text-sm text-orange">
                    {t("automation.action.aggregate_policy_conflict")}
                  </p>
                )}
              <label className="block space-y-1 text-sm">
                {t("automation.action.requirement")}
                <textarea
                  className={processingInputClass}
                  rows={3}
                  maxLength={30000}
                  value={action.createPrompt}
                  onChange={(event) =>
                    update(index, { ...action, createPrompt: event.target.value })
                  }
                />
              </label>
            </>
          )}
          {(action.type === "ai_aggregate" ||
            action.type === "ai_dedupe" ||
            action.type === "presentation" ||
            action.type === "display") && (
            <details className="space-y-2 text-sm">
              <summary className="cursor-pointer text-text-secondary">
                {t("automation.action.advanced")}
              </summary>
              {action.type === "ai_aggregate" && (
                <>
                  <label className="block space-y-1">
                    {t("automation.action.aggregate_mode")}
                    <select
                      className={processingInputClass}
                      value={action.mode}
                      onChange={(event) =>
                        update(index, {
                          ...action,
                          mode: event.target.value as "same_event" | "topic",
                        })
                      }
                    >
                      <option value="same_event">{t("automation.action.same_event")}</option>
                      <option value="topic">{t("automation.action.topic")}</option>
                    </select>
                  </label>
                  <label className="block space-y-1">
                    {t("automation.action.update_requirement")}
                    <textarea
                      className={processingInputClass}
                      rows={3}
                      value={action.updatePrompt}
                      onChange={(event) =>
                        update(index, { ...action, updatePrompt: event.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {(action.type === "ai_aggregate" || action.type === "ai_dedupe") && (
                <div className="space-y-1">
                  <p>{t("automation.action.scope")}</p>
                  <ProcessingConditionEditor
                    value={action.scope}
                    sources={sources}
                    tags={tags}
                    listMemberships={listMemberships}
                    sourceInventoryKnown={sourceInventoryKnown}
                    onChange={(scope) => update(index, { ...action, scope })}
                  />
                </div>
              )}
              {action.type === "presentation" &&
                (["standalone", "aggregation", "rewrite"] as const).map((field) => (
                  <label key={field} className="block space-y-1">
                    {t(`processing.policy.${field}`)}
                    <select
                      className={processingInputClass}
                      value={action.policy[field] ?? ""}
                      onChange={(event) => {
                        const nextPolicy = { ...action.policy }
                        delete nextPolicy[field]
                        if (event.target.value)
                          Object.assign(nextPolicy, { [field]: event.target.value })
                        update(index, { ...action, policy: nextPolicy })
                      }}
                    >
                      <option value="">{t("processing.inherit")}</option>
                      {(policyOptions[field] as readonly PolicyValue[]).map((value) => (
                        <option key={value} value={value}>
                          {t(`processing.policy_value.${value}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              {action.type === "display" && (
                <>
                  <label className="block space-y-1">
                    {t("processing.language")}
                    <input
                      className={processingInputClass}
                      value={action.language ?? ""}
                      onChange={(event) => {
                        const next = { ...action }
                        delete next.language
                        if (event.target.value) next.language = event.target.value
                        update(index, next)
                      }}
                    />
                  </label>
                  <label className="block space-y-1">
                    {t("processing.summary_length")}
                    <input
                      className={processingInputClass}
                      type="number"
                      min={1}
                      max={30000}
                      value={action.summaryMaxGraphemes ?? ""}
                      onChange={(event) => {
                        const next = { ...action }
                        delete next.summaryMaxGraphemes
                        if (event.target.value)
                          next.summaryMaxGraphemes = Number(event.target.value)
                        update(index, next)
                      }}
                    />
                  </label>
                </>
              )}
            </details>
          )}
        </div>
      ))}
      <label className="block space-y-1 text-sm">
        {t("automation.action.add")}
        <select
          aria-label={t("automation.action.add")}
          className={processingInputClass}
          value=""
          onChange={(event) => {
            if (event.target.value)
              onChange(addLocalRuleAction(actions, event.target.value as NewAction))
          }}
        >
          <option value="">{t("automation.action.choose")}</option>
          <option value="block">{t("automation.action.block")}</option>
          <option value="silence">{t("automation.action.silence")}</option>
          <option value="dim">{t("automation.action.dim")}</option>
          <option value="filter">{t("automation.action.filter")}</option>
          <option value="summary">{t("automation.action.summary")}</option>
          <option value="translate">{t("automation.action.translate")}</option>
          <option value="custom">{t("automation.action.custom")}</option>
          <option value="dedupe" disabled={actions.some((action) => action.type === "ai_dedupe")}>
            {t("automation.action.dedupe")}
          </option>
          <option
            value="aggregate"
            disabled={actions.some((action) => action.type === "ai_aggregate")}
          >
            {t("automation.action.aggregate")}
          </option>
          <option
            value="presentation"
            disabled={actions.some((action) => action.type === "presentation")}
          >
            {t("automation.action.presentation")}
          </option>
          <option value="display" disabled={actions.some((action) => action.type === "display")}>
            {t("automation.action.display")}
          </option>
        </select>
      </label>
    </div>
  )
}
