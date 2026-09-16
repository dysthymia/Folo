import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { expect, it } from "vitest"

import { processingDiagnostics } from "./processing-diagnostics"
import { Store } from "./store"

it("按真实时刻计算历史范围，同一原帖的多个查询不扩大唯一内容分母", async () => {
  const dir = await mkdtemp(join(tmpdir(), "folo-diagnostics-scope-"))
  const store = new Store(":memory:")
  store.bindOwner("test")
  try {
    store.schedule.save(
      {
        sourceKeys: ["feed/a", "x/search/b"],
        historySince: "2026-09-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: false,
      },
      0,
    )
    for (const [id, sourceKey, publishedAt, url] of [
      ["original", "feed/a", "2026-09-01T07:00:00+08:00", "https://x.com/a/status/123"],
      ["x:123", "x/search/b", "2026-09-01T07:00:00+08:00", "https://twitter.com/a/status/123"],
      ["new", "feed/a", "2026-08-31T20:00:00-05:00", "https://example.com/new"],
    ] as const) {
      store.saveEntry({
        id,
        sourceKey,
        publishedAt,
        url,
        title: id,
        content: "正文",
        description: null,
        read: false,
      })
    }
    const result = await processingDiagnostics(store, join(dir, "missing.jsonl"))
    expect(result.scope).toMatchObject({
      currentInputContexts: 3,
      configuredInputContexts: 1,
      uniqueCurrentItems: 2,
    })
    expect(result.backlog.contexts).toBe(3)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it("区分未知用量、失败调用和真实计数，不推测尚未测量的容量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "folo-diagnostics-"))
  const store = new Store(":memory:")
  store.bindOwner("test")
  try {
    const path = join(dir, "usage.jsonl")
    const missing = await processingDiagnostics(store, path)
    expect(missing.modelCalls.ledgerAvailable).toBe(false)
    expect(missing.modelCalls.completeUsage).toBe(false)
    const base = {
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:00:01.000Z",
      model: "test",
      provider: "qianwen",
      purpose: "story",
    }
    await writeFile(
      path,
      `${[
        {
          ...base,
          status: "succeeded",
          usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
        },
        { ...base, status: "INVALID_OUTPUT", usage: null },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n")}\ninvalid`,
    )
    const result = await processingDiagnostics(store, path)
    expect(result.modelCalls).toMatchObject({
      calls: 2,
      failedCalls: 1,
      unknownUsageCalls: 1,
      invalidRows: 1,
      completeUsage: false,
      knownUsage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
      durationMs: { story: { count: 2, p50: 1000, p95: 1000 } },
    })
    expect(result.capacityPerDay).toBeNull()
    expect(result.backlogRecoverySeconds).toBeNull()
    expect(result.semanticAcceptance).toBe("awaiting_user_confirmed_samples")
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
