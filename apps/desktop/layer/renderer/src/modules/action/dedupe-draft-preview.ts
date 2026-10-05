import type { AutomationRule, RuleInput } from "@follow/information-core"
import { conditionSetSchema, matchConditions } from "@follow/information-core"

import type { ProcessingEditor } from "./processing-client"

/** 用现有样本预览上界，不调用模型；缺失正文、已读等字段保持 unknown。 */
export function previewDedupeDraft(rule: AutomationRule, editor: ProcessingEditor) {
  const scopes = rule.actions
    .filter((action) => action.type === "ai_dedupe")
    .map((action) => action.scope)
  // 编辑中的空条件不能交给运行时匹配器，也不能伪装成零匹配或 ALL；补全后再预览。
  if (
    ![rule.when, ...scopes].every((conditions) => conditionSetSchema.safeParse(conditions).success)
  )
    return null
  let matched = 0
  let unknown = 0
  const sourceKeys = new Set<string>()
  for (const item of editor.items) {
    const source = editor.sources.find((source) => source.key === item.sourceKey)
    const input: RuleInput = {
      source_id: source?.kind === "list" ? null : item.sourceKey,
      contextId: item.sourceKey,
      title: source?.kind === "list" ? null : source?.title,
      entry_title: item.title,
      category: source?.category,
      site_url: source?.siteUrl,
      feed_url: source?.feedUrl,
      entry_url: item.url,
      view: source?.view,
      category_ref: source?.category ? { view: source.view, name: source.category } : null,
      platform: source?.platform,
    }
    const when = matchConditions(rule.when, input).state
    if (when === "no_match") continue
    const matches = scopes.map((scope) => matchConditions(scope, input).state)
    if (!matches.some((state) => state !== "no_match")) continue
    sourceKeys.add(item.sourceKey)
    if (when === "match" && matches.includes("match")) matched++
    else unknown++
  }
  const count = matched + unknown
  return { matched, unknown, sources: sourceKeys.size, pairs: (count * (count - 1)) / 2 }
}
