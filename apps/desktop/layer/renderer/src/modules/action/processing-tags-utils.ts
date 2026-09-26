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
