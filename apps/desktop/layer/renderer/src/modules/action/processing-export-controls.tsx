import type { RuleSet } from "@follow/information-core"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { processingButtonClass, processingInputClass } from "./processing-condition-editor"
import type { ProcessingExportScope } from "./processing-export"
import { processingExport } from "./processing-export"

export function ProcessingExportControls({ config }: { config: RuleSet }) {
  const { t } = useTranslation("app")
  const [scope, setScope] = useState<ProcessingExportScope>("public")
  const [status, setStatus] = useState<"copied" | "exported" | "failed" | null>(null)
  const text = JSON.stringify(processingExport(config, scope), null, 2)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus("copied")
    } catch {
      setStatus("failed")
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `folo-processing-${scope}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setStatus("exported")
  }
  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("processing.export_scope")}
          className={processingInputClass}
          value={scope}
          onChange={(event) => {
            setScope(event.target.value === "private" ? "private" : "public")
            setStatus(null)
          }}
        >
          <option value="public">{t("processing.export_public")}</option>
          <option value="private">{t("processing.export_private")}</option>
        </select>
        <button type="button" className={processingButtonClass} onClick={() => void copy()}>
          {t("words.copy", { ns: "common" })}
        </button>
        <button type="button" className={processingButtonClass} onClick={download}>
          {t("processing.transfer_export")}
        </button>
        {status && <span role="status">{t(`processing.transfer_${status}`)}</span>}
      </div>
      <p className="text-sm text-text-secondary">
        {t(scope === "public" ? "processing.export_public_hint" : "processing.export_private_hint")}
      </p>
      <details className="text-sm">
        <summary>{t("processing.export_preview")}</summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-fill p-3">
          {text}
        </pre>
      </details>
    </div>
  )
}
