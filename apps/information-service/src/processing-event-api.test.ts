import { randomUUID } from "node:crypto"

import type { RuleSet } from "@follow/information-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import * as codex from "./codex"
import { processingApi } from "./processing-api"
import type { ProcessingDecision } from "./processing-decision"
import type { EventIdentity } from "./processing-event"
import { Store } from "./store"
import type { StoryRevisionDraft } from "./story-store"
import { sourceSpanFragmentId } from "./story-store"

const stores: Store[] = []
const config: RuleSet = {
  formatVersion: 4,
  ownerId: "owner",
  global: { version: 1, markdown: "" },
  rules: [],
}
const text = "Acme released Widget version 2.0. https://official.test/widget/2"
function identity(): EventIdentity {
  const value = (value: string) => ({ value, quote: text })
  return {
    kind: "event",
    subject: value("Acme"),
    action: { value: "product_release", quote: text },
    object: value("Widget"),
    version: value("2.0"),
    round: null,
    anchor: {
      ...value("https://official.test/widget/2"),
      kind: "official_reference",
      timeZone: null,
    },
  }
}
function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources(
    [1, 2].map((index) => ({
      key: `feed/${index}`,
      kind: "feed" as const,
      id: `${index}`,
      title: `来源${index}`,
      view: 0,
      category: null,
    })),
  )
  store.automation.saveDraft(config, 0)
  store.automation.publish(1, { mode: "future" }, randomUUID())
  return store
}
function publish(store: Store, index: number, kind: EventIdentity["kind"] = "event") {
  const sourceKey = `feed/${index}`
  store.saveEntry({
    id: `e${index}`,
    sourceKey,
    title: kind === "event" ? "Widget 发布报道" : "Widget 深度分析",
    url: `https://source.test/${index}`,
    publishedAt: "2026-10-06T00:00:00Z",
    read: false,
    content: text,
    description: null,
  })
  const input = store.automation.assign(store.automation.current(sourceKey, `e${index}`)!.seq)
  const event = { ...identity(), kind }
  const decision: ProcessingDecision = {
    schemaVersion: 1,
    fingerprint: `fp${index}`,
    provider: "codex",
    model: "fake",
    generatedAt: "2026-10-06T01:00:00Z",
    durationMs: 0,
    usage: null,
    status: "keep",
    title: "发布",
    summary: "发布摘要",
    reason: "原文支持",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "reporting",
    context: { source_id: sourceKey, contextId: sourceKey, entry_content: text },
    facts: [],
    semantic: {
      entryId: input.itemId,
      title: "发布",
      summary: "发布摘要",
      disposition: "keep",
      reason: "依据原文",
      aggregation: true,
      rewrite: true,
      labels: [],
      facts: [],
      event,
    },
    reused: false,
  }
  store.semantics.publish(input, decision)
  return input
}
function entryEvents(store: Store, seq: number) {
  return processingApi(store, "GET", `/processing/entries/${seq}/events`, undefined) as {
    contentVersion: string
    decisionId: string
    events: Array<{
      event: { id: string; revision: number; title: string }
      mentionId: string
      role: string
      state: string
    }>
  }
}
// 用已发布的真实材料创建旧 Story，验证事件投影不会复制身份或重置用户状态。
function storyDraft(store: Store): StoryRevisionDraft {
  const members = store.processingState
    .published()
    .map(({ input, decisionId }) => ({ inputSeq: input.seq, decisionId }))
  const sourceSpans = store.processingState.published().map(({ input }) => ({
    id: `span-${input.seq}`,
    inputSeq: input.seq,
    sourceItemId: input.itemId,
    contentVersion: input.contentVersion,
    fragmentId: sourceSpanFragmentId(input.itemId, input.contentVersion, text),
    quote: text,
    sourceRole: "reporting",
  }))
  return {
    title: "已存在的发布综述",
    body: "两份来源描述 Widget 2.0 发布。",
    aggregationRuleId: "existing-rule",
    aggregationScopeVersion: "scope-v1",
    appliedRuleSetVersion: 1,
    instructionFingerprint: "old-instructions",
    eventIdentity: identity(),
    members,
    sourceSpans,
    citations: sourceSpans.map((span) => ({
      id: `citation-${span.inputSeq}`,
      sourceSpanId: span.id,
      sentenceId: "sentence-1",
    })),
    sentences: [
      {
        id: "sentence-1",
        text: "Widget 2.0 发布。",
        citationIds: sourceSpans.map((span) => `citation-${span.inputSeq}`),
      },
    ],
    facts: [
      {
        id: "fact-1",
        kind: "fact",
        text: "Widget 2.0 发布。",
        citationIds: sourceSpans.map((span) => `citation-${span.inputSeq}`),
        dependsOnFactIds: [],
      },
    ],
  }
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  vi.restoreAllMocks()
})

