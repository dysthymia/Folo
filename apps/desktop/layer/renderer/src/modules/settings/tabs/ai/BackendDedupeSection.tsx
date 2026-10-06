import { useWhoami } from "@follow/store/user/hooks"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { localAutomationChanged } from "~/modules/action/local-automation-events"
import { createProcessingClient } from "~/modules/action/processing-client"
import { processingButtonClass } from "~/modules/action/processing-condition-editor"
import { buildDedupeManagementUrl } from "~/modules/action/processing-rule-link"
import { getOneTimeToken } from "~/modules/ai-chat/local-provider"

import { backendDedupeCoverage, latestDedupeReport } from "./backend-dedupe"

const client = createProcessingClient(getOneTimeToken)
type Snapshot = {
  coverage: ReturnType<typeof backendDedupeCoverage>
  scheduleEnabled: boolean
  model: string
  ruleId?: string
  report: ReturnType<typeof latestDedupeReport>
}

/** 后台设置只显示有效配置，不让本地开关或旧模型冒充后台控制。 */
export function BackendDedupeSection() {
  const ownerId = useWhoami()?.id
  return <BackendDedupeStatus key={ownerId ?? "anonymous"} ownerId={ownerId} />
}
function BackendDedupeStatus({ ownerId }: { ownerId?: string }) {
  const { t, i18n } = useTranslation("app")
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(null)
    setError(false)
    if (ownerId)
      void Promise.all([
        client.loadEffective(controller.signal),
        client.loadAutomationStatus(controller.signal),
        client.loadModelSettings(controller.signal),
        client.loadRuns(controller.signal),
      ])
        .then(([effective, status, model, runs]) => {
          if (controller.signal.aborted) return
          if (effective.config && effective.config.ownerId !== ownerId)
            throw new Error("owner_mismatch")
          setSnapshot({
            coverage: backendDedupeCoverage(effective, status),
            scheduleEnabled: status.scheduleEnabled,
            model: `${model.provider} / ${model.model}`,
            ruleId: effective.config?.rules.find((rule) =>
              rule.actions.some((action) => action.type === "ai_dedupe"),
            )?.id,
            report: latestDedupeReport(runs),
          })
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true)
        })
    const refresh = () => setReload((value) => value + 1)
    window.addEventListener(localAutomationChanged, refresh)
    return () => {
      controller.abort()
      window.removeEventListener(localAutomationChanged, refresh)
    }
  }, [ownerId, reload])
  return (
    <div className="-mt-4 space-y-3 text-sm">
      <p className="text-text-secondary">{t("automation.dedupe.boundary")}</p>
      {error && (
        <p role="alert" className="text-red">
          {t("automation.feedback.load_error")}
        </p>
      )}
      {snapshot ? (
        <>
          <p>
            {t(
              snapshot.coverage.rules ? "automation.dedupe.active" : "automation.dedupe.inactive",
              snapshot.coverage,
            )}
          </p>
          <p className="text-text-secondary">
            {t("automation.dedupe.coverage", snapshot.coverage)}
          </p>
          <p className="text-text-secondary">
            {t(
              snapshot.scheduleEnabled
                ? "automation.dedupe.schedule_on"
                : "automation.feedback.schedule_off",
            )}
          </p>
          <p>
            {t("automation.model.current", {
              model: snapshot.model,
              interpolation: { escapeValue: false },
            })}
          </p>
          <p className="text-xs text-text-secondary">{t("automation.dedupe.shared_model")}</p>
          {snapshot.report ? (
            <div className="space-y-1 text-xs text-text-secondary">
              <p>
                {t("automation.dedupe.recent", {
                  ...snapshot.report,
                  exact: snapshot.report.exactDuplicates ?? t("processing.report.not_collected"),
                  time: new Date(snapshot.report.finishedAt).toLocaleString(i18n.language),
                  input: snapshot.report.usage.inputTokens,
                  output: snapshot.report.usage.outputTokens,
                  unknown:
                    snapshot.report.unknownUsageRequests ?? t("processing.report.not_collected"),
                  // React 文本已经转义，避免日期中的斜杠被重复显示成 HTML 实体。
                  interpolation: { escapeValue: false },
                })}
              </p>
              <p>
                {t("automation.dedupe.comparison_sources", {
                  unresolved: snapshot.report.unresolved ?? t("processing.report.not_collected"),
                  shared: snapshot.report.sharedComparisons ?? t("processing.report.not_collected"),
                  cached: snapshot.report.relationCacheHits ?? t("processing.report.not_collected"),
                  dedicated:
                    snapshot.report.dedicatedComparisons ?? t("processing.report.not_collected"),
                })}
              </p>
              {snapshot.report.sharedAnalysis && (
                <p>
                  {t("automation.dedupe.shared_usage", {
                    requests: snapshot.report.sharedAnalysis.requests,
                    input: snapshot.report.sharedAnalysis.usage.inputTokens,
                    output: snapshot.report.sharedAnalysis.usage.outputTokens,
                    unknown: snapshot.report.sharedAnalysis.unknownUsageRequests,
                  })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-text-secondary">{t("automation.dedupe.no_report")}</p>
          )}
        </>
      ) : (
        <p>{t(ownerId ? "automation.editor.loading" : "automation.dedupe.sign_in")}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {snapshot && (
          <a className={processingButtonClass} href={buildDedupeManagementUrl(snapshot.ruleId)}>
            {t("automation.dedupe.manage")}
          </a>
        )}
        <button
          type="button"
          className={processingButtonClass}
          onClick={() => setReload((value) => value + 1)}
        >
          {t("processing.report.refresh")}
        </button>
      </div>
      <p className="text-xs text-text-secondary">{t("automation.dedupe.draft_hint")}</p>
    </div>
  )
}
