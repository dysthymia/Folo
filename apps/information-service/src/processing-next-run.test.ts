import { describe, expect, it } from "vitest"

import { nextProcessingRunAt } from "./processing-next-run"
import type { ProcessingScheduleReadingStatus } from "./processing-schedule"

const status: ProcessingScheduleReadingStatus = {
  revision: 1,
  enabled: true,
  timeZone: "Asia/Shanghai",
  nextScheduledStartLocal: "2026-10-04T08:00",
  nextScheduledReadyLocal: "2026-10-04T08:15",
  readyByLeadMinutes: 15,
  pollIntervalMinutes: 30,
  nextPollAt: "2026-10-04T00:30:00.000Z",
}
describe("实际下次执行时间", () => {
  it("按后台时区转换当地钟点并取较早的定时任务", () => {
    expect(nextProcessingRunAt(status)).toBe("2026-10-04T00:00:00.000Z")
  })
  it("轮询较早时取轮询时间，暂停时无下一次运行", () => {
    expect(nextProcessingRunAt({ ...status, nextPollAt: "2026-10-03T23:00:00.000Z" })).toBe(
      "2026-10-03T23:00:00.000Z",
    )
    expect(nextProcessingRunAt({ ...status, enabled: false })).toBeNull()
  })
})
