import type { AutomationRule, PresetApplication } from "@follow/information-core"
import { useTranslation } from "react-i18next"

import type { ProcessingEditor } from "./processing-client"
import {
  processingButtonClass,
  ProcessingConditionEditor,
  processingInputClass,
} from "./processing-condition-editor"
import { ProcessingPresetPicker } from "./processing-preset-picker"

type Action = AutomationRule["actions"][number]

const mergePresentation = (actions: Action[], policy: { standalone: "always" }) => {
  const index = actions.findIndex((item) => item.type === "presentation")
  if (index < 0) return [...actions, { type: "presentation" as const, policy }]
  return actions.map((item, itemIndex) =>
    itemIndex === index && item.type === "presentation"
      ? { ...item, policy: { ...item.policy, ...policy } }
      : item,
  )
}

const mergeDisplay = (actions: Action[], summaryMaxGraphemes: number) => {
  const index = actions.findIndex((item) => item.type === "display")
  if (index < 0) return [...actions, { type: "display" as const, summaryMaxGraphemes }]
  return actions.map((item, itemIndex) =>
    itemIndex === index && item.type === "display" ? { ...item, summaryMaxGraphemes } : item,
  )
}

const applyPresetToAction = (
  actions: Action[],
  index: number,
  application: PresetApplication,
): Action[] => {
  const current = actions[index]
  const patch = application.patch
  if (!current) return actions

  if (
    current.type === "ai_transform" &&
    application.target === "ai_transform" &&
    "type" in patch &&
    patch.type === "ai_transform"
  ) {
    // 预设只在用户点击应用后复制到当前动作，目录内容变化不会自动覆盖草稿。
    let nextActions = actions.map((item, itemIndex) =>
      itemIndex === index ? { ...current, prompt: patch.prompt, preset: patch.preset } : item,
    )
    if (application.presentation)
      nextActions = mergePresentation(nextActions, application.presentation.policy)
    if (application.display)
      nextActions = mergeDisplay(nextActions, application.display.summaryMaxGraphemes)
    return nextActions
  }

  if (
    current.type === "ai_aggregate" &&
    application.target === "ai_aggregate.createPrompt" &&
    "createPrompt" in patch &&
    "mode" in patch === false
  )
    return actions.map((item, itemIndex) =>
      itemIndex === index && item.type === "ai_aggregate"
        ? {
            ...item,
            createPrompt: patch.createPrompt,
            presets: { ...item.presets, create: patch.presets.create },
          }
        : item,
    )

  if (
    current.type === "ai_aggregate" &&
    application.target === "ai_aggregate.updatePrompt" &&
    "updatePrompt" in patch
  )
    return actions.map((item, itemIndex) =>
      itemIndex === index && item.type === "ai_aggregate"
        ? {
            ...item,
            updatePrompt: patch.updatePrompt,
            presets: { ...item.presets, update: patch.presets.update },
          }
        : item,
    )

  return actions
}

