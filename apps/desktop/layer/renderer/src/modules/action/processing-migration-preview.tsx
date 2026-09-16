import type { ActionMigrationPreview, MigratedActionRule } from "@follow/information-core"
import { previewActionMigration } from "@follow/information-core"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { selectJsonFile } from "~/lib/export"

import { processingButtonClass, processingInputClass } from "./processing-condition-editor"

export function ProcessingMigrationPreview({
  onImport,
  sourceLocation = "unknown",
}: {
  onImport: (rules: readonly MigratedActionRule[]) => void
  sourceLocation?: "cloud" | "local" | "unknown"
}) {
  const { t } = useTranslation("app")
  const [preview, setPreview] = useState<ActionMigrationPreview | null>(null)
  const [error, setError] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [imported, setImported] = useState(false)

  const chooseFile = async () => {
    try {
      const json = await selectJsonFile()
      setPreview(previewActionMigration(JSON.parse(json) as unknown))
      setError(false)
      setImportedCount(null)
      setImported(false)
    } catch (cause) {
      // 用户取消文件选择不属于错误；其它解析失败要明确显示，不能把空规则当作成功。
      if (cause instanceof Error && cause.message === "No file selected") return
      setPreview(null)
      setImportedCount(null)
      setError(true)
    }
  }

  const importSupported = () => {
    if (!preview || !preview.valid || preview.supported.length === 0) return
    onImport(preview.supported)
    setImportedCount(preview.supported.length)
    setImported(true)
  }

  return (
    <section className="space-y-3 rounded-xl border border-fill-secondary p-4">
      <div>
        <h3 className="font-medium">{t("processing.migration.title")}</h3>
        <p className="mt-1 text-sm text-text-secondary">{t("processing.migration.description")}</p>
        <p className="mt-1 text-xs text-text-tertiary">
          {t("processing.migration.source_location", {
            location: t(`processing.migration.location.${sourceLocation}`),
          })}
        </p>
      </div>
      <button type="button" className={processingButtonClass} onClick={() => void chooseFile()}>
        {t("processing.migration.choose_file")}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red">
          {t("processing.migration.invalid_file")}
        </p>
      )}
      {preview && (
        <div className="space-y-3" aria-live="polite">
          {preview.fatalIssues.length > 0 && (
            <p role="alert" className="text-sm text-red">
              {t("processing.migration.invalid_export")}
            </p>
          )}
          {preview.rows.map((row) => (
            <article key={row.index} className="space-y-2 rounded-lg bg-fill-quinary p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <strong>{row.name}</strong>
                <span className={row.status === "supported" ? "text-green" : "text-orange"}>
                  {t(`processing.migration.status.${row.status}`)}
                </span>
              </div>
              {row.rule ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                    {JSON.stringify(row.rule.when, null, 2)}
                  </pre>
                  <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                    {JSON.stringify(row.rule.actions, null, 2)}
                  </pre>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-text-secondary">
                    {t("processing.migration.original_condition")}
                  </p>
                  <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                    {JSON.stringify(row.legacyCondition, null, 2)}
                  </pre>
                  <p className="text-xs text-text-secondary">
                    {t("processing.migration.original_action")}
                  </p>
                  <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                    {JSON.stringify(row.legacyResult, null, 2)}
                  </pre>
                  <ul className="space-y-1 text-orange">
                    {row.issues.map((item) => (
                      <li key={`${item.code}:${item.path}`}>
                        {t(`processing.migration.issue.${item.code}`)} ({item.path})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
          {preview.supported.length > 0 && (
            <button
              type="button"
              className={`${processingButtonClass} bg-accent text-white`}
              disabled={imported}
              onClick={importSupported}
            >
              {t("processing.migration.import", { count: preview.supported.length })}
            </button>
          )}
          {importedCount !== null && (
            <p role="status" className="text-sm text-green">
              {t("processing.migration.imported", { count: importedCount })}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
