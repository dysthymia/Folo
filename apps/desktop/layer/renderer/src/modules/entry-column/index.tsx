import { FeedViewType, getView } from "@follow/constants"
import { useScrollMarkReadGracePeriod, useTitle } from "@follow/hooks"
import { getScrollMarkReadRangeState } from "@follow/shared/scroll-mark-read"
import { useEntry } from "@follow/store/entry/hooks"
import { useFeedById } from "@follow/store/feed/hooks"
import { useSubscriptionByFeedId } from "@follow/store/subscription/hooks"
import { unreadSyncService } from "@follow/store/unread/store"
import { useIsLoggedIn } from "@follow/store/user/hooks"
import { isBizId } from "@follow/utils/utils"
import type { Range, Virtualizer } from "@tanstack/react-virtual"
import { atom, useAtomValue } from "jotai"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useGeneralSettingKey } from "~/atoms/settings/general"
import { Focusable } from "~/components/common/Focusable"
import { FeedNotFound } from "~/components/errors/FeedNotFound"
import { FEED_COLLECTION_LIST, HotkeyScope, ROUTE_FEED_PENDING } from "~/constants"
import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"
import { useRouteParams, useRouteParamsSelector } from "~/hooks/biz/useRouteParams"
import { useFeedQuery } from "~/queries/feed"
import { useFeedHeaderTitle } from "~/store/feed/hooks"

import { generatedItemKey } from "../information/generated-feed-identity"
import { useNativeReader } from "../information/native-reader-context"
import { NativeReaderFilters } from "../information/NativeReaderFilters"
import { NativeReaderRow } from "../information/NativeReaderRow"
import { aiTimelineEnabledAtom } from "./atoms/ai-timeline"
import { AITimelineLoadingOverlay } from "./components/ai-timeline-loading/AITimelineLoadingOverlay"
import { EntryColumnWrapper } from "./components/entry-column-wrapper/EntryColumnWrapper"
import { FooterMarkItem } from "./components/FooterMarkItem"
import { useEntriesActions, useEntriesState } from "./context/EntriesContext"
import { EntryItemSkeleton } from "./EntryItemSkeleton"
import { EntryColumnGrid } from "./grid"
import { useAttachScrollBeyond } from "./hooks/useAttachScrollBeyond"
import { useSnapEntryIdList } from "./hooks/useEntryIdListSnap"
import { useEntryMarkReadHandler } from "./hooks/useEntryMarkReadHandler"
import { useNavigateFirstEntry } from "./hooks/useNavigateFirstEntry"
import { EntryListHeader } from "./layouts/EntryListHeader"
import { EntryEmptyList, EntryList } from "./list"
import { shouldScrollTimelineToTopOnRefreshStateChange } from "./refresh-reset"
import {
  shouldResetScrollOnTimelineIdentityChange,
  shouldSuspendMarkReadForScrollReset,
} from "./scroll-reset"
import { EntryRootStateContext } from "./store/EntryColumnContext"

