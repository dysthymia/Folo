import type { AutomationRule } from "@follow/information-core"
import { useCallback, useEffect, useState } from "react"

import { getOneTimeToken, isLocalFoloHost } from "../ai-chat/local-provider"
import { createProcessingClient } from "./processing-client"

// 仅用于统一列表的只读取数：走本机 2240 路径，与处理服务自身的保存/编辑互不干扰。
// 编辑仍由 ProcessingSetting 经同一 client 写回 2240，存储语义不串。
const client = createProcessingClient(getOneTimeToken)

export type ProcessingServiceRulesState = {
  rules: AutomationRule[]
  // null = 加载中；true = 可用（本机部署且 2240 可达）；false = 不可用
  available: boolean | null
  loading: boolean
  // 详情面板里保存后重新取一次，否则统一列表看不见刚建的规则（本页内的编辑不刷新页面）。
  refresh: () => void
}

export function useProcessingServiceRules(): ProcessingServiceRulesState {
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    // 非本机部署直接判定不可用，避免向官方域请求一次性凭据。
    if (!isLocalFoloHost()) {
      setAvailable(false)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    client
      .load(controller.signal)
      .then((editor) => {
        if (controller.signal.aborted) return
        setRules(editor.config.rules)
        setAvailable(true)
        setLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setAvailable(false)
        setLoading(false)
      })
    return () => controller.abort()
  }, [revision])

  return { rules, available, loading, refresh }
}
