const defaultTimeline = "/timeline/view-0/all/pending"

export function originalReadingPath(path: string | null) {
  // 返回入口只接受站内时间线，防止查询参数把用户带到外部站点。
  if (!path?.startsWith("/timeline/") || path.includes("\\")) return defaultTimeline
  const parsed = new URL(path, "http://local.folo.is")
  return parsed.pathname.startsWith("/timeline/")
    ? parsed.pathname + parsed.search
    : defaultTimeline
}

export function smartReadingPath(path: string) {
  return `/information?returnTo=${encodeURIComponent(originalReadingPath(path))}#smart-reading`
}
