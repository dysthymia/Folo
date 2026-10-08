import { getView } from "@follow/constants"
import { unreadSyncService } from "@follow/store/unread/store"
import type { Range } from "@tanstack/react-virtual"
import { useMemo } from "react"
import { useEventCallback } from "usehooks-ts"

import { useGeneralSettingKey } from "~/atoms/settings/general"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"

type EntryMarkReadHandler = (range: Range, enabled?: boolean) => void

export const useEntryMarkReadHandler = (
  entriesIds: string[],
  {
    pauseScrollMarkRead = false,
    markRangeAsRead,
  }: {
    pauseScrollMarkRead?: boolean
    markRangeAsRead?: (range: Range) => void
  } = {},
) => {
  const renderAsRead = useGeneralSettingKey("renderMarkUnread")
  const scrollMarkUnread = useGeneralSettingKey("scrollMarkUnread")
  const feedView = useRouteParamsSelector((params) => params.view)

  const handleRangeMarkRead = useEventCallback((range: Range, enabled?: boolean) => {
    if (!enabled) return
    // 混合列表按可见行分发读态，Story 身份不能进入官方条目的已读队列。
    if (markRangeAsRead) {
      markRangeAsRead(range)
      return
    }
    const { startIndex, endIndex } = range
    const idSlice = entriesIds?.slice(startIndex, endIndex)
    if (!idSlice?.length) return

    batchMarkRead(idSlice)
  })

  const handleScrollMarkRead = useEventCallback((range: Range, enabled?: boolean) => {
    if (pauseScrollMarkRead) return
    handleRangeMarkRead(range, enabled)
  })

  const renderMarkReadHandler = useMemo<EntryMarkReadHandler | undefined>(() => {
    if (!getView(feedView)?.wideMode || !renderAsRead) {
      return
    }

    return handleRangeMarkRead
  }, [feedView, handleRangeMarkRead, renderAsRead])

  const scrollMarkReadHandler = useMemo<EntryMarkReadHandler | undefined>(() => {
    if (!scrollMarkUnread) {
      return
    }

    return handleScrollMarkRead
  }, [handleScrollMarkRead, scrollMarkUnread])

  return useMemo(() => {
    return {
      handleRenderMarkRead: renderMarkReadHandler,
      handleScrollMarkRead: scrollMarkReadHandler,
    }
  }, [renderMarkReadHandler, scrollMarkReadHandler])
}

export function batchMarkRead(ids: string[]) {
  if (ids.length === 0) return
  void unreadSyncService.queueEntriesAsRead(ids)
}
