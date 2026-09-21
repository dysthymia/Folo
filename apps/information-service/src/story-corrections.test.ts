import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { processingApi } from "./processing-api"
import type { Store } from "./store"
import { StoryCorrectionService } from "./story-corrections"
import type { StoryRevisionDraft } from "./story-store"
import { sourceSpanFragmentId, StoryStore } from "./story-store"

const databases: DatabaseSync[] = []

function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  db.exec(`
    CREATE TABLE processing_inputs (
      seq INTEGER PRIMARY KEY, source_key TEXT NOT NULL, item_id TEXT NOT NULL, content_version TEXT NOT NULL,
      body TEXT NOT NULL, received_at TEXT NOT NULL, release_version INTEGER, generation INTEGER NOT NULL,
      status TEXT NOT NULL, current INTEGER NOT NULL, decision_id TEXT
    );
    CREATE TABLE entry_decisions (
      id TEXT PRIMARY KEY, input_seq INTEGER NOT NULL, generation INTEGER NOT NULL,
      release_version INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `)
  for (let seq = 1; seq <= 4; seq++) {
    db.prepare("INSERT INTO processing_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      seq,
      `feed/${seq}`,
      `entry-${seq}`,
      `v${seq}`,
      JSON.stringify({ content: `证据 ${seq}` }),
      "2026-01-01T00:00:00.000Z",
      1,
      1,
      "succeeded",
      1,
      `decision-${seq}`,
    )
    db.prepare("INSERT INTO entry_decisions VALUES(?,?,?,?,?,?)").run(
      `decision-${seq}`,
      seq,
      1,
      1,
      JSON.stringify({ status: "keep" }),
      "2026-01-01T00:00:00.000Z",
    )
  }
  const stories = new StoryStore(db)
  return { stories, corrections: new StoryCorrectionService(stories) }
}

function draft(inputSeqs: number[], title = "原 Story"): StoryRevisionDraft {
  const spans = inputSeqs.map((inputSeq) => ({
    id: `span-${inputSeq}`,
    inputSeq,
    sourceItemId: `entry-${inputSeq}`,
    contentVersion: `v${inputSeq}`,
    fragmentId: sourceSpanFragmentId(`entry-${inputSeq}`, `v${inputSeq}`, `证据 ${inputSeq}`),
    quote: `证据 ${inputSeq}`,
    sourceRole: "reporting",
  }))
  return {
    title,
    body: inputSeqs.map((inputSeq) => `原句 ${inputSeq}`).join("\n"),
    aggregationRuleId: "rule",
    aggregationScopeVersion: "scope",
    appliedRuleSetVersion: 1,
    instructionFingerprint: "test-instruction",
    members: inputSeqs.map((inputSeq) => ({ inputSeq, decisionId: `decision-${inputSeq}` })),
    sourceSpans: spans,
    citations: spans.map((span) => ({
      id: `citation-${span.inputSeq}`,
      sourceSpanId: span.id,
      sentenceId: `sentence-${span.inputSeq}`,
    })),
    sentences: spans.map((span) => ({
      id: `sentence-${span.inputSeq}`,
      text: `原句 ${span.inputSeq}`,
      citationIds: [`citation-${span.inputSeq}`],
    })),
    facts: spans.map((span) => ({
      id: `fact-${span.inputSeq}`,
      kind: "fact" as const,
      text: `事实 ${span.inputSeq}`,
      citationIds: [`citation-${span.inputSeq}`],
      dependsOnFactIds: [],
    })),
  }
}

function apiStore(stories: StoryStore): Store {
  return { ownerId: "owner", stories } as unknown as Store
}

afterEach(() => databases.splice(0).forEach((db) => db.close()))

