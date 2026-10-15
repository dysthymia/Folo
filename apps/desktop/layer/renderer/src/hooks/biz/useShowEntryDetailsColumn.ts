import { getView } from "@follow/constants"

import { AIChatPanelStyle, useAIChatPanelStyle, useAIPanelVisibility } from "~/atoms/settings/ai"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"
import { useAutomationDebugEnabled } from "~/modules/action/use-automation-debug"

export const useShowEntryDetailsColumn = () => {
  const { view } = useRouteParamsSelector((s) => ({
    view: s.view,
  }))
  const aiPanelStyle = useAIChatPanelStyle()
  const isAIPanelVisible = useAIPanelVisibility()
  const debugEnabled = useAutomationDebugEnabled()

  return (
    // 启用调试后为宽列表保留正文侧栏，用户打开固定 AI 面板时仍沿用原切换逻辑。
    (!getView(view).wideMode || debugEnabled) &&
    (aiPanelStyle === AIChatPanelStyle.Floating || !isAIPanelVisible)
  )
}
