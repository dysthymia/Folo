import type { AutomationRule } from "@follow/information-core"
import { useTranslation } from "react-i18next"

import { processingInputClass } from "./processing-condition-editor"

type AttentionAction = Extract<AutomationRule["actions"][number], { type: "attention" }>
// 两处既有规则编辑器共用关注控件，避免全局设置和本地规则拥有不同参数。
export function ProcessingAttentionAction({
  action,
  onChange,
}: {
  action: AttentionAction
  onChange: (action: AttentionAction) => void
}) {
  const { t } = useTranslation("app")
  return (
    <>
      <p className="text-sm text-text-secondary">{t("processing.attention.rule_hint")}</p>
      <label className="block text-sm">
        {t("processing.attention.level")}
        <select
          className={processingInputClass}
          value={action.level}
          onChange={(event) =>
            onChange({ ...action, level: event.target.value as AttentionAction["level"] })
          }
        >
          <option value="important">{t("processing.attention.important")}</option>
          <option value="urgent">{t("processing.attention.urgent")}</option>
        </select>
      </label>
      <label className="block text-sm">
        {t("processing.attention.reason")}
        <input
          className={processingInputClass}
          maxLength={2000}
          value={action.reason}
          onChange={(event) => onChange({ ...action, reason: event.target.value })}
        />
      </label>
    </>
  )
}
