import { useTranslation } from "react-i18next"
import { z } from "zod"

import type { ProcessingRun } from "./processing-client"

const count = z.number().finite().int().nonnegative().optional()
const failureSchema = z.object({ code: z.string() })
const usageSchema = z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count })
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
  // 全范围待办与当前模型小批分开，旧报告缺少的数据继续显示未采集。
  progress: z
    .object({
      total: count,
      completed: count,
      queued: count,
      running: count,
      waitingMaterial: count,
      waitingContext: count,
      failed: count,
      deferred: count,
      skipped: count,
      sourcesRemaining: count,
      remaining: count,
    })
    .optional(),
  continuation: z.string().nullable().optional(),
  inventory: z.object({ failure: z.string().nullable().optional() }).optional(),
  sources: z.array(z.object({ failure: z.string().nullable().optional() })).optional(),
  entries: z
    .object({
      completed: count,
      pending: count,
      failures: z.array(failureSchema).optional(),
      metrics: metricsSchema.optional(),
      usage: z.object(usageSchema.shape).nullable().optional(),
    })
    .optional(),
  material: z.object({ complete: count, missing: count, failed: count }).optional(),
  // 各阶段用量独立展示，共享分析已经计入单篇，不能再次相加。
  dedupe: z
    .object({
      exactDuplicates: count,
      duplicates: count,
      candidates: count,
      pending: count,
      unresolved: count,
      usage: usageSchema.optional(),
    })
    .optional(),
  stories: z
    .array(
      z.object({
        created: z.array(z.object({ storyId: z.string() })),
        updated: z.array(z.object({ storyId: z.string() })),
        pending: z.array(z.object({ reason: z.string() })),
        failures: z.array(z.object({ reason: z.string() })),
        usage: usageSchema.optional(),
      }),
    )
    .optional(),
  repair: z
    .object({
      repaired: z.array(z.object({ storyId: z.string() })),
      failures: z.array(z.object({ reason: z.string() })),
      usage: usageSchema.optional(),
    })
    .optional(),
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
    ["processing.report.pending", number(parsed?.progress?.remaining ?? entries?.pending)],
    ["automation.debug.progress_queued", number(parsed?.progress?.queued)],
    ["automation.debug.progress_running", number(parsed?.progress?.running)],
    ["automation.debug.progress_waiting_material", number(parsed?.progress?.waitingMaterial)],
    ["automation.debug.progress_waiting_context", number(parsed?.progress?.waitingContext)],
    ["automation.debug.progress_failed", number(parsed?.progress?.failed)],
    ["automation.debug.progress_deferred", number(parsed?.progress?.deferred)],
    ["automation.debug.progress_sources", number(parsed?.progress?.sourcesRemaining)],
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