export function ProcessingActionEditor({
  actions,
  onChange,
  sources,
  tags,
}: {
  actions: Action[]
  onChange: (actions: Action[]) => void
  sources: ProcessingEditor["sources"]
  tags: ProcessingEditor["subscriptionTags"]["tags"]
}) {
  const { t } = useTranslation("app")
  const update = (index: number, action: Action) =>
    onChange(actions.map((item, i) => (i === index ? action : item)))
  return (
    <div className="space-y-3">
      {actions.map((action, index) => (
        <div key={index} className="space-y-3 rounded-lg bg-fill-quinary p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">{t(`processing.type.${action.type}`)}</h4>
            <button
              type="button"
              className={processingButtonClass}
              onClick={() => onChange(actions.filter((_, i) => i !== index))}
            >
              {t("processing.remove")}
            </button>
          </div>
          {action.type === "ai_transform" && (
            <>
              <ProcessingPresetPicker
                targets={["ai_transform"]}
                initialTarget="ai_transform"
                currentPrompt={action.prompt}
                onApply={(application) =>
                  onChange(applyPresetToAction(actions, index, application))
                }
              />
              <textarea
                aria-label={t("processing.prompt")}
                className={processingInputClass}
                rows={4}
                maxLength={30000}
                value={action.prompt}
                onChange={(e) => update(index, { ...action, prompt: e.target.value })}
              />
            </>
          )}
          {action.type === "presentation" && (
            <div className="grid gap-3 sm:grid-cols-3">
              {(["standalone", "aggregation", "rewrite"] as const).map((field) => (
                <label key={field} className="space-y-1 text-sm">
                  {t(`processing.policy.${field}`)}
                  <select
                    className={processingInputClass}
                    value={action.policy[field] ?? ""}
                    onChange={(e) => {
                      // 清除显式值时真正删除字段，保留“继承”和显式 auto 的区别。
                      const policy = { ...action.policy }
                      delete policy[field]
                      if (e.target.value) Object.assign(policy, { [field]: e.target.value })
                      update(index, { ...action, policy })
                    }}
                  >
                    <option value="">{t("processing.inherit")}</option>
                    {(field === "standalone"
                      ? (["auto", "always", "never"] as const)
                      : (["allow", "deny"] as const)
                    ).map((option: "auto" | "always" | "never" | "allow" | "deny") => (
                      <option key={option} value={option}>
                        {t(`processing.policy_value.${option}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          {action.type === "display" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                {t("processing.language")}
                <input
                  className={processingInputClass}
                  value={action.language ?? ""}
                  placeholder="zh-CN"
                  onChange={(e) => {
                    const next = { ...action }
                    delete next.language
                    if (e.target.value) next.language = e.target.value
                    update(index, next)
                  }}
                />
              </label>
              <label className="space-y-1 text-sm">
                {t("processing.summary_length")}
                <input
                  className={processingInputClass}
                  type="number"
                  min={1}
                  max={30000}
                  value={action.summaryMaxGraphemes ?? ""}
                  onChange={(e) => {
                    const next = { ...action }
                    delete next.summaryMaxGraphemes
                    if (e.target.value) next.summaryMaxGraphemes = Number(e.target.value)
                    update(index, next)
                  }}
                />
              </label>
            </div>
          )}
          {action.type === "ai_aggregate" && (
            <>
              <ProcessingPresetPicker
                targets={["ai_aggregate.createPrompt"]}
                initialTarget="ai_aggregate.createPrompt"
                currentPrompt={action.createPrompt}
                onApply={(application) =>
                  onChange(applyPresetToAction(actions, index, application))
                }
              />
              <label className="block space-y-1 text-sm">
                {t("processing.aggregate_mode")}
                <select
                  className={processingInputClass}
                  value={action.mode}
                  onChange={(e) =>
                    update(index, { ...action, mode: e.target.value as "same_event" | "topic" })
                  }
                >
                  <option value="same_event">{t("processing.same_event")}</option>
                  <option value="topic">{t("processing.topic")}</option>
                </select>
              </label>
              <p className="text-sm font-medium">{t("processing.aggregate_scope")}</p>
              <ProcessingConditionEditor
                value={action.scope}
                sources={sources}
                tags={tags}
                onChange={(scope) => update(index, { ...action, scope })}
              />
              <label className="block space-y-1 text-sm">
                {t("processing.create_prompt")}
                <textarea
                  className={processingInputClass}
                  rows={4}
                  value={action.createPrompt}
                  onChange={(e) => update(index, { ...action, createPrompt: e.target.value })}
                />
              </label>
              <label className="block space-y-1 text-sm">
                {t("processing.update_prompt")}
                <textarea
                  className={processingInputClass}
                  rows={4}
                  value={action.updatePrompt}
                  onChange={(e) => update(index, { ...action, updatePrompt: e.target.value })}
                />
              </label>
              <ProcessingPresetPicker
                targets={["ai_aggregate.updatePrompt"]}
                initialTarget="ai_aggregate.updatePrompt"
                currentPrompt={action.updatePrompt}
                onApply={(application) =>
                  onChange(applyPresetToAction(actions, index, application))
                }
              />
            </>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={processingButtonClass}
          onClick={() => onChange([...actions, { type: "ai_transform", prompt: "" }])}
        >
          {t("processing.add_transform")}
        </button>
        <button
          type="button"
          className={processingButtonClass}
          disabled={actions.some((action) => action.type === "presentation")}
          onClick={() =>
            onChange([...actions, { type: "presentation", policy: { standalone: "auto" } }])
          }
        >
          {t("processing.add_policy")}
        </button>
        <button
          type="button"
          className={processingButtonClass}
          disabled={actions.some((action) => action.type === "display")}
          onClick={() => onChange([...actions, { type: "display", language: "zh-CN" }])}
        >
          {t("processing.add_display")}
        </button>
        <button
          type="button"
          className={processingButtonClass}
          disabled={actions.some((action) => action.type === "ai_aggregate")}
          onClick={() =>
            onChange([
              ...actions,
              {
                type: "ai_aggregate",
                mode: "same_event",
                scope: { all: true },
                createPrompt: "",
                updatePrompt: "",
              },
            ])
          }
        >
          {t("processing.add_aggregate")}
        </button>
      </div>
    </div>
  )
}
