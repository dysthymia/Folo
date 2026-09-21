import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { SourceEntry } from "./folo"
import { processingApi } from "./processing-api"
import type { ProcessingDecision } from "./processing-decision"
import { Store } from "./store"
import type { Story, StoryRevision } from "./story-store"

const stores: Store[] = []
const source = {
  key: "feed/f1",
  kind: "feed" as const,
  id: "f1",
  title: "来源",
  view: 0,
  category: null,
}
const entry: SourceEntry = {
  id: "e1",
  sourceKey: source.key,
  title: "原帖",
  url: "https://example.test/e1",
  publishedAt: "2026-01-01T00:00:00.000Z",
  read: false,
  content: "正文",
  description: null,
}

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source])
  return store
}

function schedule(store: Store) {
  return processingApi(store, "PUT", "/schedule", {
    expectedRevision: 0,
    config: {
      sourceKeys: [source.key],
      historySince: "2026-01-01T00:00:00Z",
      timeZone: "Asia/Shanghai",
      enabled: true,
    },
  })
}

afterEach(() => stores.splice(0).forEach((store) => store.close()))

describe("处理服务 API", () => {
  it("只用当前 decision 的引用反馈标记待核对，旧 decision 不污染新结果", () => {
    const store = fixture()
    store.automation.publish(0, { mode: "future" }, randomUUID())
    store.saveEntry(entry)
    const firstInput = store.automation.assign(store.automation.inputs()[0]!.seq)
    const decision = {
      schemaVersion: 1,
      fingerprint: "first",
      provider: "codex",
      model: "test-model",
      generatedAt: entry.publishedAt,
      durationMs: 1,
      usage: null,
      status: "keep",
      title: "AI 标题",
      summary: "AI 摘要",
      reason: "原因",
      labels: [],
      policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
      sourceRole: "reporting",
      context: { source_id: source.key, contextId: source.key },
      facts: [],
      semantic: null,
      reused: false,
    } satisfies ProcessingDecision
    store.automation.complete(firstInput, decision)
    const firstPublished = store.processingState.published()[0]!
    store.feedback.record({
      kind: "unsupported_citation",
      target: {
        kind: "entry",
        inputSeq: firstInput.seq,
        sourceKey: firstInput.sourceKey,
        itemId: firstInput.itemId,
        contentVersion: firstInput.contentVersion,
        decisionId: firstPublished.decisionId,
        releaseVersion: firstInput.releaseVersion,
      },
      explanation: null,
      referenceIds: [],
      suggestion: null,
    })
    expect(processingApi(store, "GET", "/processing/entries", {})).toMatchObject({
      entries: [{ reviewNeeded: true, issueCount: 1 }],
    })

    store.saveEntry({ ...entry, content: "更新后的正文" })
    const secondInput = store.automation.assign(store.automation.inputs()[0]!.seq)
    store.automation.complete(secondInput, { ...decision, fingerprint: "second" })
    expect(processingApi(store, "GET", "/processing/entries", {})).toMatchObject({
      entries: [{ reviewNeeded: false, issueCount: 0 }],
    })
  })

  it("规则解释使用条目实际发布版本，拒绝旧正文版本和范围外材料", () => {
    const store = fixture()
    const config = store.automation.draft().config
    config.global.markdown = "原发布指令"
    config.rules = [
      {
        id: "rule-1",
        ownerId: "owner",
        name: "原规则",
        order: 0,
        version: 1,
        enabled: true,
        executionLocation: "processing_service",
        when: { all: true },
        actions: [{ type: "presentation", policy: { standalone: "always" } }],
      },
    ]
    store.automation.saveDraft(config, 0)
    store.automation.publish(1, { mode: "future" }, randomUUID())
    store.saveEntry(entry)
    const input = store.automation.assign(store.automation.inputs()[0]!.seq)
    store.automation.complete(input, {
      schemaVersion: 1,
      fingerprint: "explanation",
      provider: "codex",
      model: "test",
      generatedAt: entry.publishedAt,
      durationMs: 1,
      usage: null,
      status: "keep",
      title: "标题",
      summary: "摘要",
      reason: "原因",
      labels: [],
      policy: { standalone: "always", aggregation: "allow", rewrite: "allow" },
      sourceRole: "reporting",
      context: { source_id: "f1", contextId: source.key },
      facts: [],
      semantic: null,
      reused: false,
    } satisfies ProcessingDecision)
    // 新草稿及未来发布均不能改写旧决定的规则解释。
    const next = store.automation.draft()
    next.config.global.markdown = "新发布指令"
    next.config.rules[0]!.name = "新规则"
    store.automation.saveDraft(next.config, next.revision)
    store.automation.publish(next.revision + 1, { mode: "future" }, randomUUID())
    const path = `/processing/entries/${input.seq}/explanation`
    expect(processingApi(store, "GET", path, {})).toMatchObject({
      sourceId: "f1",
      releaseVersion: 1,
      globalInstructions: "原发布指令",
      pending: false,
      rules: [{ id: "rule-1", name: "原规则", state: "match" }],
    })
    store.saveEntry({ ...entry, content: "更新后的正文" })
    expect(() => processingApi(store, "GET", path, {})).toThrow("invalid_target")
    const current = store.automation.current(source.key, entry.id)!
    store.replaceSources([])
    expect(() =>
      processingApi(store, "GET", `/processing/entries/${current.seq}/explanation`, {}),
    ).toThrow("invalid_target")
  })

  it("读写计划检查来源范围与 revision", () => {
    const store = fixture()
    expect(schedule(store)).toMatchObject({ revision: 1 })
    expect(processingApi(store, "GET", "/schedule", {})).toMatchObject({ revision: 1 })
    expect(() =>
      processingApi(store, "PUT", "/schedule", {
        expectedRevision: 1,
        config: {
          sourceKeys: ["feed/missing"],
          historySince: "2026-01-01T00:00:00Z",
          timeZone: "Asia/Shanghai",
          enabled: true,
        },
      }),
    ).toThrow("invalid_target")
  })

  it("手动运行要求已发布规则，运行与报告不截断", () => {
    const store = fixture()
    schedule(store)
    expect(() => processingApi(store, "POST", "/runs", { requestId: randomUUID() })).toThrow(
      "invalid_target",
    )
    store.automation.publish(0, { mode: "future" }, randomUUID())
    const run = processingApi(store, "POST", "/runs", { requestId: randomUUID() })!
    store.processingState.report(String(Reflect.get(run, "id")), { sources: 1 })
    expect(processingApi(store, "GET", "/runs", {})).toMatchObject({
      runs: [expect.any(Object)],
      reports: [expect.any(Object)],
    })
  })

  it("条目全量返回，纠偏使用 CAS、失效 Story，并且失败项才能重试", () => {
    const store = fixture()
    store.saveEntry(entry)
    const seq = store.automation.inputs()[0]!.seq
    store.automation.publish(0, { mode: "future" }, randomUUID())
    const entries = processingApi(store, "GET", "/processing/entries", {})!
    expect(entries).toMatchObject({
      entries: [
        expect.objectContaining({
          seq,
          decision: null,
          override: { inputSeq: seq, mode: "automatic", revision: 0 },
        }),
      ],
    })
    expect(JSON.stringify(entries)).not.toContain(entry.content)
    expect(processingApi(store, "GET", `/processing/entries/${seq}`, {})).toMatchObject({
      entry: { seq, input: entry, decision: null },
    })
    expect(
      processingApi(store, "POST", `/processing/entries/${seq}/override`, {
        mode: "hide",
        expectedRevision: 0,
      }),
    ).toEqual({ inputSeq: seq, mode: "hide", revision: 1 })
    expect(() => processingApi(store, "POST", `/processing/entries/${seq}/retry`, {})).toThrow(
      "invalid_target",
    )
    const target = store.automation.assign(seq)
    store.processingState.fail(target, "model_failed")
    expect(processingApi(store, "POST", `/processing/entries/${seq}/retry`, {})).toEqual({
      inputSeq: seq,
      status: "pending",
    })
    expect(
      processingApi(store, "POST", `/processing/entries/${seq}/undo`, { expectedRevision: 1 }),
    ).toEqual({ inputSeq: seq, mode: "automatic", revision: 2 })
  })

  it("Story、材料和纠正端点执行严格请求校验，不创建模型结果", () => {
    const store = fixture()
    expect(processingApi(store, "GET", "/stories", {})).toEqual({ stories: [] })
    expect(processingApi(store, "GET", "/stories/missing", {})).toEqual({ kind: "missing" })
    expect(() => processingApi(store, "POST", "/materials/0/withdraw", { reason: "x" })).toThrow()
    expect(() =>
      processingApi(store, "POST", "/corrections/missing/undo", { extra: true }),
    ).toThrow()
  })

  it("Story 列表提供可读标题和阅读状态，但不包含快照正文", () => {
    const store = fixture()
    const story: Story = {
      id: randomUUID(),
      aggregationRuleId: "rule",
      aggregationScopeVersion: "scope",
      status: "active",
      currentRevision: 1,
      currentSubstantiveRevision: 1,
      mergedInto: null,
      splitInto: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const snapshot: StoryRevision = {
      ...story,
      storyId: story.id,
      title: "当前 Story 标题",
      body: "不应出现在列表的完整正文",
      revision: 1,
      substantiveRevision: 1,
      substantiveContentFingerprint: "substantive",
      displayFingerprint: "display",
      appliedRuleSetVersion: 1,
      instructionFingerprint: "instruction",
      members: [],
      sourceSpans: [],
      citations: [],
      sentences: [],
      facts: [],
    }
    vi.spyOn(store.stories, "list").mockReturnValue([story])
    vi.spyOn(store.stories, "resolveLink").mockReturnValue({
      kind: "current",
      story,
      revision: snapshot,
    })
    vi.spyOn(store.stories, "readStatus").mockReturnValue({
      readSubstantiveRevision: 1,
      unread: false,
    })

    expect(processingApi(store, "GET", "/stories", {})).toEqual({
      stories: [
        {
          story,
          title: "当前 Story 标题",
          readStatus: { readSubstantiveRevision: 1, unread: false },
        },
      ],
    })
  })
})
