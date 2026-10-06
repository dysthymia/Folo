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
  it("保留共享、缓存、独立和未知用量，不把共享总量加到独立去重", () => {
    const result = latestDedupeReport({
      runs: [{ id: "new", finishedAt: "2026-10-05T00:00:00Z" }],
      reports: [
        {
          triggerId: "new",
          report: {
            dedupe: {
              candidates: 3,
              batches: 1,
              duplicates: 1,
              pending: 0,
              unresolved: 1,
              sharedComparisons: 1,
              relationCacheHits: 1,
              dedicatedComparisons: 1,
              unknownUsageRequests: 1,
              usage: { inputTokens: 100, outputTokens: 12, cachedInputTokens: 0 },
              sharedAnalysis: {
                requests: 2,
                pairs: 1,
                unknownUsageRequests: 1,
                usage: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 30 },
              },
            },
          },
        },
      ],
    })!
    expect(result.usage.inputTokens).toBe(100)
    expect(result.sharedAnalysis?.usage.inputTokens).toBe(200)
    expect(result).toMatchObject({ relationCacheHits: 1, unresolved: 1, unknownUsageRequests: 1 })
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
