import { describe, expect, it } from "vitest"

import { latestDedupeReport } from "./backend-dedupe"

describe("后台去重报告", () => {
  it("区分缺少报告与真实零命中，并按完成时间选择最近报告", () => {
    expect(latestDedupeReport({ runs: [], reports: [] })).toBeNull()
    const report = {
      dedupe: {
        candidates: 0,
        batches: 0,
        duplicates: 0,
        pending: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      },
    }
    expect(
      latestDedupeReport({
        runs: [
          { id: "old", finishedAt: "2026-10-03T01:00:00Z" },
          { id: "new", finishedAt: "2026-10-04T01:00:00Z" },
        ],
        reports: [
          { triggerId: "old", report },
          { triggerId: "new", report },
        ],
      }),
    ).toMatchObject({ candidates: 0, duplicates: 0, finishedAt: "2026-10-04T01:00:00Z" })
  })
  it("不把未完成任务或无效报告补成零", () => {
    expect(
      latestDedupeReport({
        runs: [{ id: "running", finishedAt: null }],
        reports: [{ triggerId: "running", report: { dedupe: {} } }],
      }),
    ).toBeNull()
  })
})
