import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { contentIdentity, expandXContexts, xPostId } from "./content-identity"
import { runEntryProcessing } from "./processing-engine"
import { Store } from "./store"

it("同一原帖保留两个查询上下文，等效指令只调用一次模型且首页只展示一份", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-context-"))
  const store = new Store(":memory:")
  store.bindOwner("owner")
  try {
    const queries = [0, 1].map((view) =>
      store.xQueries.create({
        query: `test-${view}`,
        title: `查询 ${view}`,
        view,
        category: `分类 ${view}`,
        enabled: true,
      }),
    )
    store.automation.publish(0, { mode: "future" }, randomUUID())
    store.saveEntry({
      id: "original",
      sourceKey: "feed/f1",
      feedId: "f1",
      feedKind: "feed",
      title: "原帖",
      url: "https://twitter.com/test/status/123",
      publishedAt: "2026-09-01T00:00:00.000Z",
      read: false,
      content: "同一条可核查原文",
      description: null,
    })
    for (const query of queries)
      store.xQueries.bindPost("123", query.id, new Date().toISOString(), "feed/f1")
    expandXContexts(store)
    const inputs = store.automation
      .inputs()
      .filter((input) => input.sourceKey.startsWith("x/search/"))
    expect(inputs).toHaveLength(2)
    expect(new Set(inputs.map((input) => contentIdentity(input.body))).size).toBe(1)
    for (const input of inputs) store.processingState.setMaterial(input, "complete")
    const aiConfig = new AIConfigStore(join(directory, "ai.json"))
    await aiConfig.save({ provider: "codex", model: "test-model" })
    let calls = 0
    const result = await runEntryProcessing({
      store,
      aiConfig,
      runtimeDir: directory,
      sourceKeys: queries.map((query) => query.sourceKey),
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: async <T>(options: CodexJsonOptions<T>) => {
        calls++
        const output: unknown = {
          entryId: "x:123",
          title: "摘要标题",
          summary: "同一原帖摘要",
          disposition: "keep",
          reason: "事实",
          aggregation: true,
          rewrite: true,
          labels: [],
          facts: [{ text: "同一条可核查原文", evidenceId: "E000001", kind: "fact" }],
        }
        if (!options.validate(output)) throw new Error("invalid_fixture")
        return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
      },
    })
    expect(result.completed).toBe(2)
    expect(calls).toBe(1)
    const published = store.processingState.published()
    expect(new Set(published.map((item) => item.decision.context.view))).toEqual(new Set([0, 1]))
    expect(published.filter((item) => item.decision.reused)).toHaveLength(1)
    const snapshot = store.reading.refresh()
    expect(store.reading.page({ snapshotId: snapshot.id, view: "standalone" }).total).toBe(1)
    expect(store.reading.page({ snapshotId: snapshot.id, view: "all" }).total).toBe(3)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it("平台名出现在正文或不可信域名中不能伪造原帖身份", () => {
  expect(xPostId({ url: "https://evil.test/x.com/test/status/123" })).toBeNull()
  expect(xPostId({ url: "https://mobile.twitter.com/test/status/123?ref=x" })).toBe("123")
})
