import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getOneTimeToken } from "../ai-chat/local-provider"
import { createProcessingClient } from "./processing-client"
import { processingButtonClass } from "./processing-condition-editor"
import { ProcessingRunReport } from "./processing-run-report"

const client = createProcessingClient(getOneTimeToken)
type RunData = Awaited<ReturnType<typeof client.loadRuns>>
type QueueState = { ownerId: string; data: RunData | null; loading: boolean; error: boolean }

// 原自动化页面内展示最近批次与进度，报告查询不会发起模型调用。
export function LocalAutomationQueue({ ownerId }: { ownerId: string | null | undefined }) {
  const { t, i18n } = useTranslation("app")
  const [state, setState] = useState<QueueState | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const activeOwnerRef = useRef(ownerId)
  activeOwnerRef.current = ownerId
  const refresh = useCallback(async () => {
    if (!ownerId || document.visibilityState === "hidden") return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setState((previous) => ({
      ownerId,
      data: previous?.ownerId === ownerId ? previous.data : null,
      loading: true,
      error: false,
    }))
    try {
      const data = await client.loadRuns(controller.signal)
      // 切账号或切后台后的晚到响应不能重新展示旧账号报告。
      if (controller.signal.aborted || activeOwnerRef.current !== ownerId) return
      setState({ ownerId, data, loading: false, error: false })
    } catch {
      if (controller.signal.aborted || activeOwnerRef.current !== ownerId) return
      setState((previous) => ({
        ownerId,
        data: previous?.ownerId === ownerId ? previous.data : null,
        loading: false,
        error: true,
      }))
    }
  }, [ownerId])
  useEffect(() => {
    void refresh()
    const visible = () => {
      if (document.visibilityState === "hidden") requestRef.current?.abort()
      else void refresh()
    }
    // 仅页面可见时每分钟更新；手动刷新用于检查刚刚发布的批次。
    const timer = window.setInterval(() => void refresh(), 60_000)
    document.addEventListener("visibilitychange", visible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", visible)
      requestRef.current?.abort()
    }
  }, [refresh])
  if (!ownerId) return null
  const current = state?.ownerId === ownerId ? state : null
  const runs = [...(current?.data?.runs ?? [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 5)
  const reports = new Map(current?.data?.reports.map((item) => [item.triggerId, item.report]) ?? [])
  return (
    <section
      className="space-y-3 rounded-xl border border-fill-secondary p-4"
      aria-label={t("processing.report.queue_title")}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text">{t("processing.report.queue_title")}</h3>
        <button
          type="button"
          className={processingButtonClass}
          disabled={current?.loading}
          onClick={() => void refresh()}
        >
          {t("processing.report.refresh")}
        </button>
      </div>
      {current?.error && (
        <p role="alert" className="text-sm text-red">
          {t("processing.report.load_error")}
        </p>
      )}
      {!current?.data && (
        <p className="text-sm text-text-secondary">
          {t(current?.loading ? "processing.report.loading" : "processing.report.no_runs")}
        </p>
      )}
      {current?.data && runs.length === 0 && (
        <p className="text-sm text-text-secondary">{t("processing.report.no_runs")}</p>
      )}
      {runs.map((run, index) => (
        <details
          key={run.id}
          open={index === 0}
          className="rounded-lg border border-fill-secondary p-3"
        >
          <summary className="cursor-pointer text-sm text-text">
            <span>{t(`processing.report.status.${run.status}`)}</span>
            <span className="ml-2 text-text-secondary">
              {new Date(run.createdAt).toLocaleString(i18n.language)}
            </span>
          </summary>
          <div className="mt-4">
            <ProcessingRunReport run={run} report={reports.get(run.id)} />
            {run.error && <p className="mt-3 break-words text-xs text-red">{run.error}</p>}
          </div>
        </details>
      ))}
    </section>
  )
}
