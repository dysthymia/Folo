import type { RuleInput } from "@follow/information-core"
import { visibleLength } from "@follow/information-core"

import type { Source, SourceEntry } from "./folo"
import type { Store } from "./store"

function sourceByKey(sources: Source[], key: string | null): Source | null {
  return key === null ? null : (sources.find((source) => source.key === key) ?? null)
}

function platformFromUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./u, "")
    if (hostname === "x.com" || hostname === "twitter.com") return "x"
    return hostname || null
  } catch {
    return null
  }
}

// 运行前由 engine 传入已冻结的 entry；read/collected 变化不会在同一批内重新匹配。
export function processingRuleInput(
  store: Store,
  sourceKey: string,
  entry: SourceEntry,
  text: string | null,
  complete: boolean,
): RuleInput {
  const synced = store.sourceSync.contextFor(sourceKey, entry)
  const sources = store.sources()
  const contextSource = sourceByKey(sources, sourceKey)
  const sourceId = entry.feedId
    ? `${entry.feedKind ?? "feed"}/${entry.feedId}`
    : contextSource?.kind === "list"
      ? null
      : synced.sourceId
  const actualSource = sourceByKey(sources, sourceId)
  // 私人标签与来源 URL 只取真实 feed/inbox；List 容器只提供 view/category/list 成员上下文。
  const bindings = sourceId ? store.subscriptionTags.sourceTagBindings([sourceId]).bindings : []
  const tagIds = sourceId
    ? (bindings.find((binding) => binding.sourceKey === sourceId)?.tagIds ?? [])
    : null
  return {
    source_id: sourceId,
    contextId: sourceKey,
    view: synced.view ?? contextSource?.view ?? null,
    category: contextSource?.category ?? null,
    category_ref:
      synced.categoryRef ??
      (contextSource?.category ? { view: contextSource.view, name: contextSource.category } : null),
    list_id: synced.listMembership,
    subscription_tag: tagIds,
    title:
      actualSource?.title ??
      (contextSource?.kind === "list" ? null : (contextSource?.title ?? null)),
    site_url: actualSource?.siteUrl ?? null,
    feed_url: actualSource?.feedUrl ?? null,
    platform:
      actualSource?.platform ??
      platformFromUrl(entry.url) ??
      platformFromUrl(actualSource?.siteUrl) ??
      platformFromUrl(actualSource?.feedUrl),
    entry_title: entry.title,
    entry_content: text,
    entry_url: entry.url,
    entry_author: entry.author ?? null,
    language: entry.language ?? null,
    read: entry.read,
    collected: entry.collected ?? null,
    entry_media_length: entry.mediaLength ?? null,
    entry_attachments_duration: entry.attachmentsDuration ?? null,
    updated_at: entry.updatedAt ?? null,
    content_completeness: complete ? "complete" : null,
    visible_length: visibleLength(text ?? "", complete),
  }
}
