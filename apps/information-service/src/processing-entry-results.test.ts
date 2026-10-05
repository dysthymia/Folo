import { randomUUID } from "node:crypto"

import type { RuleSet } from "@follow/information-core"
import { afterEach, describe, expect, it } from "vitest"

import type { Source, SourceEntry } from "./folo"
import type { ProcessingEntryResultsResponse } from "./processing-api"
import { processingApi } from "./processing-api"
import type { ProcessingDecision } from "./processing-decision"
import { Store } from "./store"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const source: Source = {
  key: "feed/1",
  kind: "feed",
  id: "1",
  title: "订阅",
  view: 0,
  category: null,
}
const entry: SourceEntry = {
  id: "entry",
  sourceKey: source.key,
  title: "原文",
  content: "完整原文",
  description: null,
  url: null,
  read: false,
  publishedAt: "2026-09-01T00:00:00.000Z",
}
function fixture(action: "transform" | "dedupe" | "local" = "transform") {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source], "2026-09-01T00:00:00.000Z")
  const draft = store.automation.draft()
  const config: RuleSet = {
    ...draft.config,
    rules: [
      {
        id: "rule",
        name: "规则",
        ownerId: "owner",
        order: 0,
        enabled: true,
        version: 1,
        executionLocation: "processing_service",
        when: { all: true },
        actions:
          action === "transform"
            ? [{ type: "ai_transform", prompt: "摘要" }]
            : action === "dedupe"
              ? [{ type: "ai_dedupe", scope: { all: true } }]
              : [{ type: "local_filter", mode: "silence" }],
      },
    ],
  }
  store.automation.saveDraft(config, draft.revision)
  store.automation.publish(1, { mode: "future" }, randomUUID())
  return store
}
function complete(store: Store, row = entry) {
  store.saveEntry(row)
  const input = store.automation.assign(store.automation.current(row.sourceKey, row.id)!.seq)
  const decision: ProcessingDecision = {
    schemaVersion: 1,
    fingerprint: String(input.seq),
    provider: "codex",
    model: "test",
    generatedAt: entry.publishedAt,
    durationMs: 1,
    usage: null,
    status: "keep",
    title: "AI标题",
    summary: "AI摘要",
    reason: "摘要",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "source",
    context: {
      source_id: row.feedId ? `feed/${row.feedId}` : row.sourceKey,
      contextId: row.sourceKey,
    },
    facts: [],
    semantic: null,
    reused: false,
  }
  store.automation.complete(input, decision)
  return input
}
const results = (store: Store) =>
  processingApi(store, "GET", "/processing/entry-results", null) as ProcessingEntryResultsResponse

describe("时间线 AI 结果轻量索引", () => {
  it("只返回真实变换结果身份，完整内容懒加载并携带版本标识", () => {
    const store = fixture()
    const input = complete(store)
    const index = results(store).results[0]!
    expect(results(store).processed).toEqual([
      { itemId: entry.id, sourceKey: source.key, sourceId: source.key },
    ])
    expect(index).toEqual({
      itemId: entry.id,
      sourceKey: source.key,
      sourceId: source.key,
      inputSeq: input.seq,
      contentVersion: input.contentVersion,
      releaseVersion: input.releaseVersion,
      decisionId: expect.any(String),
    })
    expect(processingApi(store, "GET", `/processing/entries/${input.seq}`, null)).toMatchObject({
      entry: {
        seq: input.seq,
        contentVersion: index.contentVersion,
        decisionId: index.decisionId,
        decision: { summary: "AI摘要" },
      },
    })
  })

  it("新正文或重新处理代际不会继续索引旧决定，旧详情身份拒绝读取", () => {
    const store = fixture()
    const input = complete(store)
    store.saveEntry({ ...entry, content: "更新正文" })
    expect(results(store).results).toEqual([])
    expect(results(store).processed).toEqual([])
    expect(() => processingApi(store, "GET", `/processing/entries/${input.seq}`, null)).toThrow(
      "invalid_target",
    )
    const current = complete(store, { ...entry, content: "更新正文" })
    expect(results(store).results[0]?.inputSeq).toBe(current.seq)
    store.automation.invalidateSources([source.key])
    expect(results(store).results).toEqual([])
  })

  it("只按执行时配置判断真实AI变换，不把普通动作伪装成AI结果", () => {
    const store = fixture("local")
    complete(store)
    expect(results(store).results).toEqual([])
    expect(results(store).processed).toEqual([])
    const draft = store.automation.draft()
    draft.config.rules[0]!.actions = [{ type: "ai_transform", prompt: "后来增加" }]
    store.automation.saveDraft(draft.config, draft.revision)
    expect(results(store).results).toEqual([])
    expect(results(store).processed).toEqual([])
  })

  it("去重规则的已完成决定有处理标记，但没有可打开的摘要变换结果", () => {
    const store = fixture("dedupe")
    complete(store)
    expect(results(store)).toMatchObject({
      processed: [{ itemId: entry.id, sourceKey: source.key, sourceId: source.key }],
      results: [],
    })
  })

  it("来源撤销和材料撤回立即移出索引，同时阻止懒详情读取", () => {
    const store = fixture()
    const input = complete(store)
    store.stories.withdrawMaterial(input.seq, "撤回")
    expect(results(store).results).toEqual([])
    expect(results(store).processed).toEqual([])
    expect(() => processingApi(store, "GET", `/processing/entries/${input.seq}`, null)).toThrow(
      "invalid_target",
    )
    const other = complete(store, { ...entry, id: "other" })
    store.replaceSources([])
    expect(results(store).results).toEqual([])
    expect(() => processingApi(store, "GET", `/processing/entries/${other.seq}`, null)).toThrow(
      "invalid_target",
    )
  })

  it("同条目在不同来源或List上下文保留独立身份，不能按itemId折叠", () => {
    const store = fixture()
    store.replaceSources([source, { ...source, key: "list/2", id: "2", kind: "list" }])
    const direct = complete(store)
    const inList = complete(store, { ...entry, sourceKey: "list/2", feedId: "1" })
    expect(results(store).results).toMatchObject([
      { itemId: entry.id, sourceKey: "feed/1", sourceId: "feed/1", inputSeq: direct.seq },
      { itemId: entry.id, sourceKey: "list/2", sourceId: "feed/1", inputSeq: inList.seq },
    ])
  })

  it("尚未绑定账号时不能读取结果索引", () => {
    const store = new Store(":memory:")
    stores.push(store)
    expect(() => results(store)).toThrow("owner_required")
  })
})
