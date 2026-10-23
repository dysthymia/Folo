import type { FeedViewType } from "@follow/constants"
import { unreadSyncService } from "@follow/store/unread/store"
import { t } from "i18next"
import { useTranslation } from "react-i18next"
import { View } from "react-native"

import { getHidePrivateSubscriptionsInTimeline } from "@/src/atoms/settings/general"
import { Text } from "@/src/components/ui/typography/Text"
import { CheckCircleCuteReIcon } from "@/src/icons/check_circle_cute_re"
import type { DialogComponent } from "@/src/lib/dialog"
import { Dialog } from "@/src/lib/dialog"

import type { SelectedFeed, SelectedTimeline } from "../screen/atoms"
import { getFetchEntryPayload } from "../screen/atoms"

export const MarkAllAsReadDialog: DialogComponent = () => {
  const { t } = useTranslation()
  return (
    <View>
      <Text className="text-label">{t("operation.mark_all_as_read_confirm")}</Text>
    </View>
  )
}
MarkAllAsReadDialog.title = t("operation.mark_all_as_read")
MarkAllAsReadDialog.id = "mark-all-as-read"
MarkAllAsReadDialog.headerIcon = <CheckCircleCuteReIcon />

/**
 * 中文：对话框位于根节点，由调用者传入当前时间线，避免误标整个首页。
 * 同时保留首屏请求时间，防止将刷新后新到的文章一并标为已读。
 */
export const showMarkAllAsReadDialog = (
  selectedFeed: SelectedTimeline | SelectedFeed,
  view: FeedViewType | undefined,
  fetchedTime?: number,
) => {
  Dialog.show(MarkAllAsReadDialog, {
    override: {
      onConfirm: (ctx) => {
        ctx.dismiss()
        if (typeof view !== "number") return
        unreadSyncService.markBatchAsRead({
          view,
          filter: getFetchEntryPayload(selectedFeed, view),
          time: fetchedTime ? { insertedBefore: fetchedTime } : undefined,
          excludePrivate: getHidePrivateSubscriptionsInTimeline(),
        })
      },
    },
  })
}