function EntryColumnContent() {
  const listRef = useRef<Virtualizer<HTMLElement, Element>>(undefined)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()
  const state = useEntriesState()
  const reader = useNativeReader()
  const generated = !!reader?.active
  const listScrollRef = reader?.listScrollRef
  useLayoutEffect(() => {
    if (!listScrollRef) return
    listScrollRef.current = (index) => listRef.current?.scrollToIndex(index, { align: "auto" })
    return () => {
      listScrollRef.current = null
    }
  }, [listScrollRef])

  const isInteracted = useRef(false)
  const scrollMarkReadAnchorIndexRef = useRef<number | null>(null)
  const latestRangeStartIndexRef = useRef<number | null>(null)
  const resetScrollInteractionState = useCallback(() => {
    isInteracted.current = false
    scrollMarkReadAnchorIndexRef.current = null
    latestRangeStartIndexRef.current = null
  }, [])

  const actions = useEntriesActions()
  const [resetScrollSignal, setResetScrollSignal] = useState<number>()
  const [appliedResetScrollSignal, setAppliedResetScrollSignal] = useState<number>()
  const isScrollResetPending = shouldSuspendMarkReadForScrollReset({
    resetSignal: resetScrollSignal,
    appliedResetSignal: appliedResetScrollSignal,
  })
  const handleResetScrollSignalConsumed = useCallback((signal: number) => {
    setAppliedResetScrollSignal((currentSignal) =>
      currentSignal === signal ? currentSignal : signal,
    )
  }, [])
  const scrollTimelineToTop = useCallback(() => {
    resetScrollInteractionState()
    setResetScrollSignal((signal) => (signal ?? 0) + 1)

    const runScrollToTop = () => {
      listRef.current?.scrollToOffset(0)

      const scrollArea = scrollAreaRef.current
      if (!scrollArea) return

      scrollArea.scrollTop = 0
      scrollArea.scrollLeft = 0
    }

    runScrollToTop()
    globalThis.requestAnimationFrame?.(runScrollToTop)
  }, [resetScrollInteractionState])
  // Register reset handler to keep scroll behavior when data resets
  useEffect(() => {
    actions.setOnReset(scrollTimelineToTop)
    return () => actions.setOnReset(null)
  }, [actions, scrollTimelineToTop])

  const entriesIds = useMemo(
    () => (generated ? reader.items.map(generatedItemKey) : state.entriesIds),
    [generated, reader?.items, state.entriesIds],
  )
  const groupedCounts = generated ? undefined : state.groupedCounts
  // AI 聊天的原文选择快照只含真实 entryId，综述不得伪装成官方条目。
  const originalIds = useMemo(
    () =>
      generated
        ? reader.items.flatMap((item) => (item.kind === "entry" ? [item.id] : []))
        : entriesIds,
    [entriesIds, generated, reader?.items],
  )
  useSnapEntryIdList(originalIds)

  const {
    entryId: activeEntryId,
    view,
    feedId: routeFeedId,
    isPendingEntry,
    isCollection,
  } = useRouteParams()

  const entry = useEntry(activeEntryId, (state) => {
    const { feedId } = state
    return { feedId }
  })
  const feed = useFeedById(routeFeedId)
  const title = useFeedHeaderTitle()
  useTitle(title)
  const isLoggedIn = useIsLoggedIn()
  const timelineIdentity = generated ? reader.queryKey : `${view}:${routeFeedId ?? ""}`

  useEffect(() => {
    if (generated || !activeEntryId) return

    if (isCollection || isPendingEntry) return
    if (!entry?.feedId) return

    if (!isLoggedIn) return
    unreadSyncService.markEntryAsRead(activeEntryId)
  }, [activeEntryId, entry?.feedId, isCollection, isPendingEntry, isLoggedIn, generated])

  // 双流分页仍沿用原生分页语义，不能把加载下一页误认为刷新而清空滚动位置。
  const isRefreshing = generated
    ? reader.loading && !reader.isFetchingNextPage
    : state.isFetching && !state.isFetchingNextPage
  const isLoading = generated ? reader.loading && !reader.failed : state.isLoading
  const refetch = generated ? reader.refresh : actions.refetch
  const pauseScrollMarkRead = useScrollMarkReadGracePeriod(
    isRefreshing,
    undefined,
    timelineIdentity,
  )

  const previousTimelineIdentityRef = useRef<string>(undefined)
  useLayoutEffect(() => {
    const previousTimelineIdentity = previousTimelineIdentityRef.current
    previousTimelineIdentityRef.current = timelineIdentity

    resetScrollInteractionState()
    if (
      shouldResetScrollOnTimelineIdentityChange({
        enabled: view === FeedViewType.SocialMedia,
        previousTimelineIdentity,
        timelineIdentity,
      })
    ) {
      scrollTimelineToTop()
    }
  }, [resetScrollInteractionState, scrollTimelineToTop, timelineIdentity, view])

  const wasRefreshingRef = useRef(isRefreshing)
  useEffect(() => {
    const wasRefreshing = wasRefreshingRef.current
    wasRefreshingRef.current = isRefreshing

    if (
      !shouldScrollTimelineToTopOnRefreshStateChange({
        wasRefreshing,
        isRefreshing,
      })
    ) {
      return
    }
    scrollTimelineToTop()
  }, [isRefreshing, scrollTimelineToTop])

  const { handleRenderMarkRead, handleScrollMarkRead } = useEntryMarkReadHandler(
    generated ? [] : entriesIds,
    {
      pauseScrollMarkRead,
    },
  )

  const flushScrollMarkRead = useCallback(
    (currentStartIndex: number) => {
      if (generated || !routeFeedId) return

      const { nextAnchorIndex, range } = getScrollMarkReadRangeState({
        anchorIndex: scrollMarkReadAnchorIndexRef.current,
        currentStartIndex,
      })
      scrollMarkReadAnchorIndexRef.current = nextAnchorIndex

      if (range) {
        handleScrollMarkRead?.(range as Range, isInteracted.current)
      }
    },
    [generated, handleScrollMarkRead, routeFeedId],
  )

  const handleScroll = useCallback(() => {
    if (isScrollResetPending) {
      return
    }

    if (!isInteracted.current) {
      isInteracted.current = true
    }

    if (latestRangeStartIndexRef.current !== null) {
      flushScrollMarkRead(latestRangeStartIndexRef.current)
    }
  }, [flushScrollMarkRead, isScrollResetPending])

  const { handleScroll: handleScrollBeyond } = useAttachScrollBeyond()
  const handleCombinedScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      handleScrollBeyond(e)
      if (generated) reader.saveScroll()
      else handleScroll()
    },
    [generated, reader, handleScrollBeyond, handleScroll],
  )

  const navigate = useNavigateEntry()

  const aiTimelineEnabled = useAtomValue(aiTimelineEnabledAtom)
  const showAiTimelineLoading =
    !generated && aiTimelineEnabled && state.isLoading && !state.isFetchingNextPage
  const renderAsRead = useGeneralSettingKey("renderMarkUnread")
  const handleRangeChange = useCallback(
    (e: Range) => {
      if (latestRangeStartIndexRef.current === e.startIndex) {
        return
      }

      latestRangeStartIndexRef.current = e.startIndex
      if (isScrollResetPending) {
        return
      }

      if (scrollMarkReadAnchorIndexRef.current === null) {
        scrollMarkReadAnchorIndexRef.current = e.startIndex
      } else if (isInteracted.current) {
        flushScrollMarkRead(e.startIndex)
      }

      if (!renderAsRead) return
      if (!getView(view)?.wideMode) {
        return
      }
      // For gird, render as mark read logic
      handleRenderMarkRead?.(e, isInteracted.current)
    },
    [flushScrollMarkRead, handleRenderMarkRead, isScrollResetPending, renderAsRead, view],
  )

  const fetchNextPage = useCallback(() => {
    if (generated) {
      void reader.loadMore()
      return
    }
    if (state.hasNextPage && !state.isFetchingNextPage) {
      actions.fetchNextPage()
    }
  }, [generated, reader, actions, state.hasNextPage, state.isFetchingNextPage])

  const ListComponent = getView(view)?.gridMode ? EntryColumnGrid : EntryList

  useNavigateFirstEntry(generated ? [] : entriesIds, activeEntryId, view, navigate)

  return (
    <Focusable
      scope={HotkeyScope.Timeline}
      data-hide-in-print
      className="relative flex h-full flex-1 flex-col @container"
      onClick={generated ? undefined : () => navigate({ view, entryId: null })}
    >
      {!generated &&
        entriesIds.length === 0 &&
        !state.isLoading &&
        !state.error &&
        (!feed || feed?.type === "feed") && <AddFeedHelper />}

      <EntryListHeader
        refetch={refetch}
        isRefreshing={isRefreshing}
        onBeforeRefresh={scrollTimelineToTop}
        fetchedTime={state.fetchedTime}
      />

      <NativeReaderFilters />
      <EntryColumnWrapper
        ref={(element) => {
          scrollAreaRef.current = element
          if (reader) reader.scrollRef.current = element
        }}
        onScroll={handleCombinedScroll}
        key={timelineIdentity}
      >
        {entriesIds.length === 0 ? (
          isLoading ? (
            <EntryItemSkeleton view={view} />
          ) : (
            <EntryEmptyList />
          )
        ) : (
          <ListComponent
            gap={view === FeedViewType.SocialMedia ? 10 : undefined}
            listRef={listRef}
            onRangeChange={handleRangeChange}
            hasNextPage={generated ? reader.hasNextPage : state.hasNextPage}
            view={view}
            feedId={routeFeedId || ""}
            entriesIds={entriesIds}
            listIdentity={timelineIdentity}
            renderItem={
              generated
                ? (index) => {
                    const item = reader.items[index]
                    return item ? <NativeReaderRow item={item} view={view} /> : null
                  }
                : undefined
            }
            fetchNextPage={fetchNextPage}
            refetch={refetch}
            groupCounts={groupedCounts}
            appliedResetScrollSignal={appliedResetScrollSignal}
            onResetScrollSignalConsumed={handleResetScrollSignalConsumed}
            resetScrollSignal={resetScrollSignal}
            suspendMarkRead={isScrollResetPending}
            syncType={state.type}
            Footer={
              isCollection || generated ? (
                void 0
              ) : (
                <FooterMarkItem view={view} fetchedTime={state.fetchedTime} />
              )
            }
          />
        )}
      </EntryColumnWrapper>

      <AITimelineLoadingOverlay
        visible={showAiTimelineLoading}
        label={t("entry_list_header.ai_timeline_loading")}
      />
    </Focusable>
  )
}

function EntryColumnImpl() {
  return (
    <EntryRootStateContext
      value={useMemo(
        () => ({
          isScrolledBeyondThreshold: atom(false),
        }),
        [],
      )}
    >
      <EntryColumnContent />
    </EntryRootStateContext>
  )
}

const AddFeedHelper = () => {
  const feedId = useRouteParamsSelector((s) => s.feedId)
  const feedQuery = useFeedQuery({ id: feedId })

  const hasSubscription = useSubscriptionByFeedId(feedId || "")

  if (hasSubscription) {
    return null
  }

  if (!feedId) {
    return
  }
  if (feedId === FEED_COLLECTION_LIST || feedId === ROUTE_FEED_PENDING) {
    return null
  }
  if (!isBizId(feedId)) {
    return null
  }

  if (feedQuery.error && feedQuery.error.statusCode === 404) {
    throw new FeedNotFound()
  }
}

export const EntryColumn = memo(EntryColumnImpl)
