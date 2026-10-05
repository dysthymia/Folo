import { FeedViewType } from "@follow/constants"
import { getSubscriptionByFeedId } from "@follow/store/subscription/getter"
import { isBizId } from "@follow/utils/utils"
import type { PropsWithChildren } from "react"
import { useMemo } from "react"
import { useLocation } from "react-router"

import { useRouterRouteParams } from "~/hooks/biz/useRouteParams"
import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"
import { AIEnhancedTimelineLayout } from "~/modules/app-layout/ai-enhanced-timeline"

import type { GeneratedFeedQuery } from "./generated-feed-client"
import { NativeReaderProvider } from "./native-reader-provider"

/** 私人综述叠加到官方条目，原生列表、内容和导航始终使用同一布局。 */
export function ProcessedTimelineRoute() {
  return <AIEnhancedTimelineLayout />
}

/** 放在原生 EntriesProvider 外，让来源、行操作和快捷键共享明确的阅读目标。 */
export function NativeTimelineReaderProvider({ children }: PropsWithChildren) {
  const route = useRouterRouteParams()
  // 来源资格和范围取自同一次路由快照，避免切换页面时沿用旧来源的预览状态。
  const previewId = route.listId ?? route.feedId
  const preview = !!previewId && isBizId(previewId) && !getSubscriptionByFeedId(previewId)
  const { pathname } = useLocation()
  const isGenerated = pathname === "/events"
  // 所有普通阅读范围保留官方条目；未处理不等于不可读，两种模式只改变已发布决定的过滤。
  const nativeTimeline = pathname.startsWith("/timeline/") && !route.isCollection && !preview
  const scope = useMemo<GeneratedFeedQuery>(() => {
    if (isGenerated) return { mode: "stories" }
    if (route.isCollection) return { mode: "collections" }
    // 官方查询负责当前范围的全部原文，处理服务只提供同范围的综述，避免以采集库存替代订阅。
    const readerMode = nativeTimeline ? "stories" : "smart"
    if (route.folderName)
      return {
        mode: readerMode,
        // 全部视图的分类跨越内容类型，用服务端明确的 all 语义而不是 UI 枚举 -1。
        category: {
          view: route.view === FeedViewType.All ? "all" : route.view,
          name: route.folderName,
        },
      }
    if (route.inboxId) return { mode: readerMode, sourceKeys: [`inbox/${route.inboxId}`] }
    if (route.listId) return { mode: readerMode, sourceKeys: [`list/${route.listId}`] }
    if (route.feedId && !route.isAllFeeds)
      return { mode: readerMode, sourceKeys: [`feed/${route.feedId}`] }
    return { mode: readerMode, view: route.view === FeedViewType.All ? "all" : route.view }
  }, [
    isGenerated,
    nativeTimeline,
    route.isCollection,
    route.folderName,
    route.inboxId,
    route.listId,
    route.feedId,
    route.isAllFeeds,
    route.view,
  ])
  const enabled =
    isLocalFoloHost() && !preview && (isGenerated || pathname.startsWith("/timeline/"))
  return (
    <NativeReaderProvider enabled={enabled} scope={scope} nativeTimeline={nativeTimeline}>
      {children}
    </NativeReaderProvider>
  )
}
