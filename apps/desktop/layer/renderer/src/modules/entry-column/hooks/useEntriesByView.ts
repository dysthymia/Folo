import { FeedViewType, getView } from "@follow/constants"
import { useLocalActionHydration, useLocalActionRevision } from "@follow/store/action/local-hooks"
import { filterLocalActionEntryIds } from "@follow/store/action/local-match"
import { useCollectionEntryList } from "@follow/store/collection/hooks"
import { isOnboardingEntryUrl } from "@follow/store/constants/onboarding"
import {
  useEntriesQuery,
  useEntryIdsByFeedId,
  useEntryIdsByFeedIds,
  useEntryIdsByInboxId,
  useEntryIdsByListId,
  useEntryIdsByView,
} from "@follow/store/entry/hooks"
import {
  isEntryHiddenByProcessingRole,
  useEntryProcessingRolesRevision,
} from "@follow/store/entry/processing-role"
import { useSemanticDedupeProcessor } from "@follow/store/entry/semantic-dedupe"
import { entryActions, entrySyncServices, useEntryStore } from "@follow/store/entry/store"
import type { UseEntriesReturn } from "@follow/store/entry/types"
import { dedupeEntryIdsByTitle, fallbackReturn } from "@follow/store/entry/utils"
import { useFolderFeedsByFeedId } from "@follow/store/subscription/hooks"
import { unreadSyncService } from "@follow/store/unread/store"
import { useWhoami } from "@follow/store/user/hooks"
import { nextFrame } from "@follow/utils"
import { isBizId } from "@follow/utils/utils"
import { useMutation } from "@tanstack/react-query"
import { debounce } from "es-toolkit/compat"
import { useAtomValue } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useAISettingKey } from "~/atoms/settings/ai"
import { useGeneralSettingKey } from "~/atoms/settings/general"
import { ROUTE_FEED_PENDING } from "~/constants/app"
import { useFeature } from "~/hooks/biz/useFeature"
import { useRouteParams } from "~/hooks/biz/useRouteParams"
import { useNativeReader } from "~/modules/information/native-reader-context"
import { useServiceProcessingRoles } from "~/modules/information/processing-role-client"
import type { LoadedEntryRef } from "~/modules/information/use-list-load-processing"
import { useListLoadProcessing } from "~/modules/information/use-list-load-processing"

import { aiTimelineEnabledAtom } from "../atoms/ai-timeline"
import { timelineContentModeAtom } from "../atoms/processing-timeline"
import { getVisibleLocalEntryIds } from "./filter-local-entry-ids"
import { useIsPreviewFeed } from "./useIsPreviewFeed"

const emptyLoadedEntryRefs: LoadedEntryRef[] = []

