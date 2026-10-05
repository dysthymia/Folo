import type { FeedViewType } from "@follow/constants"
import { useSubscriptionIdsByView } from "@follow/store/subscription/hooks"
import { useSubscriptionStore } from "@follow/store/subscription/store"
import { useUnreadByIds } from "@follow/store/unread/hooks"
import { useCallback } from "react"

import { useGeneralSettingKey } from "~/atoms/settings/general"

/** 分组和视图汇总只统计时间线可见来源，单个订阅仍保留自己的未读数。 */
export function useSidebarUnreadByIds(ids: string[]) {
  const excludePrivate = useGeneralSettingKey("hidePrivateSubscriptionsInTimeline")
  const visibleIds = useSubscriptionStore(
    useCallback(
      (state) =>
        ids.filter((id) => {
          // 邮件未读以 inbox handle 为键，订阅设置则使用 inbox/ 前缀。
          const subscription = state.data[id] ?? state.data[`inbox/${id}`]
          return (
            subscription?.hideFromTimeline !== true && !(excludePrivate && subscription?.isPrivate)
          )
        }),
      [ids, excludePrivate],
    ),
  )
  return useUnreadByIds(visibleIds)
}

export function useSidebarUnreadByView(view: FeedViewType) {
  const ids = useSubscriptionIdsByView(view)
  return useSidebarUnreadByIds(ids)
}
