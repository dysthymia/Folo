import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { contentIdentity, expandXContexts, originalUrlIdentity, xPostId } from "./content-identity"
import { runEntryProcessing } from "./processing-engine"
import { Store } from "./store"

it.each([false, true])(
  "同一原帖跨查询上下文与水合小批复用，separateBatches=%s",
  async (separateBatches) => {
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
      // 身份复用测试显式启用 AI；空规则集现在不会隐式消费模型额度。
      store.automation.saveDraft(
        {
          ...store.automation.draft().config,
          rules: [
            {
              id: "summary",
              ownerId: "owner",
              name: "摘要",
              enabled: true,
              order: 0,
              version: 1,
              executionLocation: "processing_service",
              when: { all: true },
              actions: [{ type: "ai_transform", prompt: "提取原文事实并生成摘要" }],
            },
          ],
        },
        0,
      )
      store.automation.publish(1, { mode: "future" }, randomUUID())
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
      const results = []
      // 分别验证同一轮预准备的不同上下文，以及两轮水合小批之间的持久化复用。
      for (const inputSeqs of separateBatches ? inputs.map((input) => [input.seq]) : [undefined]) {
        results.push(
          await runEntryProcessing({
            store,
            aiConfig,
            runtimeDir: directory,
            sourceKeys: queries.map((query) => query.sourceKey),
            inputSeqs,
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
                event: null,
                facts: [{ text: "同一条可核查原文", evidenceId: "E000001", kind: "fact" }],
              }
              if (!options.validate(output)) throw new Error("invalid_fixture")
              return {
                result: output,
                model: options.model,
                durationMs: 1,
                usage: null,
                toolCalls: 0,
              }
            },
          }),
        )
      }
      expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(2)
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
  },
)

it("平台名出现在正文或不可信域名中不能伪造原帖身份", () => {
  expect(xPostId({ url: "https://evil.test/x.com/test/status/123" })).toBeNull()
  expect(xPostId({ url: "https://mobile.twitter.com/test/status/123?ref=x" })).toBe("123")
})

it("相同原文深链跨订阅保持身份，跟踪参数和片段不制造第二个原文", () => {
  const entry = {
    id: "one",
    sourceKey: "feed/a",
    title: "原文",
    publishedAt: "2026-10-03T00:00:00Z",
    read: false,
    content: "正文",
    description: null,
    url: "https://example.com/article?id=1&utm_source=rss#section",
  }
  expect(contentIdentity(entry)).toBe(
    contentIdentity({
      ...entry,
      id: "two",
      sourceKey: "list/b",
      url: "https://example.com/article?id=1&utm_medium=share",
    }),
  )
  expect(contentIdentity(entry)).not.toBe(
    contentIdentity({ ...entry, url: "https://example.com/article?id=2" }),
  )
  expect(contentIdentity(entry)).not.toBe(
    contentIdentity({ ...entry, url: "https://example.com/article?id=1&lang=zh" }),
  )
})

it("标题翻译或正文引用另一个原帖不能代替原文身份，首页和非法协议回退来源条目", () => {
  expect(originalUrlIdentity("https://example.com/?utm_source=rss")).toBeNull()
  expect(originalUrlIdentity("javascript:alert(1)")).toBeNull()
  expect(originalUrlIdentity("https://user:password@example.com/article")).toBeNull()
  const entry = {
    id: "one",
    sourceKey: "feed/a",
    title: "翻译标题",
    publishedAt: "2026-10-03T00:00:00Z",
    read: false,
    content: "引用 https://x.com/source/status/123",
    description: null,
    url: "https://example.com/translation",
  }
  expect(contentIdentity(entry)).toBe("url:https://example.com/translation")
  expect(contentIdentity({ ...entry, url: "https://example.com" })).toBe("feed/feed/a/one")
})
