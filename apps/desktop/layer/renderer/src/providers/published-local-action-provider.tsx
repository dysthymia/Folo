import {
  clearPublishedLocalFilters,
  hydratePublishedLocalFilters,
  setPublishedLocalFilters,
} from "@follow/store/action/published-local-filters"
import { useWhoami } from "@follow/store/user/hooks"
import { useEffect } from "react"

import { localAutomationChanged } from "~/modules/action/local-automation-events"
import { createProcessingClient } from "~/modules/action/processing-client"
import { getOneTimeToken, isLocalFoloHost } from "~/modules/ai-chat/local-provider"

const client = createProcessingClient(getOneTimeToken)

export function PublishedLocalActionProvider() {
  const ownerId = useWhoami()?.id
  useEffect(() => {
    // 账号切换立即隔离；同一账号的瞬时网络故障保留最后一次已发布结果。
    clearPublishedLocalFilters()
    if (!ownerId || !isLocalFoloHost()) return
    hydratePublishedLocalFilters(ownerId)
    let controller: AbortController | null = null
    const refresh = async () => {
      controller?.abort()
      controller = new AbortController()
      const request = controller
      try {
        const current = await client.loadEffective(request.signal)
        if (request.signal.aborted || !current.config || current.config.ownerId !== ownerId) return
        setPublishedLocalFilters({
          ownerId,
          ruleSet: current.config,
          sources: current.sources,
          sourceTags: current.sourceTags,
          listMemberships: current.listMemberships,
        })
      } catch {
        // 不把后台短暂离线解释为“用户停用了全部普通规则”。
      }
    }
    const onRefresh = () => {
      void refresh()
    }
    void refresh()
    window.addEventListener(localAutomationChanged, onRefresh)
    window.addEventListener("focus", onRefresh)
    const interval = window.setInterval(onRefresh, 60_000)
    return () => {
      controller?.abort()
      window.clearInterval(interval)
      window.removeEventListener(localAutomationChanged, onRefresh)
      window.removeEventListener("focus", onRefresh)
      clearPublishedLocalFilters(ownerId)
    }
  }, [ownerId])
  return null
}
