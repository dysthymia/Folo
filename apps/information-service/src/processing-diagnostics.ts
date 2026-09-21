import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

import { visibleLength } from "@follow/information-core"
import { z } from "zod"

import { contentIdentity } from "./content-identity"
import type { Store } from "./store"

const usageSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  model: z.string(),
  provider: z.string(),
  purpose: z.enum(["entry", "story", "chat", "preview", "unknown"]).default("unknown"),
  status: z.string(),
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cachedInputTokens: z.number().nonnegative(),
    })
    .nullable(),
})

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction: number) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) }
}

// 所有比例都附带分母；当前输入快照与模型调用账本分开，失败后的未知用量不当作零。
export async function processingDiagnostics(store: Store, ledgerPath: string, now = new Date()) {
  const inputs = store.automation.inputs()
  const published = store.processingState.published()
  // 大批输入按序号索引完成状态，避免每条输入重新扫描所有决定。
  const completedSeqs = new Set(published.map((decision) => decision.input.seq))
  const schedule = store.schedule.snapshot().config
  const configured = inputs.filter(
    (input) =>
      schedule?.sourceKeys.includes(input.sourceKey) &&
      input.body.publishedAt &&
      Date.parse(input.body.publishedAt) >= Date.parse(schedule.historySince) &&
      Date.parse(input.body.publishedAt) <= now.getTime(),
  )
  // 积压只统计当前计划会处理的材料；范围外历史和未来发布时间不能伪装成待办。
  const pending = configured.filter((input) => !completedSeqs.has(input.seq))
  const days = new Map<
    string,
    { day: string; currentContextsReceived: number; completedContexts: number }
  >()
  for (const input of inputs) {
    const day = input.receivedAt.slice(0, 10)
    const row = days.get(day) ?? { day, currentContextsReceived: 0, completedContexts: 0 }
    row.currentContextsReceived++
    if (completedSeqs.has(input.seq)) row.completedContexts++
    days.set(day, row)
  }
  const tokens = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  const durations: Record<"entry" | "story" | "chat" | "preview" | "unknown", number[]> = {
    entry: [],
    story: [],
    chat: [],
    preview: [],
    unknown: [],
  }
  let ledgerAvailable = true,
    calls = 0,
    failedCalls = 0,
    unknownUsageCalls = 0,
    invalidRows = 0
  let observedFrom: string | null = null
  try {
    const stream = createReadStream(ledgerPath, { encoding: "utf8" })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          invalidRows++
          continue
        }
        const parsed = usageSchema.safeParse(raw)
        if (!parsed.success) {
          invalidRows++
          continue
        }
        const row = parsed.data
        calls++
        if (row.status !== "succeeded") failedCalls++
        if (!observedFrom || row.startedAt < observedFrom) observedFrom = row.startedAt
        durations[row.purpose].push(
          Math.max(0, Date.parse(row.finishedAt) - Date.parse(row.startedAt)),
        )
        if (!row.usage) unknownUsageCalls++
        else
          for (const key of Object.keys(tokens) as Array<keyof typeof tokens>)
            tokens[key] += row.usage[key]
      }
    } finally {
      lines.close()
      stream.destroy()
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      ledgerAvailable = false
    else throw error
  }
  const completeMaterials = inputs.filter(
    (input) => store.processingState.material(input) === "complete",
  )
  return {
    observedAt: now.toISOString(),
    scope: {
      currentInputContexts: inputs.length,
      configuredInputContexts: configured.length,
      completedContexts: published.length,
      // 与处理及阅读使用同一原帖身份，查询上下文不重复扩大内容分母。
      uniqueCurrentItems: new Set(inputs.map((input) => contentIdentity(input.body))).size,
    },
    material: {
      complete: completeMaterials.length,
      denominator: inputs.length,
      visibleCharacters: distribution(
        completeMaterials.map((input) => visibleLength(input.body.content ?? "", true) ?? 0),
      ),
    },
    backlog: {
      contexts: pending.length,
      oldestAgeSeconds: pending.length
        ? Math.max(
            0,
            ...pending.map((input) => (now.getTime() - Date.parse(input.receivedAt)) / 1000),
          )
        : null,
      bySource: [...new Set(configured.map((input) => input.sourceKey))].map((sourceKey) => ({
        sourceKey,
        contexts: configured.filter((input) => input.sourceKey === sourceKey).length,
        pending: pending.filter((input) => input.sourceKey === sourceKey).length,
      })),
    },
    decisions: {
      count: published.length,
      reused: published.filter((item) => item.decision.reused).length,
      durationMs: distribution(published.map((item) => item.decision.durationMs)),
    },
    modelCalls: {
      ledgerAvailable,
      observedFrom,
      calls,
      failedCalls,
      unknownUsageCalls,
      invalidRows,
      knownUsage: tokens,
      completeUsage: ledgerAvailable && unknownUsageCalls === 0 && invalidRows === 0,
      durationMs: Object.fromEntries(
        Object.entries(durations).map(([purpose, values]) => [purpose, distribution(values)]),
      ),
    },
    dailyCurrentContexts: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    // 尚无受控稳态/停机恢复实验时不把当前计数推算成每天可处理能力。
    capacityPerDay: null,
    backlogRecoverySeconds: null,
    semanticAcceptance: "awaiting_user_confirmed_samples" as const,
  }
}

export function diagnosticsApi(store: Store, ledgerPath: string) {
  return {
    async handle(method: string, path: string): Promise<object | undefined> {
      return method === "GET" && path === "/diagnostics"
        ? { diagnostics: await processingDiagnostics(store, ledgerPath) }
        : undefined
    },
  }
}
