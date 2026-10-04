import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { ProcessingRun } from "./processing-client"
import { parseProcessingRunReport, ProcessingRunReport } from "./processing-run-report"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))
const run: ProcessingRun = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "manual",
  dedupeKey: "manual:test",
  configRevision: 1,
  sourceKeys: ["feed/1"],
  historySince: "2026-01-01T00:00:00.000Z",
  timeZone: "UTC",
  scheduledFor: null,
  cutoffAt: "2026-01-02T00:00:00.000Z",
  status: "running",
  leaseToken: "lease",
  leaseUntil: "2026-01-02T00:30:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
  startedAt: "2026-01-02T00:00:02.000Z",
  finishedAt: null,
  error: null,
}

describe("处理报告的指标边界", () => {
  let root: Root, container: HTMLDivElement
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const value = (key: string) =>
    [...container.querySelectorAll("dt")].find(
      (item) => item.textContent === `processing.report.${key}`,
    )?.nextElementSibling?.textContent
  it("显示实际发布、调用、缓存与单篇用量，区分排队和耗时，不推断金额", async () => {
    await act(async () =>
      root.render(
        <ProcessingRunReport
          run={run}
          report={{
            phase: "entries",
            progressAt: "2026-01-02T00:00:10.000Z",
            entries: {
              completed: 8,
              pending: 2,
              metrics: {
                elapsedMs: 4500,
                publishedBatches: 2,
                modelCalls: 3,
                cacheHits: 1,
                readSkipped: 4,
                materialMissing: 2,
                modelFailures: 0,
              },
              usage: { inputTokens: 1200, outputTokens: 100, cachedInputTokens: 500 },
            },
          }}
        />,
      ),
    )
    expect(value("published_batches")).toBe("2")
    expect(value("model_calls")).toBe("3")
    expect(value("cache_hits")).toBe("1")
    expect(value("queue_wait")).toBe("2 s")
    expect(value("run_elapsed")).toBe("8 s")
    expect(value("entry_elapsed")).toBe("4.5 s")
    expect(value("input_tokens")).toBe("1,200")
    expect(value("cost")).toBe("processing.report.not_collected")
  })
  it("兼容旧报告与JSON；缺失、负数、NaN、损坏JSON不会冒充零或完成", async () => {
    expect(parseProcessingRunReport('{"entries":{"completed":3}}')?.entries?.completed).toBe(3)
    expect(parseProcessingRunReport("invalid")).toBeNull()
    expect(parseProcessingRunReport({ entries: { metrics: { modelCalls: -1 } } })).toBeNull()
    expect(parseProcessingRunReport({ entries: { metrics: { elapsedMs: Number.NaN } } })).toBeNull()
    await act(async () =>
      root.render(<ProcessingRunReport run={run} report={{ entries: { completed: 3 } }} />),
    )
    expect(value("completed")).toBe("3")
    expect(value("model_calls")).toBe("processing.report.not_collected")
    expect(value("cost")).toBe("processing.report.not_collected")
  })
})