describe("事件登记与原生结果入口 API", () => {
  it("单篇事件读取只访问目标 seq，不同步全部 Story 或调用模型", () => {
    const store = fixture()
    const first = publish(store, 1)
    publish(store, 2)
    const inputs = vi.spyOn(store.automation, "inputs")
    const published = vi.spyOn(store.processingState, "published")
    const overrides = vi.spyOn(store.processingState, "overrides")
    const sync = vi.spyOn(store, "synchronizeEvents")
    const stories = vi.spyOn(store.stories, "synchronizeEventLinks")
    const model = vi.spyOn(codex, "runCodexJson").mockRejectedValue(new Error("unexpected_model"))
    expect(entryEvents(store, first.seq)).toMatchObject({
      contentVersion: first.contentVersion,
      decisionId: expect.any(String),
      events: [{ role: "reports", state: "confirmed" }],
    })
    // 任何无范围 inputs/published/overrides 调用都会重新解析全部材料，必须拒绝。
    for (const spy of [inputs, published, overrides]) {
      expect(spy.mock.calls.length).toBeGreaterThan(0)
      expect(
        spy.mock.calls.every(([seqs]) => JSON.stringify(seqs) === JSON.stringify([first.seq])),
      ).toBe(true)
    }
    expect(sync).toHaveBeenCalledExactlyOnceWith([first.seq])
    expect(stories).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
  })

  it("去重召回只使用当前确认归属，人工移出与新待处理版本不沿用旧 eventId", () => {
    const store = fixture()
    const input = publish(store, 1)
    const event = entryEvents(store, input.seq).events[0]!.event
    expect(store.eventRecall(input)).toMatchObject({
      eventIds: [event.id],
      identities: [identity()],
    })
    processingApi(store, "POST", `/processing/events/${event.id}/corrections`, {
      requestId: randomUUID(),
      expectedRevisions: { [event.id]: event.revision },
      action: { type: "exclude", inputSeq: input.seq, mentionId: "M1" },
    })
    expect(store.eventRecall(input).eventIds).toEqual([])
    store.saveEntry({ ...input.body, title: "新标题" })
    const current = store.automation.current(input.sourceKey, input.itemId)!
    expect(store.eventRecall(current)).toEqual({ eventIds: [], identities: [] })
    expect(store.eventRecall(input)).toEqual({ eventIds: [], identities: [] })
  })

  it("单篇可点开事件，跨来源报道及独立分析归属同事件，不生成综述或调用模型", () => {
    const store = fixture()
    const model = vi.spyOn(codex, "runCodexJson").mockRejectedValue(new Error("unexpected_model"))
    const first = publish(store, 1)
    const firstView = entryEvents(store, first.seq)
    expect(firstView).toMatchObject({
      contentVersion: first.contentVersion,
      decisionId: expect.any(String),
      events: [{ role: "reports", state: "confirmed" }],
    })
    const eventId = firstView.events[0]!.event.id
    expect(processingApi(store, "GET", `/processing/events/${eventId}`, undefined)).toMatchObject({
      stories: [],
      membershipCount: 1,
    })
    const second = publish(store, 2, "analysis")
    expect(entryEvents(store, second.seq).events[0]).toMatchObject({
      event: { id: eventId },
      role: "analysis_of",
    })
    expect(
      processingApi(store, "POST", `/processing/events/${eventId}/members`, { limit: 1 }),
    ).toMatchObject({
      total: 2,
      rows: [
        { title: expect.any(String), url: expect.any(String), contentVersion: expect.any(String) },
      ],
      nextOffset: 1,
    })
    expect(store.stories.list()).toEqual([])
    expect(store.entry("feed/1", "e1")?.read).toBe(false)
    expect(model).not.toHaveBeenCalled()
  })
  it("复用已有 Story ID，改名保留读态收藏，移出后阻止旧成员再次并回", () => {
    const store = fixture()
    const first = publish(store, 1)
    publish(store, 2)
    const initial = entryEvents(store, first.seq).events[0]!
    const eventId = initial.event.id
    const draft = storyDraft(store)
    const story = store.stories.create(draft)
    store.stories.markRead(story.storyId, "owner")
    store.stories.setCollected(story.storyId, "owner", true)
    expect(processingApi(store, "GET", `/processing/events/${eventId}`, undefined)).toMatchObject({
      stories: [{ id: story.storyId, revision: 1 }],
    })
    const renamed = processingApi(store, "POST", `/processing/events/${eventId}/corrections`, {
      requestId: randomUUID(),
      expectedRevisions: { [eventId]: initial.event.revision },
      action: { type: "rename", title: "用户命名" },
    }) as { event: { revision: number } }
    expect(store.stories.currentSnapshot(story.storyId)).toMatchObject({
      revision: 1,
      title: draft.title,
      body: draft.body,
    })
    expect(store.stories.readStatus(story.storyId, "owner").unread).toBe(false)
    expect(store.stories.isCollected(story.storyId, "owner")).toBe(true)
    processingApi(store, "POST", `/processing/events/${eventId}/corrections`, {
      requestId: randomUUID(),
      expectedRevisions: { [eventId]: renamed.event.revision },
      action: { type: "exclude", inputSeq: first.seq, mentionId: initial.mentionId },
    })
    expect(store.stories.resolveLink(story.storyId)).toMatchObject({ kind: "repairing" })
    expect(store.stories.eventIdentityForMembers(draft.members)).toBeNull()
    expect(() => store.stories.repair(story.storyId, 1, draft)).toThrow("invalid_reference")
    expect(processingApi(store, "GET", `/processing/events/${eventId}`, undefined)).toMatchObject({
      stories: [],
    })
    expect(store.stories.list()).toHaveLength(1)
    expect(store.stories.readStatus(story.storyId, "owner").unread).toBe(false)
    expect(store.stories.isCollected(story.storyId, "owner")).toBe(true)
    expect(store.entry(first.sourceKey, first.itemId)?.read).toBe(false)
  })
  it("改名和人工移出核验修订号，撤销恢复成员但不修改正文或已读", () => {
    const store = fixture()
    const input = publish(store, 1)
    const initial = entryEvents(store, input.seq).events[0]!
    const id = initial.event.id
    const renamed = processingApi(store, "POST", `/processing/events/${id}/corrections`, {
      requestId: randomUUID(),
      expectedRevisions: { [id]: initial.event.revision },
      action: { type: "rename", title: "我的发布事件" },
    }) as { event: { revision: number } }
    expect(entryEvents(store, input.seq).events[0]!.event.title).toBe("我的发布事件")
    expect(() =>
      processingApi(store, "POST", `/processing/events/${id}/corrections`, {
        requestId: randomUUID(),
        expectedRevisions: { [id]: initial.event.revision },
        action: { type: "rename", title: "陈旧请求" },
      }),
    ).toThrow("revision_conflict")
    const removeRequest = {
      requestId: randomUUID(),
      expectedRevisions: { [id]: renamed.event.revision },
      action: { type: "exclude", inputSeq: input.seq, mentionId: initial.mentionId },
    }
    const invalidate = vi.spyOn(store.stories, "invalidateInputs")
    const removed = processingApi(
      store,
      "POST",
      `/processing/events/${id}/corrections`,
      removeRequest,
    ) as { correctionId: string; event: { revision: number } }
    expect(
      processingApi(store, "POST", `/processing/events/${id}/corrections`, removeRequest),
    ).toEqual(removed)
    expect(invalidate).toHaveBeenCalledOnce()
    expect(processingApi(store, "POST", `/processing/events/${id}/members`, {})).toMatchObject({
      total: 0,
    })
    processingApi(store, "POST", `/processing/events/${id}/corrections`, {
      requestId: randomUUID(),
      expectedRevisions: { [id]: removed.event.revision },
      action: { type: "undo", correctionId: removed.correctionId },
    })
    expect(processingApi(store, "POST", `/processing/events/${id}/members`, {})).toMatchObject({
      total: 1,
    })
    expect(store.entry("feed/1", "e1")).toMatchObject({ content: text, read: false })
  })
  it("移除来源和撤回材料在计数与分页前失效旧快照", () => {
    const store = fixture()
    const first = publish(store, 1)
    const second = publish(store, 2)
    const id = entryEvents(store, first.seq).events[0]!.event.id
    const page = processingApi(store, "POST", `/processing/events/${id}/members`, { limit: 1 }) as {
      snapshotId: string
    }
    store.stories.withdrawMaterial(second.seq, "用户撤回")
    expect(() =>
      processingApi(store, "POST", `/processing/events/${id}/members`, {
        limit: 1,
        snapshotId: page.snapshotId,
        offset: 1,
      }),
    ).toThrow("revision_conflict")
    expect(processingApi(store, "POST", `/processing/events/${id}/members`, {})).toMatchObject({
      total: 1,
    })
    expect(() => entryEvents(store, second.seq)).toThrow("invalid_target")
  })
})
