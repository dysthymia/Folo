import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useSettingModal } from "~/modules/settings/modal/use-setting-modal-hack"

import { getOneTimeToken } from "../ai-chat/local-provider"
import { localAutomationChanged } from "./local-automation-events"
import type {
  AutomationStatus,
  ProcessingEditor,
  ProcessingModelSettings,
} from "./processing-client"
import { createProcessingClient } from "./processing-client"
import { processingButtonClass } from "./processing-condition-editor"

const client = createProcessingClient(getOneTimeToken)
// JSX 文本由 React 负责转义，插值不再预先转成 HTML 实体，避免斜杠等字符显示为实体字面量。
const reactTextInterpolation = { escapeValue: false }

/** 以已发布范围和实际处理记录展示覆盖；查询不会触发模型或重处理。 */
export function LocalAutomationFeedback({
  ownerId,
  editor,
  ruleId,
}: {
  ownerId: string
  editor: ProcessingEditor
  ruleId?: string
}) {
  const { t, i18n } = useTranslation("app")
  const showSettings = useSettingModal()
  const [status, setStatus] = useState<AutomationStatus | null>(null)
  const [model, setModel] = useState<ProcessingModelSettings | null>(null)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)
  const requestRef = useRef<AbortController | null>(null)
  useEffect(() => {
    let disposed = false
    const refresh = () => {
      if (document.visibilityState === "hidden") return
      requestRef.current?.abort()
      const controller = new AbortController()
      requestRef.current = controller
      void Promise.allSettled([
        client.loadAutomationStatus(controller.signal),
        client.loadModelSettings(controller.signal),
      ]).then(([feedback, settings]) => {
        if (disposed || controller.signal.aborted) return
        setError(feedback.status === "rejected" || settings.status === "rejected")
        setStatus(feedback.status === "fulfilled" ? feedback.value : null)
        setModel(settings.status === "fulfilled" ? settings.value : null)
      })
    }
    setStatus(null)
    setModel(null)
    setError(false)
    refresh()
    const visible = () => {
      if (document.visibilityState === "hidden") requestRef.current?.abort()
      else refresh()
    }
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener(localAutomationChanged, refresh)
    document.addEventListener("visibilitychange", visible)
    return () => {
      disposed = true
      requestRef.current?.abort()
      window.clearInterval(timer)
      window.removeEventListener(localAutomationChanged, refresh)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [ownerId, reload])
  const feedback = status?.rules.find((rule) => rule.ruleId === ruleId)
  const date = (value: string) => new Date(value).toLocaleString(i18n.language)
  // 计划返回当地钟表时间时保留其时区，不能按浏览器时区猜成另一个瞬间。
  const nextRun = status?.nextRunAt
    ? /(?:Z|[+-]\d\d:\d\d)$/u.test(status.nextRunAt)
      ? date(status.nextRunAt)
      : `${status.nextRunAt.replace("T", " ")} (${status.timeZone ?? t("processing.report.not_collected")})`
    : null
  return (
    <section
      className="space-y-3 rounded-xl border border-fill-secondary p-4"
      aria-label={t("automation.feedback.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{t("automation.feedback.title")}</h3>
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span>
            {t("automation.model.current", {
              interpolation: reactTextInterpolation,
              model: model
                ? `${model.provider} / ${model.model}`
                : t("processing.report.not_collected"),
            })}
          </span>
          <button
            type="button"
            className={processingButtonClass}
            onClick={() => showSettings("ai")}
          >
            {t("automation.model.change")}
          </button>
          <button
            type="button"
            className={processingButtonClass}
            onClick={() => setReload((value) => value + 1)}
          >
            {t("processing.report.refresh")}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red">
          {t("automation.feedback.load_error")}
        </p>
      )}
      {status && (
        <>
          <p className="text-sm">{t("automation.feedback.coverage", status.sourceInventory)}</p>
          <p className="text-xs text-text-secondary">
            {t("automation.feedback.counts", status.counts)}
          </p>
          <p className="text-xs text-text-secondary">
            {status.scheduleEnabled
              ? nextRun
                ? t("automation.feedback.next_run", {
                    time: nextRun,
                    interpolation: reactTextInterpolation,
                  })
                : t("automation.feedback.next_unknown")
              : t("automation.feedback.schedule_off")}
          </p>
          {ruleId && (
            <p className="text-xs text-text-secondary">
              {feedback
                ? t("automation.feedback.rule_coverage", {
                    interpolation: reactTextInterpolation,
                    count: feedback.sourceKeys.length,
                    unknown: feedback.unknownSourceKeys.length,
                    processed: feedback.processed,
                    time: feedback.lastProcessedAt
                      ? date(feedback.lastProcessedAt)
                      : t("processing.report.not_collected"),
                  })
                : t("automation.feedback.rule_unpublished")}
            </p>
          )}
          {!!feedback?.sourceKeys.length && (
            <details className="text-xs text-text-secondary">
              <summary className="cursor-pointer">{t("automation.feedback.show_sources")}</summary>
              <p className="mt-2 break-words">
                {feedback.sourceKeys
                  .map((key) => editor.sources.find((source) => source.key === key)?.title ?? key)
                  .join("、")}
              </p>
            </details>
          )}
        </>
      )}
    </section>
  )
}
