import { useTranslation } from "react-i18next"

import { useProcessingEntryOverride } from "~/modules/entry-column/processing-entry-override"

import { ProcessingEntryExplanation } from "./ProcessingEntryExplanation"

/** 智能列表沿用原条目纠错接口，人工调整立即通知冻结阅读投影。 */
export function GeneratedEntryControls({ inputSeq }: { inputSeq: number }) {
  const { t } = useTranslation("app")
  const { setMode, busy, failed } = useProcessingEntryOverride()
  return (
    <div className="border-b border-fill px-5 py-2 text-xs">
      <div className="flex flex-wrap gap-3">
        {(["restore", "hide", "automatic"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={busy}
            onClick={() => void setMode(inputSeq, mode)}
          >
            {t(`processing.reader.override.${mode}`)}
          </button>
        ))}
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-red">
          {t("processing.badge.override_failed")}
        </p>
      )}
      <ProcessingEntryExplanation key={inputSeq} inputSeq={inputSeq} />
    </div>
  )
}
