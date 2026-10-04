import { useTranslation } from "react-i18next"
import { z } from "zod"

import type { ProcessingRun } from "./processing-client"

const count = z.number().finite().int().nonnegative().optional()
const metricsSchema = z.object({
  elapsedMs: z.number().finite().nonnegative().optional(),
  modelCalls: count,
  cacheHits: count,
  readSkipped: count,
  ruleSkipped: count,
  materialMissing: count,
  materialFailed: count,
  contextPending: count,
  modelFailures: count,
  budgetDeferred: count,
  publishedBatches: count,
})
const reportSchema = z.object({
  phase: z.string().optional(),
  progressAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  entries: z
    .object({
      completed: count,
      pending: count,
      metrics: metricsSchema.optional(),
      usage: z
        .object({ inputTokens: count, outputTokens: count, cachedInputTokens: count })
        .nullable()
        .optional(),
    })
    .optional(),
  material: z.object({ complete: count, missing: count, failed: count }).optional(),
})

// 报告来自历史兼容 unknown 字段；非法数字与缺字段保持未采集，不补成零。
export function parseProcessingRunReport(value: unknown) {
  try {
    const body: unknown =
      typeof value === "string" && value.length <= 1_000_000 ? JSON.parse(value) : value
    const parsed = reportSchema.safeParse(body)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const duration = (milliseconds: number, locale: string) =>
  `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(milliseconds / 1000)} s`

export function ProcessingRunReport({ run, report }: { run: ProcessingRun; report: unknown }) {
  const { t, i18n } = useTranslation("app")
  const parsed = parseProcessingRunReport(report)
  const entries = parsed?.entries
  const metrics = entries?.metrics
  const unknown = t("processing.report.not_collected")
  const number = (value: number | undefined) =>
    value === undefined ? unknown : new Intl.NumberFormat(i18n.language).format(value)
  const elapsed = (start: string | null, end: string | undefined) => {
    if (!start || !end) return unknown
    const value = Date.parse(end) - Date.parse(start)
    return Number.isFinite(value) && value >= 0 ? duration(value, i18n.language) : unknown
  }
  const rows = [
    ["processing.report.published_batches", number(metrics?.publishedBatches)],
    ["processing.report.completed", number(entries?.completed)],
    ["processing.report.pending", number(entries?.pending)],
    ["processing.report.model_calls", number(metrics?.modelCalls)],
    ["processing.report.cache_hits", number(metrics?.cacheHits)],
    ["processing.report.queue_wait", elapsed(run.createdAt, run.startedAt ?? undefined)],
    [
      "processing.report.run_elapsed",
      elapsed(run.startedAt, parsed?.finishedAt ?? parsed?.progressAt),
    ],
    [
      "processing.report.entry_elapsed",
      metrics?.elapsedMs === undefined ? unknown : duration(metrics.elapsedMs, i18n.language),
    ],
    ["processing.report.read_skipped", number(metrics?.readSkipped)],
    ["processing.report.rule_skipped", number(metrics?.ruleSkipped)],
    [
      "processing.report.material_missing",
      number(metrics?.materialMissing ?? parsed?.material?.missing),
    ],
    [
      "processing.report.material_failed",
      number(metrics?.materialFailed ?? parsed?.material?.failed),
    ],
    ["processing.report.context_pending", number(metrics?.contextPending)],
    ["processing.report.model_failures", number(metrics?.modelFailures)],
    ["processing.report.budget_deferred", number(metrics?.budgetDeferred)],
    ["processing.report.input_tokens", number(entries?.usage?.inputTokens)],
    ["processing.report.output_tokens", number(entries?.usage?.outputTokens)],
    ["processing.report.cached_tokens", number(entries?.usage?.cachedInputTokens)],
    // Token 用量没有对应单价与币种时，不推断付款金额。
    ["processing.report.cost", unknown],
  ] as const
  return (
    <section className="space-y-3" aria-label={t("processing.report.title")}>
      {parsed?.progressAt && (
        <p className="text-xs text-text-secondary">
          {t("processing.report.updated_at")} ·{" "}
          {new Date(parsed.progressAt).toLocaleString(i18n.language)}
        </p>
      )}
      {!parsed && <p className="text-sm text-text-secondary">{t("processing.report.no_report")}</p>}
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-text-secondary">{t(label)}</dt>
            <dd className="mt-1 break-words text-sm tabular-nums text-text">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-text-secondary">{t("processing.report.usage_scope")}</p>
    </section>
  )
}
