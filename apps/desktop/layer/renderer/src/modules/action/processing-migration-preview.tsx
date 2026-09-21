import type { ActionMigrationPreview, MigratedActionRule } from "@follow/information-core"
import { previewActionMigration } from "@follow/information-core"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { selectJsonFile } from "~/lib/export"

import { processingButtonClass, processingInputClass } from "./processing-condition-editor"
import type { LocalMigrationSwitchTarget } from "./processing-migration-switch"

export type ProcessingMigrationImport = {
  entries: ReadonlyArray<{
    rule: MigratedActionRule
    localSwitchTarget?: LocalMigrationSwitchTarget
  }>
}

export function ProcessingMigrationPreview({
  onImport,
}: {
  onImport: (selection: ProcessingMigrationImport) => void
}) {
  const { t } = useTranslation("app")
  const [preview, setPreview] = useState<ActionMigrationPreview | null>(null)
  const [error, setError] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [imported, setImported] = useState(false)
  const [switchIndexes, setSwitchIndexes] = useState<Set<number>>(() => new Set())

  const chooseFile = async () => {
    try {
      const json = await selectJsonFile()
      setPreview(previewActionMigration(JSON.parse(json) as unknown))
      setError(false)
      setImportedCount(null)
      setImported(false)
      setSwitchIndexes(new Set())
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
    const entries = preview.rows.flatMap((row) =>
      row.rule
        ? [
            {
              rule: row.rule,
              ...(preview.sourceLocation === "local" && switchIndexes.has(row.index)
                ? {
                    localSwitchTarget: {
                      index: row.index,
                      name: row.name,
                      condition: row.legacyCondition,
                      result: row.legacyResult,
                    },
                  }
                : {}),
            },
          ]
        : [],
    )
    onImport({ entries })
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
            location: t(`processing.migration.location.${preview?.sourceLocation ?? "unknown"}`),
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
          {preview.sourceLocation === "cloud" && (
            <div className="space-y-2 rounded-lg bg-fill-quinary p-3 text-sm">
              <p>{t("processing.migration.cloud_readonly")}</p>
              <a className={processingButtonClass} href="/action?scope=cloud">
                {t("processing.migration.manage_cloud")}
              </a>
            </div>
          )}
          {preview.rows.map((row) => (
            <article key={row.index} className="space-y-3 rounded-lg bg-fill-quinary p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <strong>{row.name}</strong>
                <span className={row.status === "supported" ? "text-green" : "text-orange"}>
                  {t(`processing.migration.status.${row.status}`)}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-text-secondary">
                    {t("processing.migration.original_condition")}
                  </p>
                  <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                    {JSON.stringify(row.legacyCondition, null, 2)}
                  </pre>
                  <p className="text-xs font-medium text-text-secondary">
                    {t("processing.migration.original_action")}
                  </p>
                  <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                    {JSON.stringify(row.legacyResult, null, 2)}
                  </pre>
                </div>
                {row.rule && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-text-secondary">
                      {t("processing.migration.new_condition")}
                    </p>
                    <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                      {JSON.stringify(row.rule.when, null, 2)}
                    </pre>
                    <p className="text-xs font-medium text-text-secondary">
                      {t("processing.migration.new_action")}
                    </p>
                    <pre className={`${processingInputClass} overflow-x-auto whitespace-pre-wrap`}>
                      {JSON.stringify(row.rule.actions, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
              {row.rule && (
                <p className="text-xs text-text-secondary">
                  {t("processing.migration.no_external_side_effect")}
                </p>
              )}
              {row.issues.length > 0 && (
                <ul className="space-y-1 text-orange">
                  {row.issues.map((item) => (
                    <li key={`${item.code}:${item.path}`}>
                      {t(`processing.migration.issue.${item.code}`)} ({item.path})
                    </li>
                  ))}
                </ul>
              )}
              {preview.sourceLocation === "local" && row.rule && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={switchIndexes.has(row.index)}
                    disabled={imported}
                    onChange={(event) => {
                      const next = new Set(switchIndexes)
                      if (event.target.checked) next.add(row.index)
                      else next.delete(row.index)
                      setSwitchIndexes(next)
                    }}
                  />
                  <span>
                    {t("processing.migration.disable_local_after_publish")}
                    <span className="block text-xs text-text-secondary">
                      {t("processing.migration.copy_only_default")}
                    </span>
                  </span>
                </label>
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
