import { GeneratedTimeline } from "~/modules/information/GeneratedTimeline"

// 内置源是私人的阅读投影，不伪造官方 feedId，也不创建第二个工作台。
const scope = { mode: "stories" } as const
export function Component() {
  return <GeneratedTimeline scope={scope} />
}
