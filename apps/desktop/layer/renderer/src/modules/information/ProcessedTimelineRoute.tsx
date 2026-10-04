import { FeedViewType } from "@follow/constants"
import { useAtomValue } from "jotai"
import { useMemo } from "react"

import { useRouteParams } from "~/hooks/biz/useRouteParams"
import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"
import { AIEnhancedTimelineLayout } from "~/modules/app-layout/ai-enhanced-timeline"
import { timelineContentModeAtom } from "~/modules/entry-column/atoms/processing-timeline"
import { useIsPreviewFeed } from "~/modules/entry-column/hooks/useIsPreviewFeed"
import { useFeedHeaderTitle } from "~/store/feed/hooks"

import type { GeneratedFeedQuery } from "./generated-feed-client"
import { GeneratedTimeline } from "./GeneratedTimeline"

/** 阅读范围来自现有路由；最终过滤、Story归属和合并分页由同一个服务端投影负责。 */
export function ProcessedTimelineRoute() {
  const route = useRouteParams()
  const title = useFeedHeaderTitle()
  const mode = useAtomValue(timelineContentModeAtom)
  const preview = useIsPreviewFeed()
  const scope = useMemo<GeneratedFeedQuery>(() => {
    if (route.folderName)
      return { mode: "smart", category: { view: route.view, name: route.folderName } }
    if (route.inboxId) return { mode: "smart", sourceKeys: [`inbox/${route.inboxId}`] }
    if (route.listId) return { mode: "smart", sourceKeys: [`list/${route.listId}`] }
    if (route.feedId && !route.isAllFeeds)
      return { mode: "smart", sourceKeys: [`feed/${route.feedId}`] }
    // 按同步来源的实际视图解析，包含仅通过 List 订阅的来源和 Inbox。
    return { mode: "smart", view: route.view === FeedViewType.All ? "all" : route.view }
  }, [route.folderName, route.inboxId, route.listId, route.feedId, route.isAllFeeds, route.view])

  if (!isLocalFoloHost() || mode === "original" || route.isCollection || preview)
    return <AIEnhancedTimelineLayout />
  return <GeneratedTimeline scope={scope} title={title ?? undefined} />
}
