import type { ProcessingScheduleReadingStatus } from "./processing-schedule"

// 把计划的当地钟点转换为 UTC，避免浏览器以自己的时区误读后台执行时间。
export function nextProcessingRunAt(status: ProcessingScheduleReadingStatus): string | null {
  if (!status.enabled) return null
  const candidates = status.nextPollAt ? [Date.parse(status.nextPollAt)] : []
  if (status.nextScheduledStartLocal && status.timeZone) {
    const local = status.nextScheduledStartLocal
    const wanted = Date.parse(`${local}Z`)
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: status.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    let candidate = wanted
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = Object.fromEntries(
        formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
      )
      const observed = Date.parse(
        `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`,
      )
      if (observed === wanted) {
        candidates.push(candidate)
        break
      }
      candidate += wanted - observed
    }
    // 夏令时跳过的当地钟点无法准确定位时不伪造时间，原始钟点仍由 status 单独返回。
  }
  const valid = candidates.filter(Number.isFinite)
  return valid.length ? new Date(Math.min(...valid)).toISOString() : null
}