const useRemoteEntries = (
  enabled = true,
  chronological = false,
): UseEntriesReturn & {
  paginationBoundary?: string
  loadedEntryRefs?: LoadedEntryRef[]
} => {
  const { feedId, view, inboxId, listId } = useRouteParams()
  const isPreview = useIsPreviewFeed()

  const unreadOnly = useGeneralSettingKey("unreadOnly")
  const hidePrivateSubscriptionsInTimeline = useGeneralSettingKey(
    "hidePrivateSubscriptionsInTimeline",
  )
  const aiTimelineEnabled = useAtomValue(aiTimelineEnabledAtom)
  const aiEnabled = useFeature("ai")

  const folderIds = useFolderFeedsByFeedId({
    feedId,
    view,
  })

  const entriesOptions = useMemo(() => {
    const params = {
      feedId: folderIds?.join(",") || feedId,
      inboxId,
      listId,
      view,
      ...(unreadOnly === true && !isPreview && { unreadOnly: true }),
      ...(hidePrivateSubscriptionsInTimeline === true && {
        hidePrivateSubscriptionsInTimeline: true,
      }),
      ...(view === FeedViewType.All && { limit: 40 }),
      // 双流时间合并依赖官方时间游标；AI 排序没有后续页，不能用于普通全部列表。
      ...(!chronological && aiTimelineEnabled && aiEnabled && { aiSort: true }),
    }

    if (feedId && listId && isBizId(feedId)) {
      delete params.listId
    }

    return params
  }, [
    feedId,
    folderIds,
    inboxId,
    listId,
    unreadOnly,
    isPreview,
    view,
    hidePrivateSubscriptionsInTimeline,
    aiTimelineEnabled,
    aiEnabled,
    chronological,
  ])
  const query = useEntriesQuery(enabled ? entriesOptions : undefined)
  // 触发范围取本次实际加载的原始页，不能用隐藏/去重后的显示列表遗漏待处理条目。
  const loadedEntryRefs = useMemo(
    () =>
      query.data?.pages.flatMap(
        (page) =>
          page.data?.map((row) => ({
            entryId: row.entries.id,
            sourceKey: entriesOptions.listId
              ? `list/${entriesOptions.listId}`
              : `${row.feeds.type === "inbox" ? "inbox" : "feed"}/${row.feeds.id}`,
          })) ?? [],
      ) ?? [],
    [query.data, entriesOptions.listId],
  )

  const refetch = useCallback(async () => void query.refetch(), [query])
  const fetchNextPage = useCallback(async () => void query.fetchNextPage(), [query])

  if (!query.data || query.isLoading) {
    return fallbackReturn
  }
  return {
    entriesIds: query.entriesIds,
    hasNext: query.hasNextPage,
    refetch,

    fetchNextPage,
    isLoading: query.isFetching,
    isRefetching: query.isRefetching,
    isReady: query.isSuccess,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetching: query.isFetching,
    hasNextPage: query.hasNextPage,
    error: query.isError ? query.error : null,
    fetchedTime: query.fetchedTime,
    queryKey: query.queryKey,
    loadedEntryRefs,
    // 使用未过滤的原始响应页尾，AI 隐藏条目不能缩短已覆盖的时间区间。
    paginationBoundary: query.data.pages.at(-1)?.data?.at(-1)?.entries.publishedAt,
  }
}

function getEntryIdsFromMultiplePlace(...entryIds: Array<string[] | undefined | null>) {
  return entryIds.find((ids) => ids?.length) ?? []
}

