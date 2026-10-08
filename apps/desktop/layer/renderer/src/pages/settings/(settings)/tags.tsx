import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"
import { SettingSemanticTags } from "~/modules/settings/tabs/semantic-tags"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

// 标签目录属于本机 AI 处理服务，与订阅源标签管理使用不同入口。
export const handle = defineSettingPageData({
  icon: "i-mgc-classify-2-cute-re",
  name: "titles.tags",
  priority: (1000 << 1) + 16,
  hideIf: () => !isLocalFoloHost(),
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <SettingSemanticTags />
    </>
  )
}
