import { useCollectionStore } from "@follow/store/collection/store"
import { useEntryStore } from "@follow/store/entry/store"
import type { UseEntriesReturn } from "@follow/store/entry/types"
import { useCallback, useEffect, useMemo, useRef } from "react"

import type { GeneratedReaderItem } from "./generated-feed-client"
import { mergeNativeTimelineItems } from "./native-timeline-items"
import { readerItemMatchesTarget } from "./reader-target"
import type { GeneratedReader } from "./use-generated-reader"

/** 官方全集保留原查询，综述仅作为同一虚拟列表中的明确来源叠加。 */
export function useNativeTimelineOverlay(
  reader: GeneratedReader | null,
  entries: UseEntriesReturn & { paginationBoundary?: string },
): GeneratedReader | null {
  const data = useEntryStore((state) => state.data)
  const collections = useCollectionStore((state) => state.collections)
  const pagingRef = useRef(false)
  const originals = useMemo(() => {
    if (!reader?.nativeTimeline) return []
    return entries.entriesIds.flatMap((id): Extract<GeneratedReaderItem, { kind: "entry" }>[] => {
      const entry = data[id]
      if (!entry) return []
      return [
        {
          kind: "entry",
          origin: "original",
          id,
          sourceKey: entry.inboxHandle ? `inbox/${entry.inboxHandle}` : `feed/${entry.feedId}`,
          inputSeq: null,
          decisionId: null,
          storyIds: [],
          title: entry.title ?? "",
          summary: entry.description ?? "",
          publishedAt: entry.publishedAt.toISOString(),
          read: entry.read === true,
          collected: !!collections[id],
          materialCount: 1,
          topics: [],
        },
      ]
    })
  }, [reader?.nativeTimeline, entries.entriesIds, data, collections])
  const items = useMemo(() => {
    if (!reader?.nativeTimeline) return reader?.items ?? []
    // 综述服务故障不撤掉官方条目；服务恢复后再按完整时间区间合并。
    if (reader.failed || !reader.page) return originals
    return mergeNativeTimelineItems({
      originals,
      stories: reader.items.filter((item) => item.kind === "story"),
      originalHasNext: entries.hasNextPage,
      storyHasNext: reader.hasNextPage,
      originalBoundary: entries.paginationBoundary,
    })
  }, [reader, originals, entries.hasNextPage, entries.paginationBoundary])
  const loadMore = useCallback(async () => {
    if (pagingRef.current) return
    pagingRef.current = true
    // 每个来源保留自己的游标，任何一侧加载失败都不能推进另一侧的游标。
    try {
      await Promise.allSettled([
        entries.hasNextPage && !entries.isFetchingNextPage ? entries.fetchNextPage() : undefined,
        reader?.hasNextPage && !reader.failed ? reader.loadMore() : undefined,
      ])
    } finally {
      pagingRef.current = false
    }
  }, [entries, reader])
  const refresh = useCallback(() => {
    void entries.refetch()
    reader?.refresh()
  }, [entries, reader])
  useEffect(() => {
    // 当前区间可能全被处理规则隐藏，继续取得下一页，不能显示虚假的“没有条目”。
    if (
      reader?.active &&
      reader.nativeTimeline &&
      !items.length &&
      !entries.isLoading &&
      !entries.isFetchingNextPage &&
      !reader.loading &&
      !entries.error &&
      (entries.hasNextPage || (!reader.failed && reader.hasNextPage))
    ) {
      void loadMore()
    }
  }, [reader, items.length, entries, loadMore])
  if (!reader?.active || !reader.nativeTimeline) return reader
  const selected =
    items.find((item) => readerItemMatchesTarget(item, reader.target)) ?? reader.selected
  return {
    ...reader,
    items,
    selected,
    mutationTarget: selected ?? reader.mutationTarget,
    selectedRead: selected?.read ?? reader.selectedRead,
    selectedCollected: selected?.collected ?? reader.selectedCollected,
    hasNextPage: entries.hasNextPage || (!reader.failed && reader.hasNextPage),
    loading: entries.isLoading || (reader.loading && !reader.failed),
    isFetchingNextPage: entries.isFetchingNextPage || reader.isFetchingNextPage,
    loadMore,
    refresh,
  }
}
