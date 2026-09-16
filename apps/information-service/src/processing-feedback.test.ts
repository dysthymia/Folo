import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import type { SourceEntry } from "./folo"
import { ProcessingFeedbackStore } from "./processing-feedback"
import { processingFeedbackApi } from "./processing-feedback-api"
import { Store } from "./store"
import type { StoryRevisionDraft } from "./story-store"
import { sourceSpanFragmentId } from "./story-store"

const stores: Store[] = []
const databases: DatabaseSync[] = []

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([
    { key: "feed/f1", kind: "feed", id: "f1", title: "来源", view: 0, category: null },
  ])
  return store
}

function input(): SourceEntry {
  return {
    id: "entry-1",
    sourceKey: "feed/f1",
    title: "原帖",
    url: "https://example.test/entry-1",
    publishedAt: "2026-01-01T00:00:00.000Z",
    read: false,
    content: "可核验的正文片段。",
    description: null,
  }
}

function decision(entry: SourceEntry) {
  return {
    schemaVersion: 1,
    fingerprint: "decision-fingerprint",
    provider: "codex" as const,
    model: "test-model",
    generatedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    usage: null,
    status: "keep" as const,
    title: entry.title,
    summary: "测试摘要",
    reason: "测试理由",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "reporting",
    context: { source_id: "f1", contextId: entry.sourceKey },
    facts: [],
    semantic: null,
    reused: false,
  }
}

function publish(store: Store) {
  store.automation.publish(0, { mode: "future" }, randomUUID())
  const entry = input()
  store.saveEntry(entry)
  const processingInput = store.automation.assign(store.automation.inputs()[0]!.seq)
  store.automation.complete(processingInput, decision(entry))
  return store.processingState.published()[0]!
}

function storyDraft(
  inputSeq: number,
  decisionId: string,
  contentVersion: string,
): StoryRevisionDraft {
  const quote = "可核验的正文片段。"
  return {
    title: "事件综述",
    body: "综述正文",
    aggregationRuleId: "aggregation-rule",
    aggregationScopeVersion: "scope-v1",
    appliedRuleSetVersion: 1,
    instructionFingerprint: "instruction-v1",
    members: [{ inputSeq, decisionId }],
    sourceSpans: [
      {
        id: "span-1",
        inputSeq,
        sourceItemId: "entry-1",
        contentVersion,
        fragmentId: sourceSpanFragmentId("entry-1", contentVersion, quote),
        quote,
        sourceRole: "reporting",
      },
    ],
    citations: [{ id: "citation-1", sourceSpanId: "span-1", sentenceId: "sentence-1" }],
    sentences: [{ id: "sentence-1", text: "有原文支持。", citationIds: ["citation-1"] }],
    facts: [],
  }
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  databases.splice(0).forEach((database) => database.close())
})

describe("处理反馈", () => {
  it("记录当前条目的实际决策和发布版本，只生成待审建议而不修改规则或结果", () => {
    const store = fixture()
    const published = publish(store)
    const draftBefore = store.automation.draft()
    const inputBefore = store.automation.inputs()[0]!

    const response = processingFeedbackApi(store, "POST", "/feedback", {
      kind: "should_keep",
      target: {
        kind: "entry",
        inputSeq: inputBefore.seq,
        expectedDecisionId: published.decisionId,
      },
      explanation: "这条公告不应隐藏。",
      suggestion: "重要公告应保留。",
    })

    expect(response).toMatchObject({
      feedback: {
        kind: "should_keep",
        target: {
          kind: "entry",
          inputSeq: inputBefore.seq,
          decisionId: published.decisionId,
          releaseVersion: published.input.releaseVersion,
        },
        suggestion: {
          status: "proposed",
          userText: "重要公告应保留。",
          prompt: expect.stringContaining("重要公告应保留。"),
        },
      },
    })
    expect(() =>
      processingFeedbackApi(store, "POST", "/feedback", {
        kind: "should_keep",
        target: { kind: "entry", inputSeq: inputBefore.seq, expectedDecisionId: "old-decision" },
      }),
    ).toThrow("stale_target")
    expect(store.automation.draft()).toEqual(draftBefore)
    expect(store.processingState.published()).toEqual([published])
    expect(processingFeedbackApi(store, "GET", "/feedback", {})).toMatchObject({
      feedback: [expect.objectContaining({ kind: "should_keep" })],
    })
  })

  it("Story 只接受当前 revision，引用必须属于该 revision", () => {
    const store = fixture()
    const published = publish(store)
    const secondEntry = {
      ...input(),
      id: "entry-2",
      title: "第二原帖",
      content: "第二段可核验正文。",
    }
    store.saveEntry(secondEntry)
    const secondInput = store.automation.assign(store.automation.inputs().at(-1)!.seq)
    store.automation.complete(secondInput, decision(secondEntry))
    const secondPublished = store.processingState
      .published()
      .find((item) => item.input.seq === secondInput.seq)!
    const draft = storyDraft(
      published.input.seq,
      published.decisionId,
      published.input.contentVersion,
    )
    const secondQuote = "第二段可核验正文。"
    draft.members.push({ inputSeq: secondInput.seq, decisionId: secondPublished.decisionId })
    draft.sourceSpans.push({
      id: "span-2",
      inputSeq: secondInput.seq,
      sourceItemId: "entry-2",
      contentVersion: secondInput.contentVersion,
      fragmentId: sourceSpanFragmentId("entry-2", secondInput.contentVersion, secondQuote),
      quote: secondQuote,
      sourceRole: "reporting",
    })
    draft.citations.push({ id: "citation-2", sourceSpanId: "span-2", sentenceId: "sentence-2" })
    draft.sentences.push({ id: "sentence-2", text: "第二条有支持。", citationIds: ["citation-2"] })
    const revision = store.stories.create(draft)

    expect(
      processingFeedbackApi(store, "POST", "/feedback", {
        kind: "unsupported_citation",
        target: { kind: "story", storyId: revision.storyId, storyRevision: revision.revision },
        referenceIds: ["citation-1"],
        explanation: "该引用不能支持结论。",
      }),
    ).toMatchObject({
      feedback: {
        target: {
          kind: "story",
          storyId: revision.storyId,
          storyRevision: revision.revision,
          decisionIds: expect.arrayContaining([published.decisionId]),
        },
        referenceIds: ["citation-1"],
      },
    })
    expect(() =>
      processingFeedbackApi(store, "POST", "/feedback", {
        kind: "missing_point",
        target: { kind: "story", storyId: revision.storyId, storyRevision: revision.revision + 1 },
      }),
    ).toThrow("stale_target")
    expect(() =>
      processingFeedbackApi(store, "POST", "/feedback", {
        kind: "unsupported_citation",
        target: { kind: "story", storyId: revision.storyId, storyRevision: revision.revision },
        referenceIds: ["citation-missing"],
      }),
    ).toThrow("invalid_reference")
  })

  it("反馈按 owner 隔离", () => {
    const database = new DatabaseSync(":memory:")
    databases.push(database)
    let owner = "owner-a"
    const feedback = new ProcessingFeedbackStore(database, () => owner)
    feedback.record({
      kind: "value",
      target: {
        kind: "entry",
        inputSeq: 1,
        sourceKey: "feed/f1",
        itemId: "entry-1",
        contentVersion: "v1",
        decisionId: null,
        releaseVersion: null,
      },
      explanation: null,
      referenceIds: [],
      suggestion: null,
    })
    owner = "owner-b"
    expect(feedback.list()).toEqual([])
  })
})
