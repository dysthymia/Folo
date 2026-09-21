import type { ProcessingEditor } from "./processing-client"

export const processingFeedSourceKey = (feedId: string) => `feed/${feedId}`

export function processingTagNames(
  sourceKey: string,
  data: Pick<ProcessingEditor, "subscriptionTags" | "sourceTags"> | null,
) {
  const ids = data?.sourceTags.find((binding) => binding.sourceKey === sourceKey)?.tagIds ?? []
  return ids
    .map((id) => data?.subscriptionTags.tags.find((tag) => tag.id === id)?.name)
    .filter((name): name is string => !!name)
}

export function filterFeedIdsByProcessingTag(
  feedIds: readonly string[],
  sourceTags: ProcessingEditor["sourceTags"] | undefined,
  tagId: string,
) {
  if (tagId === "all") return [...feedIds]
  const tagged = new Set(
    sourceTags
      ?.filter((binding) => binding.tagIds.includes(tagId))
      .map((binding) => binding.sourceKey) ?? [],
  )
  return feedIds.filter((feedId) => tagged.has(processingFeedSourceKey(feedId)))
}

export function buildProcessingTagSelectionScopes(
  sources: ProcessingEditor["sources"],
  memberships: ProcessingEditor["listMemberships"],
) {
  const categories = new Map<string, { label: string; sourceKeys: string[] }>()
  for (const source of sources) {
    if (source.kind === "list" || !source.category) continue
    const key = `category:${source.view}:${source.category}`
    const current = categories.get(key) ?? {
      label: `${source.category} · ${source.view}`,
      sourceKeys: [],
    }
    current.sourceKeys.push(source.key)
    categories.set(key, current)
  }

  return {
    categories: [...categories].map(([key, value]) => ({ key, ...value })),
    lists: sources
      .filter((source) => source.kind === "list")
      .map((source) => {
        const membership = memberships.find((item) => item.listKey === source.key)
        const verified = membership?.status === "complete" && membership.complete
        return {
          key: `list:${source.id}`,
          label: source.title,
          listId: source.id,
          ownerId: membership?.ownerId ?? null,
          // 只有信息服务已持久化的完整成员集才能批量选择；缺失和部分结果都保持 unknown。
          sourceKeys: verified ? membership.feedIds.map(processingFeedSourceKey) : null,
          status: verified ? ("complete" as const) : ("unknown" as const),
          revision: membership?.revision ?? 0,
          syncedAt: membership?.syncedAt ?? null,
        }
      }),
  }
}
