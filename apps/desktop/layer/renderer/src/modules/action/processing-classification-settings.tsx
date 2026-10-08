import { useTranslation } from "react-i18next"

import type { ProcessingScheduleConfig } from "./processing-client"
import { processingInputClass } from "./processing-condition-editor"

// 原生公共设置与高级计划共用模式控件；切换模式保留首次启用水位。
export function ProcessingClassificationSettings({
  value,
  onChange,
}: {
  value: ProcessingScheduleConfig["classification"]
  onChange: (value: NonNullable<ProcessingScheduleConfig["classification"]>) => void
}) {
  const { t } = useTranslation("app")
  return (
    <div className="space-y-2">
      <label className="block space-y-2 text-sm">
        <span>{t("processing.run.classification_mode")}</span>
        <select
          className={processingInputClass}
          value={value?.mode ?? "new_content"}
          onChange={(event) =>
            onChange({
              mode: event.target.value === "list_loaded" ? "list_loaded" : "new_content",
              enabledAt: value?.enabledAt ?? new Date().toISOString(),
            })
          }
        >
          <option value="new_content">{t("processing.run.classification_new_content")}</option>
          <option value="list_loaded">{t("processing.run.classification_list_loaded")}</option>
        </select>
      </label>
      <p className="text-xs text-text-secondary">{t("processing.run.classification_hint")}</p>
    </div>
  )
}
