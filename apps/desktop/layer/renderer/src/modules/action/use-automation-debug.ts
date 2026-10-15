import { useAISettingSelector } from "~/atoms/settings/ai"
import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"

// 正文栏和布局共用同一个偏好；没有后台时沿用原有客户端阅读布局。
export function useAutomationDebugEnabled() {
  const enabled = useAISettingSelector((settings) => settings.semanticDedupeDebugPanel)
  return enabled && isLocalFoloHost()
}
