import type { GeneratedReaderItem } from "./generated-feed-client"

type OriginalItem = Extract<GeneratedReaderItem, { kind: "entry" }>
type StoryItem = Extract<GeneratedReaderItem, { kind: "story" }>

/** 两个独立分页流只展示都已覆盖的时间区间，避免下一页插到已展示的旧综述前。 */
export function mergeNativeTimelineItems({
  originals,
  stories,
  originalHasNext,
  storyHasNext,
  originalBoundary,
}: {
  originals: OriginalItem[]
  stories: StoryItem[]
  originalHasNext: boolean
  storyHasNext: boolean
  originalBoundary?: string
}): GeneratedReaderItem[] {
  // 官方页可能全部被隐藏，但响应页尾仍能证明覆盖范围，不能用可见行是否为空代替它。
  const originalEnd = originalBoundary ?? originals.at(-1)?.publishedAt
  const storyEnd = stories.at(-1)?.publishedAt
  // 未耗尽流没有可靠水位时，不能提前展示另一流。
  if ((originalHasNext && !originalEnd) || (storyHasNext && !storyEnd)) return []

  const originalFloor = originalHasNext && originalEnd ? Date.parse(originalEnd) : -Infinity
  const storyFloor = storyHasNext && storyEnd ? Date.parse(storyEnd) : -Infinity
  // 无效边界不能证明覆盖范围，保留缓冲等待有效分页结果。
  if (Number.isNaN(originalFloor) || Number.isNaN(storyFloor)) return []
  const floor = Math.max(originalFloor, storyFloor)
  const seen = new Set<string>()
  return (
    [...stories, ...originals]
      .filter((item) => {
        // 原文身份取官方 ID；综述取 Story ID，二者即使字符串相同也不是同一对象。
        const key = item.kind === "story" ? `story:${item.storyId}` : `entry:${item.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return Date.parse(item.publishedAt) >= floor
      })
      // 稳定排序保留 SDK 同时间原文顺序；初始 Story 在前确定跨类型同时间顺序。
      .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
  )
}
