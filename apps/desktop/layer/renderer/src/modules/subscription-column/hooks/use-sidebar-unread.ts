import type { FeedViewType } from "@follow/constants"
import { useLocalActionRevision } from "@follow/store/action/local-hooks"
import { isEntryBlockedByLocalActions } from "@follow/store/action/local-match"
import { useCollectionStore } from "@follow/store/collection/store"
import {
  isEntryHiddenByProcessingRole,
  useEntryProcessingRolesRevision,
} from "@follow/store/entry/processing-role"
import { useEntryStore } from "@follow/store/entry/store"
import { useFeedStore } from "@follow/store/feed/store"
import { useListFeedIds } from "@follow/store/list/hooks"
import { useSubscriptionIdsByView } from "@follow/store/subscription/hooks"
import { useSubscriptionStore } from "@follow/store/subscription/store"
import { useUnreadStore } from "@follow/store/unread/store"
import { useAtomValue } from "jotai"
import { useCallback, useMemo } from "react"

import { useAISettingKey } from "~/atoms/settings/ai"
import { useGeneralSettingKey } from "~/atoms/settings/general"
import { timelineContentModeAtom } from "~/modules/entry-column/atoms/processing-timeline"

import { getFilteredSidebarUnreadCount } from "./sidebar-unread-count"

const emptyIds: string[] = []

/** 侧栏只计算展示数量，复用列表的过滤判定，不写回未读状态。 */
export function useSidebarUnreadByIds(ids: string[], excludeHiddenSources = true) {
  const excludePrivate = useGeneralSettingKey("hidePrivateSubscriptionsInTimeline")
  const subscriptions = useSubscriptionStore((state) => state.data)
  const visibleIds = useMemo(
    () =>
      ids.filter((id) => {
        // 邮件未读以 inbox handle 为键，订阅设置则使用 inbox/ 前缀。
        const subscription = subscriptions[id] ?? subscriptions[`inbox/${id}`]
        return (
          !excludeHiddenSources ||
          (subscription?.hideFromTimeline !== true && !(excludePrivate && subscription?.isPrivate))
        )
      }),
    [ids, subscriptions, excludePrivate, excludeHiddenSources],
  )
  const entries = useEntryStore(
    useCallback(
      (state) => {
        // 只读取当前来源的索引，避免每个订阅角标都遍历整份条目缓存。
        const entryIds = new Set(
          visibleIds.flatMap((id) => [
            ...(state.entryIdByFeed[id] ?? []),
            ...(state.entryIdByInbox[id] ?? []),
          ]),
        )
        return [...entryIds].flatMap((id) => (state.data[id] ? [state.data[id]] : []))
      },
      [visibleIds],
    ),
  )
  const unread = useUnreadStore((state) => state.data)
  const localRevision = useLocalActionRevision()
  const roleRevision = useEntryProcessingRolesRevision()
  const mode = useAtomValue(timelineContentModeAtom)
  const localDedupe = useAISettingKey("semanticDedupeEnabled")
  // 动作条件可能依赖来源名称、分类或收藏状态，这些变化也必须刷新计数。
  const feeds = useFeedStore((state) => state.feeds)
  const collections = useCollectionStore((state) => state.collections)
  return useMemo(() => {
    void localRevision
    void roleRevision
    void feeds
    void collections
    return getFilteredSidebarUnreadCount({
      sourceIds: visibleIds,
      unread,
      entries,
      isBlocked: isEntryBlockedByLocalActions,
      isHidden: (id) => mode !== "original" && isEntryHiddenByProcessingRole(id, { localDedupe }),
    })
  }, [
    visibleIds,
    unread,
    entries,
    localRevision,
    roleRevision,
    feeds,
    collections,
    mode,
    localDedupe,
  ])
}

/** 单独的订阅入口保留隐藏来源自身的计数，但同样扣除条目级过滤。 */
export function useSidebarUnreadById(id: string) {
  const ids = useMemo(() => [id], [id])
  return useSidebarUnreadByIds(ids, false)
}

export function useSidebarUnreadByListId(id: string) {
  const ids = useListFeedIds(id)
  return useSidebarUnreadByIds(ids ?? emptyIds)
}

export function useSidebarUnreadByView(view: FeedViewType) {
  const ids = useSubscriptionIdsByView(view)
  return useSidebarUnreadByIds(ids)
}