const useLocalEntries = (): UseEntriesReturn => {
  const { feedId, view, inboxId, listId, isCollection } = useRouteParams()
  const unreadOnly = useGeneralSettingKey("unreadOnly")
  const hidePrivateSubscriptionsInTimeline = useGeneralSettingKey(
    "hidePrivateSubscriptionsInTimeline",
  )
  const localActionRevision = useLocalActionRevision()
  const reader = useNativeReader()
  const contentMode = useAtomValue(timelineContentModeAtom)
  // 后台模式的严格重复由规则决定，原始模式也不能先按标题丢掉正文不同的条目。
  const titleDedupe = !reader?.active && contentMode !== "original" && !isCollection

  const folderIds = useFolderFeedsByFeedId({
    feedId,
    view,
  })
  const entryIdsByView = useEntryIdsByView(view, hidePrivateSubscriptionsInTimeline)
  const entryIdsByCollections = useCollectionEntryList(view)
  const entryIdsByFeedId = useEntryIdsByFeedId(feedId)
  const entryIdsByCategory = useEntryIdsByFeedIds(folderIds)
  const entryIdsByListId = useEntryIdsByListId(listId)
  const entryIdsByInboxId = useEntryIdsByInboxId(inboxId)

  const showEntriesByView =
    (!feedId || feedId === ROUTE_FEED_PENDING) &&
    folderIds.length === 0 &&
    !isCollection &&
    !inboxId &&
    !listId

  const localQueryKey = useMemo(
    () => [feedId || "", view, inboxId || "", listId || "", isCollection ? "1" : "0"].join(":"),
    [feedId, inboxId, isCollection, listId, view],
  )
  const stickyVisibleStateRef = useRef<{
    queryKey: string
    ids: Set<string>
  }>({
    queryKey: localQueryKey,
    ids: new Set<string>(),
  })

  const allEntries = useEntryStore(
    useCallback(
      (state) => {
        void localActionRevision
        const ids = isCollection
          ? entryIdsByCollections
          : showEntriesByView
            ? (entryIdsByView ?? [])
            : (getEntryIdsFromMultiplePlace(
                entryIdsByFeedId,
                entryIdsByCategory,
                entryIdsByListId,
                entryIdsByInboxId,
              ) ?? [])

        const stickyVisibleIds =
          unreadOnly && stickyVisibleStateRef.current.queryKey === localQueryKey
            ? stickyVisibleStateRef.current.ids
            : undefined

        const visibleEntryIds = getVisibleLocalEntryIds({
          sourceIds: ids,
          entries: state.data,
          stickyVisibleIds,
          unreadOnly,
        })

        const actionFilteredEntryIds = filterLocalActionEntryIds(visibleEntryIds)
        if (!titleDedupe) return actionFilteredEntryIds
        return dedupeEntryIdsByTitle({
          entryIds: actionFilteredEntryIds,
          getTitle: (entryId) => state.data[entryId]?.title,
        })
      },
      [
        entryIdsByCategory,
        entryIdsByCollections,
        entryIdsByFeedId,
        entryIdsByInboxId,
        entryIdsByListId,
        entryIdsByView,
        isCollection,
        localQueryKey,
        localActionRevision,
        showEntriesByView,
        unreadOnly,
        titleDedupe,
      ],
    ),
  )

  useEffect(() => {
    stickyVisibleStateRef.current = {
      queryKey: localQueryKey,
      ids: unreadOnly ? new Set(allEntries) : new Set<string>(),
    }
  }, [allEntries, localQueryKey, unreadOnly])

  const [page, setPage] = useState(0)
  const pageSize = 30
  const totalPage = useMemo(
    () => (allEntries ? Math.ceil(allEntries.length / pageSize) : 0),
    [allEntries],
  )

  const entries = useMemo(() => {
    return allEntries?.slice(0, (page + 1) * pageSize) || []
  }, [allEntries, page, pageSize])

  const hasNext = useMemo(() => {
    return entries.length < (allEntries?.length || 0)
  }, [entries.length, allEntries])

  const refetch = useCallback(async () => {
    setPage(0)
  }, [])

  const fetchNextPage = useCallback(
    debounce(async () => {
      setPage(page + 1)
    }, 300),
    [page],
  )

  useEffect(() => {
    setPage(0)
  }, [view, feedId])

  return {
    entriesIds: entries,
    hasNext,
    refetch,
    fetchNextPage: fetchNextPage as () => Promise<void>,
    isLoading: false,
    isRefetching: false,
    isReady: true,
    isFetchingNextPage: false,
    isFetching: false,
    hasNextPage: page < totalPage,
    error: null,
  }
}

