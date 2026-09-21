const defaultTimeline = "/timeline/view-0/all/pending"

export function originalReadingPath(path: string | null) {
  // 返回入口只接受站内时间线，防止查询参数把用户带到外部站点。
  if (!path?.startsWith("/timeline/") || path.includes("\\")) return defaultTimeline
  const parsed = new URL(path, "http://local.folo.is")
  return parsed.pathname.startsWith("/timeline/")
    ? parsed.pathname + parsed.search
    : defaultTimeline
}

export function smartReadingPath(path: string, storyId?: string) {
  // 深链：带上 storyId 让智能阅读页直接定位到那一篇综述，而不是只回到列表首页。
  const query = new URLSearchParams({ returnTo: originalReadingPath(path) })
  if (storyId) query.set("storyId", storyId)
  return `/information?${query.toString()}#smart-reading`
}
