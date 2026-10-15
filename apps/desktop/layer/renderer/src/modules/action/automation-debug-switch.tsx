import { useTranslation } from "react-i18next"

import { setAISetting, useAISettingSelector } from "~/atoms/settings/ai"

// 复用原去重调试偏好，已有用户无需重新开启；此开关不改变后台处理规则。
export function AutomationDebugSwitch() {
  const { t } = useTranslation("app")
  const enabled = useAISettingSelector((settings) => settings.semanticDedupeDebugPanel)
  return (
    <label className="block space-y-1 text-sm">
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setAISetting("semanticDedupeDebugPanel", event.target.checked)}
        />
        {t("automation.debug.enabled")}
      </span>
      <span className="block text-xs text-text-secondary">{t("automation.debug.description")}</span>
    </label>
  )
}
