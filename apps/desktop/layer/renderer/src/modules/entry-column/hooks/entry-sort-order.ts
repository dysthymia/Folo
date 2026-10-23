import type { FeedViewType } from "@follow/constants"
import { ROUTE_FEED_PENDING } from "@follow/store/constants/app"
import type { EntrySortOrder } from "@follow/store/entry/types"
import { getEffectiveEntrySortOrder, isTimelineEntriesSource } from "@follow/store/entry/utils"

interface EntrySortScope {
  feedId?: string
  inboxId?: string
  isCollection?: boolean
  isPreview?: boolean
  view?: FeedViewType
  listId?: string
  hasInboxSubscriptions?: boolean
  nativeTimeline?: boolean
}

export const isTimelineEntrySortScope = ({
  feedId,
  inboxId,
  isCollection,
  isPreview,
  nativeTimeline,
  ...scope
}: EntrySortScope) =>
  // 聚合邮件接口和原生双流都只支持倒序；路由占位符不能被当成指定订阅源。
  !isPreview &&
  !nativeTimeline &&
  isTimelineEntriesSource({
    ...scope,
    feedId: feedId === ROUTE_FEED_PENDING ? undefined : feedId,
    inboxId,
    isCollection,
  })

export const getEffectiveRouteEntrySortOrder = ({
  sortOrder,
  unreadOnly,
  ...scope
}: EntrySortScope & {
  sortOrder?: EntrySortOrder
  unreadOnly: boolean
}) =>
  getEffectiveEntrySortOrder({
    sortOrder,
    unreadOnly,
    isTimelineSource: isTimelineEntrySortScope(scope),
  })