describe("人工 Story 纠正编排", () => {
  it("合并只派生当前已验证材料，重命名引用 ID 并保留旧链接", () => {
    const { stories } = fixture()
    const keepId = "00000000-0000-4000-8000-000000000101"
    const mergeId = "00000000-0000-4000-8000-000000000102"
    stories.create(draft([1, 2], "保留标题"), keepId)
    stories.create(draft([3, 4], "合并标题"), mergeId)

    expect(() =>
      processingApi(apiStore(stories), "POST", "/stories/merge", {
        keepStoryId: keepId,
        mergeStoryId: mergeId,
        expectedKeepRevision: 1,
        expectedMergedRevision: 1,
        revision: { browserControlled: true },
      }),
    ).toThrow()
    const result = processingApi(apiStore(stories), "POST", "/stories/merge", {
      keepStoryId: keepId,
      mergeStoryId: mergeId,
      expectedKeepRevision: 1,
      expectedMergedRevision: 1,
    }) as ReturnType<StoryCorrectionService["merge"]>

    expect(result.revision.members.map((member) => member.inputSeq)).toEqual([1, 2, 3, 4])
    expect(new Set(result.revision.sourceSpans.map((span) => span.id)).size).toBe(4)
    expect(new Set(result.revision.citations.map((citation) => citation.id)).size).toBe(4)
    expect(stories.resolveLink(mergeId)).toMatchObject({ kind: "merged", mergedInto: keepId })
  })

  it("拆分只接受完整的多篇分组，并保存跨组排除约束", () => {
    const { stories } = fixture()
    const parentId = "00000000-0000-4000-8000-000000000103"
    stories.create(draft([1, 2, 3, 4]), parentId)

    const result = processingApi(apiStore(stories), "POST", `/stories/${parentId}/split`, {
      expectedRevision: 1,
      groups: [
        [1, 2],
        [3, 4],
      ],
    }) as ReturnType<StoryCorrectionService["split"]>

    expect(result.childIds).toHaveLength(2)
    expect(stories.resolveLink(parentId)).toMatchObject({
      kind: "split",
      splitInto: result.childIds,
    })
    expect(stories.canAggregate("rule", "scope", [1, 3])).toBe(false)
  })

  it("三篇可拆为双来源 Story 加独立条目，并可撤销恢复父 Story", () => {
    const { stories } = fixture()
    const parentId = "00000000-0000-4000-8000-000000000105"
    stories.create(draft([1, 2, 3]), parentId)
    stories.markRead(parentId, "reader")

    const result = processingApi(apiStore(stories), "POST", `/stories/${parentId}/split`, {
      expectedRevision: 1,
      groups: [[1, 2]],
      independentInputSeqs: [3],
    }) as ReturnType<StoryCorrectionService["split"]>

    expect(result.childIds).toHaveLength(1)
    expect(result.independentInputSeqs).toEqual([3])
    expect(stories.resolveLink(parentId)).toMatchObject({
      kind: "split",
      splitInto: result.childIds,
      independentInputSeqs: [3],
    })
    expect(stories.canAggregate("rule", "scope", [1, 3])).toBe(false)
    expect(stories.canAggregate("rule", "scope", [2, 3])).toBe(false)

    stories.undoCorrection(result.correction.id)
    expect(stories.resolveLink(parentId)).toMatchObject({ kind: "current" })
    expect(stories.resolveLink(result.childIds[0]!)).toMatchObject({
      kind: "merged",
      mergedInto: parentId,
    })
    expect(stories.readStatus(parentId, "reader").unread).toBe(false)
  })

  it("双成员 Story 可全部拆回独立项，旧链接保留去向并支持撤销", () => {
    const { stories } = fixture()
    const parentId = "00000000-0000-4000-8000-000000000106"
    stories.create(draft([1, 2]), parentId)
    const result = processingApi(apiStore(stories), "POST", `/stories/${parentId}/split`, {
      expectedRevision: 1,
      groups: [],
      independentInputSeqs: [1, 2],
    }) as ReturnType<StoryCorrectionService["split"]>
    expect(result.childIds).toEqual([])
    expect(stories.resolveLink(parentId)).toMatchObject({
      kind: "split",
      splitInto: [],
      independentInputSeqs: [1, 2],
    })
    expect(stories.canAggregate("rule", "scope", [1, 2])).toBe(false)
    stories.undoCorrection(result.correction.id)
    expect(stories.resolveLink(parentId)).toMatchObject({ kind: "current" })
    expect(stories.canAggregate("rule", "scope", [1, 2])).toBe(true)
  })

  it("拒绝单篇、重叠或不完整分组，不伪造单源综合 Story", () => {
    const { stories, corrections } = fixture()
    const parentId = "00000000-0000-4000-8000-000000000104"
    stories.create(draft([1, 2, 3, 4]), parentId)

    expect(() =>
      corrections.split({
        storyId: parentId,
        expectedRevision: 1,
        groups: [[1], [2, 3, 4]],
      }),
    ).toThrow("invalid_reference")
    expect(() =>
      corrections.split({
        storyId: parentId,
        expectedRevision: 1,
        groups: [
          [1, 2],
          [2, 3, 4],
        ],
      }),
    ).toThrow("invalid_reference")
  })
})
