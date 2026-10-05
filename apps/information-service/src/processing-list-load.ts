import { z } from "zod"

import { resolveAIRuleSourceKeys } from "./processing-rule-scope"
import type { ProcessingTarget, ProcessingTrigger } from "./processing-schedule"
import type { Store } from "./store"

// 只接收本次列表的元信息；正文与引用材料由后台原有水合流程验证。
export const listLoadedSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(300),
            sourceKey: z.string().trim().min(1).max(300),
            title: z.string().max(20000),
            publishedAt: z.iso.datetime({ offset: true }),
            url: z.url().max(10000).nullable(),
            read: z.boolean().nullable(),
            description: z.string().max(100000).nullable(),
            updatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()

export function listLoadSourceKeys(store: Store): Set<string> {
  const config = store.schedule.snapshot().config
  if (!config?.enabled || !config.runOnListLoad) return new Set()
  const rules = new Set(resolveAIRuleSourceKeys(store))
  return new Set(config.sourceKeys.filter((key) => rules.has(key)))
}

export function processListLoaded(
  store: Store,
  body: unknown,
  now = new Date(),
): { accepted: number; trigger: ProcessingTrigger | null } {
  const { entries } = listLoadedSchema.parse(body)
  const config = store.schedule.snapshot().config
  const allowed = listLoadSourceKeys(store)
  if (!config || !allowed.size) return { accepted: 0, trigger: null }
  const targets: ProcessingTarget[] = []
  const seen = new Set<string>()
  let trigger: ProcessingTrigger | null = null
  store.transaction(() => {
    for (const entry of entries) {
      const identity = JSON.stringify([entry.sourceKey, entry.id])
      if (seen.has(identity) || !allowed.has(entry.sourceKey)) continue
      seen.add(identity)
      const publishedAt = Date.parse(entry.publishedAt)
      if (publishedAt < Date.parse(config.historySince) || publishedAt > now.getTime()) continue
      // 已读状态也同步回已有材料，但它不会成为本次后台目标。
      store.saveListedEntry({ ...store.entry(entry.sourceKey, entry.id), ...entry, content: null })
      if (entry.read === false) targets.push({ sourceKey: entry.sourceKey, itemId: entry.id })
    }
    // 已排队的定时或手动批次能消费这些已同步条目，无需再建重叠列表任务。
    const snapshot = store.schedule.snapshot()
    const pending = store.schedule
      .pendingTriggers()
      .filter(
        (run) =>
          run.status === "pending" &&
          run.kind !== "list_loaded" &&
          run.configRevision === snapshot.revision,
      )
    const uncovered = targets.filter((target) => {
      const entry = store.entry(target.sourceKey, target.itemId)!
      const covering = pending.find(
        (run) =>
          run.sourceKeys.includes(target.sourceKey) &&
          Date.parse(entry.publishedAt) >= Date.parse(run.historySince) &&
          Date.parse(entry.publishedAt) <= Date.parse(run.cutoffAt),
      )
      if (covering) trigger ??= covering
      return !covering
    })
    const releaseVersion = store.automation.effective().releaseVersion
    const signatures = new Map(
      uncovered.map((target) => [
        JSON.stringify([target.sourceKey, target.itemId]),
        JSON.stringify([
          store.automation.current(target.sourceKey, target.itemId)?.contentVersion,
          releaseVersion,
        ]),
      ]),
    )
    trigger = store.schedule.listLoaded(uncovered, now, signatures) ?? trigger
  })
  return { accepted: targets.length, trigger }
}
