import { z } from "zod"

import type { AutomationStatus, EffectiveProcessing } from "~/modules/action/processing-client"

const count = z.number().int().nonnegative()
const reportSchema = z.object({
  dedupe: z.object({
    candidates: count,
    batches: count,
    duplicates: count,
    pending: count,
    exactDuplicates: count.optional(),
    unresolved: count.optional(),
    sharedComparisons: count.optional(),
    relationCacheHits: count.optional(),
    dedicatedComparisons: count.optional(),
    unknownUsageRequests: count.optional(),
    // 共享请求已计入单篇，只展示总量供解释，不再次累加为独立去重费用。
    sharedAnalysis: z
      .object({
        requests: count,
        pairs: count,
        unknownUsageRequests: count,
        usage: z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count }),
      })
      .optional(),
    usage: z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count }),
  }),
})

/** 只读取后台真实报告；没有报告与实际零命中分开显示。 */
export function latestDedupeReport(data: {
  runs: { id: string; finishedAt: string | null }[]
  reports: { triggerId: string; report: unknown }[]
}) {
  for (const run of [...data.runs]
    .filter((run) => run.finishedAt)
    .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))) {
    const parsed = reportSchema.safeParse(
      data.reports.find((report) => report.triggerId === run.id)?.report,
    )
    if (parsed.success) return { ...parsed.data.dedupe, finishedAt: run.finishedAt! }
  }
  return null
}

/** 覆盖代表规则条件涉及来源，不承诺每条内容均符合动作 scope 或会发生去重。 */
export function backendDedupeCoverage(effective: EffectiveProcessing, status: AutomationStatus) {
  const rules =
    effective.config?.rules.filter(
      (rule) => rule.enabled && rule.actions.some((action) => action.type === "ai_dedupe"),
    ) ?? []
  const ids = new Set(rules.map((rule) => rule.id))
  const sources = new Set(
    status.rules.filter((rule) => ids.has(rule.ruleId)).flatMap((rule) => rule.sourceKeys),
  )
  const unknown = new Set(
    status.rules.filter((rule) => ids.has(rule.ruleId)).flatMap((rule) => rule.unknownSourceKeys),
  )
  return {
    rules: rules.length,
    covered: sources.size,
    available: status.sourceInventory.available,
    unknown: unknown.size,
  }
}
