import type { RuleSet } from "@follow/information-core"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getOneTimeToken } from "../ai-chat/local-provider"
import type {
  ProcessingEditor,
  ProcessingReleaseDetail,
  ProcessingReleasePreview,
  ProcessingReleaseScope,
} from "./processing-client"
import { createProcessingClient } from "./processing-client"
import { processingButtonClass } from "./processing-condition-editor"

type ReleasePanelClient = Pick<
  ReturnType<typeof createProcessingClient>,
  "previewRelease" | "loadRelease"
>

export type ProcessingReleasePanelProps = {
  config: RuleSet
  releases: ProcessingEditor["releases"]
  scope: ProcessingReleaseScope
  onRestore?: (config: RuleSet) => void
  client?: ReleasePanelClient
}

const defaultClient = createProcessingClient(getOneTimeToken)

function comparedRules(current: RuleSet, historical: RuleSet) {
  const ids = new Set([
    ...current.rules.map((rule) => rule.id),
    ...historical.rules.map((rule) => rule.id),
  ])
  return [...ids].map((id) => {
    const currentRule = current.rules.find((rule) => rule.id === id)
    const historicalRule = historical.rules.find((rule) => rule.id === id)
    const status: "added" | "removed" | "changed" | "unchanged" = !historicalRule
      ? "added"
      : !currentRule
        ? "removed"
        : JSON.stringify(currentRule) === JSON.stringify(historicalRule)
          ? "unchanged"
          : "changed"
    return { id, currentRule, historicalRule, status }
  })
}

export function ProcessingReleasePanel({
  config,
  releases,
  scope,
  client = defaultClient,
  onRestore,
}: ProcessingReleasePanelProps) {
  const { t } = useTranslation("app")
  const [preview, setPreview] = useState<ProcessingReleasePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [detail, setDetail] = useState<ProcessingReleaseDetail | null>(null)
  const [detailVersion, setDetailVersion] = useState<number | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailFailed, setDetailFailed] = useState(false)
  const detailRequestRef = useRef<AbortController | null>(null)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  // 仅按范围内容重算，避免父组件用等价新对象渲染时重复请求。
  const scopeFingerprint = JSON.stringify(scope)

  useEffect(() => {
    const requestScope = scopeRef.current
    if (requestScope.mode === "selected" && requestScope.inputIds.length === 0) {
      setPreview(null)
      setPreviewing(false)
      setPreviewFailed(false)
      return
    }
    const controller = new AbortController()
    setPreviewing(true)
    setPreviewFailed(false)
    void client
      .previewRelease(requestScope, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreview(null)
          setPreviewFailed(true)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewing(false)
      })
    return () => controller.abort()
  }, [client, scopeFingerprint])

  useEffect(() => () => detailRequestRef.current?.abort(), [])

  const comparisons = useMemo(
    () => (detail ? comparedRules(config, detail.config) : []),
    [config, detail],
  )
  const sortedReleases = useMemo(
    () => [...releases].sort((left, right) => right.version - left.version),
    [releases],
  )

  const showRelease = async (version: number) => {
    detailRequestRef.current?.abort()
    const controller = new AbortController()
    detailRequestRef.current = controller
    setDetailVersion(version)
    setDetailBusy(true)
    setDetailFailed(false)
    try {
      const value = await client.loadRelease(version, controller.signal)
      if (!controller.signal.aborted) setDetail(value)
    } catch {
      if (!controller.signal.aborted) {
        setDetail(null)
        setDetailFailed(true)
      }
    } finally {
      if (!controller.signal.aborted) setDetailBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="space-y-2 rounded-lg border border-fill-secondary p-3">
        <h5 className="text-sm font-medium">{t("processing.release_preview.title")}</h5>
        {previewing && (
          <p className="text-sm text-text-secondary">{t("processing.release_preview.loading")}</p>
        )}
        {previewFailed && (
          <p role="alert" className="text-sm text-red">
            {t("processing.release_preview.error")}
          </p>
        )}
        {preview && !previewing && (
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              {t("processing.release_preview.target", { count: preview.targetInputIds.length })}
            </p>
            <p>
              {t("processing.release_preview.new_assignments", {
                count: preview.impact.newAssignments,
              })}
            </p>
            <p>
              {t("processing.release_preview.recalculated", {
                count: preview.impact.recalculated,
              })}
            </p>
            <p>
              {t("processing.release_preview.queued_unchanged", {
                count: preview.impact.queuedUnchanged,
              })}
            </p>
            <p>
              {t("processing.release_preview.historical_unchanged", {
                count: preview.impact.historicalUnchanged,
              })}
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-fill-secondary p-3">
        <div>
          <h5 className="text-sm font-medium">{t("processing.release_history.title")}</h5>
          <p className="text-sm text-text-secondary">{t("processing.release_history.readonly")}</p>
        </div>
        {sortedReleases.length === 0 ? (
          <p className="text-sm text-text-secondary">{t("processing.release_history.empty")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {sortedReleases.map((release) => (
              <button
                key={release.version}
                type="button"
                className={processingButtonClass}
                aria-pressed={detailVersion === release.version}
                onClick={() => void showRelease(release.version)}
              >
                v{release.version} · {release.createdAt} · {release.targetInputIds.length}
              </button>
            ))}
          </div>
        )}
        {detailBusy && (
          <p className="text-sm text-text-secondary">{t("processing.release_history.loading")}</p>
        )}
        {detailFailed && (
          <p role="alert" className="text-sm text-red">
            {t("processing.release_history.error")}
          </p>
        )}
        {detail && !detailBusy && (
          <div className="space-y-4 text-sm">
            {onRestore && (
              <button
                type="button"
                className={processingButtonClass}
                onClick={() => onRestore(structuredClone(detail.config))}
              >
                {t("processing.release_history.restore")}
              </button>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <h6 className="font-medium">
                  {t("processing.release_history.release_version")} v{detail.release.version}
                </h6>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-fill-quinary p-3">
                  {detail.config.global.markdown || t("processing.release_history.empty_prompt")}
                </pre>
              </div>
              <div className="space-y-1">
                <h6 className="font-medium">{t("processing.release_history.current_draft")}</h6>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-fill-quinary p-3">
                  {config.global.markdown || t("processing.release_history.empty_prompt")}
                </pre>
              </div>
            </div>
            <div className="space-y-2">
              <h6 className="font-medium">{t("processing.release_history.rules")}</h6>
              {comparisons.map((item) => (
                <details key={item.id} className="rounded-lg border border-fill-secondary p-2">
                  <summary className="cursor-pointer">
                    {item.historicalRule?.name ?? item.currentRule?.name ?? item.id} ·{" "}
                    {t(`processing.release_history.status.${item.status}`)}
                  </summary>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-fill-quinary p-3">
                      {item.historicalRule
                        ? JSON.stringify(item.historicalRule, null, 2)
                        : t("processing.release_history.not_present")}
                    </pre>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-fill-quinary p-3">
                      {item.currentRule
                        ? JSON.stringify(item.currentRule, null, 2)
                        : t("processing.release_history.not_present")}
                    </pre>
                  </div>
                </details>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