export const useEntriesByView = ({ onReset }: { onReset?: () => void }) => {
  const { view, listId, isCollection } = useRouteParams()
  const isPreview = useIsPreviewFeed()
  const user = useWhoami()

  useLocalActionHydration(user?.id)

  const reader = useNativeReader()
  const generated = !!reader?.active && !reader.nativeTimeline
  // 私人投影不再抓原文列表；普通时间线加载事件由后台队列统一执行。
  const remoteQuery = useRemoteEntries(!generated, reader?.nativeTimeline)
  const localQuery = useLocalEntries()

  useFetchEntryContentByStream(generated ? undefined : remoteQuery.entriesIds)

  // If remote data is not available, we use the local data, get the local data length
  // FIXME: remote first, then local store data
  // NOTE: We still can't use the store's data handling directly.
  // Imagine that the local data may be persistent, and then if there are incremental updates to the data on the server side,
  // then we have no way to incrementally update the data.
  // We need to add an interface to incrementally update the data based on the version hash.

  const query = remoteQuery.isReady ? remoteQuery : localQuery
  const rawEntryIds: string[] = query.entriesIds
  useListLoadProcessing({
    refs: remoteQuery.loadedEntryRefs ?? emptyLoadedEntryRefs,
    owner: user?.id,
    enabled:
      !!reader?.active &&
      !!reader.nativeTimeline &&
      remoteQuery.isReady &&
      !remoteQuery.isFetching &&
      !isCollection &&
      !isPreview,
    loadVersion: remoteQuery.fetchedTime,
  })
  const semanticDedupeEnabled = useAISettingKey("semanticDedupeEnabled")
  // 混合列表继续官方分页，但处理决定仍由后台发布，读列表不能重复触发前端模型去重。
  useSemanticDedupeProcessor(!reader?.active && semanticDedupeEnabled ? rawEntryIds : [])
  // 处理服务的决策（隐藏、综述、同内容转载）先落到角色层，再和本地去重一起生效。
  useServiceProcessingRoles()
  // 时间线只读统一角色层：本地去重与处理服务决策都在这里生效，避免各接一套。
  const processingRoleRevision = useEntryProcessingRolesRevision()
  // 「原始内容」只跳过这一处过滤：范围与排序不变，因此计数随之恢复（§6 场景一）。
  const timelineContentMode = useAtomValue(timelineContentModeAtom)
  const entryIds = useMemo(() => {
    void processingRoleRevision

    // 收藏与预览仍是原文范围，不能因处理模式隐藏已收藏或尚未订阅的内容。
    if (timelineContentMode === "original" || isCollection || isPreview) return rawEntryIds

    return rawEntryIds.filter(
      (entryId) => !isEntryHiddenByProcessingRole(entryId, { localDedupe: semanticDedupeEnabled }),
    )
  }, [
    rawEntryIds,
    semanticDedupeEnabled,
    processingRoleRevision,
    timelineContentMode,
    isCollection,
    isPreview,
  ])

  const isFetchingFirstPage = remoteQuery.isFetching && !remoteQuery.isFetchingNextPage

  useEffect(() => {
    if (isFetchingFirstPage) {
      nextFrame(() => {
        onReset?.()
      })
    }
  }, [isFetchingFirstPage, query.queryKey])

  const groupByDate = useGeneralSettingKey("groupByDate")
  const groupedCounts: number[] | undefined = useMemo(() => {
    const viewDefinition = getView(view)
    if (viewDefinition?.gridMode || view === FeedViewType.All) {
      return
    }
    if (!groupByDate) {
      return
    }
    const entriesId2Map = entryActions.getFlattenMapEntries()
    const counts = [] as number[]
    let lastDate = ""
    for (const id of entryIds) {
      const entry = entriesId2Map[id]
      if (!entry) {
        continue
      }
      if (isOnboardingEntryUrl(entry.url)) {
        continue
      }
      const date = new Date(listId ? entry.insertedAt : entry.publishedAt).toDateString()
      if (date !== lastDate) {
        counts.push(1)
        lastDate = date
      } else {
        const last = counts.pop()
        if (last) counts.push(last + 1)
      }
    }

    return counts
  }, [groupByDate, listId, entryIds, view])

  return {
    ...query,

    type: remoteQuery.isReady ? ("remote" as const) : ("local" as const),
    refetch: useCallback(() => {
      const promise = query.refetch()
      unreadSyncService.resetFromRemote()
      return promise
    }, [query]),
    entriesIds: entryIds,
    paginationBoundary: remoteQuery.isReady ? remoteQuery.paginationBoundary : undefined,
    groupedCounts,
    isFetching: remoteQuery.isFetching,
    isFetchingNextPage: remoteQuery.isFetchingNextPage,
    isLoading: remoteQuery.isLoading,
  }
}

const useFetchEntryContentByStream = (remoteEntryIds?: string[]) => {
  const { mutate: updateEntryContent } = useMutation({
    mutationKey: ["stream-entry-content", remoteEntryIds],
    mutationFn: (remoteEntryIds: string[]) =>
      entrySyncServices.fetchEntryContentByStream(remoteEntryIds),
  })

  useEffect(() => {
    if (!remoteEntryIds) return
    updateEntryContent(remoteEntryIds)
  }, [remoteEntryIds, updateEntryContent])
}
