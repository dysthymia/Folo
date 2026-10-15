import { cn } from "@follow/utils/utils"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { localAutomationChanged } from "~/modules/action/local-automation-events"
import type { AutomationDebug, ProcessingModelSettings } from "~/modules/action/processing-client"
import { createProcessingClient } from "~/modules/action/processing-client"
import { parseProcessingRunReport } from "~/modules/action/processing-run-report"
import { getOneTimeToken } from "~/modules/ai-chat/local-provider"

const client = createProcessingClient(getOneTimeToken)

/** 正文栏只观察后台已发布状态；账号切换由外层 key 清空，查询不能启动任何处理。 */
export function AutomationDebugPanel({ ownerId }: { ownerId?: string }) {
  const { t, i18n } = useTranslation("app")
  const [snapshot, setSnapshot] = useState<AutomationDebug | null>(null)
  const [model, setModel] = useState<ProcessingModelSettings | null>(null)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!ownerId) return
    let disposed = false
    let controller: AbortController | null = null
    let timer: number | undefined
    const refresh = () => {
      window.clearTimeout(timer)
      controller?.abort()
      if (document.visibilityState === "hidden") return
      const request = new AbortController()
      controller = request
      // 两个只读请求并行；模型配置暂时不可用时仍展示本轮真实处理状态。
      void Promise.allSettled([
        client.loadAutomationDebug(request.signal),
        client.loadModelSettings(request.signal),
      ]).then(([debug, settings]) => {
        if (disposed || request.signal.aborted) return
        setError(debug.status === "rejected" || settings.status === "rejected")
        if (debug.status === "fulfilled") {
          if (debug.value.ownerId !== ownerId) {
            setSnapshot(null)
            setModel(null)
            setError(true)
            return
          }
          setSnapshot(debug.value)
        }
        setModel(settings.status === "fulfilled" ? settings.value : null)
        // 完成后再排下一次刷新；切换到文章时由外层 Activity 清理请求和计时器。
        timer = window.setTimeout(refresh, 15_000)
      })
    }
    refresh()
    window.addEventListener(localAutomationChanged, refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      disposed = true
      controller?.abort()
      window.clearTimeout(timer)
      window.removeEventListener(localAutomationChanged, refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [ownerId, reload])

  const run = snapshot?.run
  const report = parseProcessingRunReport(snapshot?.report)
  const status = error
    ? t("automation.debug.stale")
    : run?.status === "running" || run?.status === "pending"
      ? t(`processing.report.status.${run.status}`)
      : snapshot
        ? t(snapshot.status.scheduleEnabled ? "automation.debug.idle" : "automation.debug.paused")
        : t(ownerId ? "processing.report.loading" : "automation.dedupe.sign_in")
  const number = (value: number | undefined) =>
    value === undefined
      ? t("processing.report.not_collected")
      : new Intl.NumberFormat(i18n.language).format(value)
  const date = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString(i18n.language) : t("processing.report.not_collected")
  const entries = report?.entries
  const metrics = entries?.metrics
  const dedupe = report?.dedupe
  const storyCount = (key: "created" | "updated" | "pending" | "failures") =>
    report?.stories?.reduce((sum, story) => sum + story[key].length, 0)
  const errors = [
    ...(run?.error ? [run.error] : []),
    ...(report?.inventory?.failure ? [report.inventory.failure] : []),
    ...(report?.sources?.flatMap((source) => (source.failure ? [source.failure] : [])) ?? []),
    ...(entries?.failures?.map((failure) => failure.code) ?? []),
    ...(report?.stories?.flatMap((story) => story.failures.map((failure) => failure.reason)) ?? []),
    ...(report?.repair?.failures.map((failure) => failure.reason) ?? []),
  ]
  const activeRules = snapshot?.rules.filter((rule) => rule.enabled) ?? []
  const phaseKey = (
    [
      ["sources", "automation.debug.phase.sources"],
      ["material", "automation.debug.phase.material"],
      ["exact", "automation.debug.phase.exact"],
      ["entries", "automation.debug.phase.entries"],
      ["dedupe", "automation.debug.phase.dedupe"],
      ["repair", "automation.debug.phase.repair"],
      ["stories", "automation.debug.phase.stories"],
      ["presentation", "automation.debug.phase.presentation"],
    ] as const
  ).find(([name]) => name === report?.phase)?.[1]
  const phase = phaseKey
    ? t(phaseKey)
    : (report?.phase ??
      t(run?.finishedAt ? "automation.debug.phase.finished" : "processing.report.not_collected"))

  return (
    <section
      aria-label={t("automation.debug.title")}
      className="flex h-full min-h-0 min-w-0 flex-col bg-theme-background text-sm text-text print:hidden"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-fill-secondary px-6 py-4">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            error ? "bg-red" : run?.status === "running" ? "bg-orange" : "bg-green",
          )}
        />
        <h2 className="text-base font-semibold">{t("automation.debug.title")}</h2>
        <span className="ml-auto text-text-secondary">{status}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-text-secondary">
          {/* React 文本自行转义日期，避免斜杠显示成 HTML 实体。 */}
          <span>
            {t("automation.debug.updated", {
              time: date(snapshot?.observedAt),
              interpolation: { escapeValue: false },
            })}
          </span>
          <button
            type="button"
            className="rounded-md px-3 py-1.5 font-medium text-blue hover:bg-fill-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue"
            onClick={() => setReload((v) => v + 1)}
          >
            {t("processing.report.refresh")}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-red">
            {t("processing.report.load_error")}
          </p>
        )}
        {snapshot && (
          <>
            <DebugSection title={t("automation.debug.overview")}>
              <DebugMetric
                label={t("automation.debug.version")}
                value={snapshot.releaseVersion === null ? "—" : `v${snapshot.releaseVersion}`}
              />
              <DebugMetric label={t("automation.debug.rules")} value={number(activeRules.length)} />
              <DebugMetric
                label={t("automation.debug.sources")}
                value={`${snapshot.status.sourceInventory.covered} / ${snapshot.status.sourceInventory.available}`}
              />
              <DebugMetric
                label={t("automation.debug.queue")}
                value={`${snapshot.queue.running} / ${snapshot.queue.pending}`}
              />
              <DebugMetric
                label={t("processing.report.completed")}
                value={number(snapshot.status.counts.processed)}
              />
              <DebugMetric
                label={t("processing.report.pending")}
                value={number(snapshot.status.counts.pending)}
              />
              <DebugMetric
                label={t("processing.report.context_pending")}
                value={number(snapshot.status.counts.needsContext)}
              />
              <DebugMetric
                label={t("automation.debug.model")}
                value={
                  model
                    ? `${model.provider} / ${model.model}`
                    : t("processing.report.not_collected")
                }
              />
            </DebugSection>
            <DebugSection title={t("automation.debug.outcomes")}>
              <DebugMetric
                label={t("automation.debug.total")}
                value={number(snapshot.outcomes.total)}
              />
              <DebugMetric
                label={t("automation.debug.tagged")}
                value={number(snapshot.outcomes.tagged)}
              />
              <DebugMetric
                label={t("automation.debug.hidden")}
                value={number(snapshot.outcomes.hidden)}
              />
              <DebugMetric
                label={t("automation.debug.facts")}
                value={number(snapshot.outcomes.facts)}
              />
              <DebugMetric
                label={t("automation.debug.policy_pending")}
                value={number(snapshot.outcomes.policyPending)}
              />
            </DebugSection>
            {run ? (
              <DebugSection title={t("automation.debug.run")}>
                <DebugMetric
                  label={t("automation.debug.run_status")}
                  value={t(`processing.report.status.${run.status}`)}
                />
                <DebugMetric label={t("automation.debug.phase_label")} value={phase} />
                <DebugMetric
                  label={t("processing.report.updated_at")}
                  value={date(report?.finishedAt ?? report?.progressAt ?? run.startedAt)}
                />
                <DebugMetric
                  label={t("processing.report.completed")}
                  value={number(entries?.completed)}
                />
                <DebugMetric
                  label={t("processing.report.model_calls")}
                  value={number(metrics?.modelCalls)}
                />
                <DebugMetric
                  label={t("processing.report.cache_hits")}
                  value={number(metrics?.cacheHits)}
                />
                <DebugMetric
                  label={t("processing.report.read_skipped")}
                  value={number(metrics?.readSkipped)}
                />
                <DebugMetric
                  label={t("processing.report.rule_skipped")}
                  value={number(metrics?.ruleSkipped)}
                />
                <DebugMetric
                  label={t("processing.report.material_missing")}
                  value={number(metrics?.materialMissing ?? report?.material?.missing)}
                />
                <DebugMetric
                  label={t("processing.report.model_failures")}
                  value={number(metrics?.modelFailures)}
                />
                <DebugMetric
                  label={t("automation.debug.exact")}
                  value={number(dedupe?.exactDuplicates)}
                />
                <DebugMetric
                  label={t("automation.debug.semantic")}
                  value={number(dedupe?.duplicates)}
                />
                <DebugMetric
                  label={t("automation.debug.dedupe_pending")}
                  value={number(dedupe?.pending)}
                />
                <DebugMetric
                  label={t("automation.debug.stories_created")}
                  value={number(storyCount("created"))}
                />
                <DebugMetric
                  label={t("automation.debug.stories_updated")}
                  value={number(storyCount("updated"))}
                />
                <DebugMetric
                  label={t("automation.debug.stories_pending")}
                  value={number(storyCount("pending"))}
                />
                <DebugMetric
                  label={t("processing.report.input_tokens")}
                  value={number(entries?.usage?.inputTokens)}
                />
                <DebugMetric
                  label={t("processing.report.output_tokens")}
                  value={number(entries?.usage?.outputTokens)}
                />
                <DebugMetric
                  label={t("automation.debug.dedupe_tokens")}
                  value={`${number(dedupe?.usage?.inputTokens)} / ${number(dedupe?.usage?.outputTokens)}`}
                />
                <DebugMetric
                  label={t("automation.debug.story_tokens")}
                  value={
                    report?.stories &&
                    report.stories.every(
                      (story) =>
                        story.usage?.inputTokens !== undefined &&
                        story.usage.outputTokens !== undefined,
                    )
                      ? `${number(report.stories.reduce((sum, story) => sum + story.usage!.inputTokens!, 0))} / ${number(report.stories.reduce((sum, story) => sum + story.usage!.outputTokens!, 0))}`
                      : t("processing.report.not_collected")
                  }
                />
              </DebugSection>
            ) : (
              <p className="text-text-secondary">{t("processing.report.no_runs")}</p>
            )}
            {errors.length > 0 && (
              <p className="break-words rounded bg-red/10 p-2 text-red">
                {[...new Set(errors)].slice(0, 3).join(" · ")}
              </p>
            )}
            <DebugSection title={t("automation.debug.rule_results")}>
              {activeRules.map((rule) => (
                <DebugMetric
                  key={rule.id}
                  label={rule.name}
                  value={`${rule.actions.map((action) => t(action === "local_filter" ? "automation.debug.local_filter" : `automation.action.${action}`)).join(" / ")} · ${number(snapshot.status.rules.find((row) => row.ruleId === rule.id)?.processed)}`}
                />
              ))}
            </DebugSection>
            <p className="text-text-tertiary">{t("automation.debug.scope")}</p>
            <DebugSection title={t("automation.debug.recent")}>
              {snapshot.recent.map((item) => (
                <div
                  key={item.inputSeq}
                  className="space-y-1 border-b border-fill-secondary pb-2 last:border-0"
                >
                  <div className="flex justify-between gap-2">
                    <span className="truncate" title={item.title}>
                      {item.title}
                    </span>
                    <span className="shrink-0 text-text-secondary">
                      {t(`automation.debug.result.${item.status}`)}
                    </span>
                  </div>
                  <p className="break-words text-text-secondary">{item.reason}</p>
                  <p className="break-words text-text-tertiary">
                    {[item.model, ...item.labels, item.reused ? t("automation.debug.reused") : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              ))}
            </DebugSection>
          </>
        )}
      </div>
    </section>
  )
}

function DebugSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-fill-secondary pt-4">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function DebugMetric({ label, value }: { label: string; value: string }) {
  // 指标标签使用正文颜色，窄侧栏中也能清楚对照标签与数值。
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start gap-4 py-1.5">
      <span className="break-words text-text">{label}</span>
      <span className="min-w-0 break-words text-right font-medium tabular-nums [overflow-wrap:anywhere]">
        {value}
      </span>
    </div>
  )
}
