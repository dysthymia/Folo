import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import type { StoryRevisionDraft } from "./story-store"
import { sourceSpanFragmentId, StoryStore, StoryStoreError } from "./story-store"

const databases: DatabaseSync[] = []

function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  // StoryStore 必须只接受实际已捕获的输入与已发布的决策，不为测试或 worker 伪造材料。
  db.exec(`
    CREATE TABLE processing_inputs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      content_version TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      release_version INTEGER,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      current INTEGER NOT NULL,
      decision_id TEXT
    );
    CREATE TABLE entry_decisions (
      id TEXT PRIMARY KEY,
      input_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      release_version INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  for (let index = 1; index <= 4; index++) {
    const decisionId = `decision-${index}`
    const releaseVersion = 1
    const generation = 1
    db.prepare("INSERT INTO processing_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      index,
      `feed/${index}`,
      `entry-${index}`,
      `v${index}`,
      JSON.stringify({ content: `<p>证据片段 ${index}</p>` }),
      "2026-09-12T00:00:00.000Z",
      releaseVersion,
      generation,
      "succeeded",
      1,
      decisionId,
    )
    db.prepare("INSERT INTO entry_decisions VALUES(?,?,?,?,?,?)").run(
      decisionId,
      index,
      generation,
      releaseVersion,
      JSON.stringify({ allowed: true }),
      "2026-09-12T00:00:00.000Z",
    )
  }
  return { db, store: new StoryStore(db) }
}

function draft(inputSeqs: number[], title = "事件综述", body = "正文") {
  const sourceSpans = inputSeqs.map((inputSeq) => ({
    id: `span-${inputSeq}`,
    inputSeq,
    sourceItemId: `entry-${inputSeq}`,
    contentVersion: `v${inputSeq}`,
    fragmentId: sourceSpanFragmentId(`entry-${inputSeq}`, `v${inputSeq}`, `证据片段 ${inputSeq}`),
    quote: `证据片段 ${inputSeq}`,
    sourceRole: inputSeq === 1 ? "official" : "reporting",
  }))
  const citations = inputSeqs.map((inputSeq) => ({
    id: `citation-${inputSeq}`,
    sourceSpanId: `span-${inputSeq}`,
    sentenceId: `sentence-${inputSeq}`,
  }))
  return {
    title,
    body,
    aggregationRuleId: "aggregation-rule",
    aggregationScopeVersion: "scope-v1",
    appliedRuleSetVersion: 1,
    instructionFingerprint: "instruction-v1",
    members: inputSeqs.map((inputSeq) => ({ inputSeq, decisionId: `decision-${inputSeq}` })),
    sourceSpans,
    citations,
    sentences: inputSeqs.map((inputSeq) => ({
      id: `sentence-${inputSeq}`,
      text: `第 ${inputSeq} 句`,
      citationIds: [`citation-${inputSeq}`],
    })),
    facts: [
      ...inputSeqs.map((inputSeq) => ({
        id: `fact-${inputSeq}`,
        kind: "fact" as const,
        text: `事实 ${inputSeq}`,
        citationIds: [`citation-${inputSeq}`],
        dependsOnFactIds: [],
      })),
      {
        id: "inference",
        kind: "inference" as const,
        text: "基于来源的推断",
        citationIds: [`citation-${inputSeqs[0]}`],
        dependsOnFactIds: [`fact-${inputSeqs[0]}`],
      },
    ],
  } satisfies StoryRevisionDraft
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe("Story 持久化与版本", () => {
  it("仅接受真实 input/decision 与对应的内容版本、句段引用和事实依赖", () => {
    const { store } = fixture()
    const invalidDecision = draft([1, 2])
    invalidDecision.members[0]!.decisionId = "missing-decision"
    expect(() => store.create(invalidDecision)).toThrow(StoryStoreError)

    const invalidSpan = draft([1, 2])
    invalidSpan.sourceSpans[0]!.contentVersion = "old-version"
    expect(() => store.create(invalidSpan)).toThrow("invalid_reference")

    const invalidInference = draft([1, 2])
    invalidInference.facts.at(-1)!.dependsOnFactIds = []
    expect(() => store.create(invalidInference)).toThrow("invalid_reference")

    const invalidFragment = draft([1, 2])
    invalidFragment.sourceSpans[0]!.quote = "模型编造的片段"
    invalidFragment.sourceSpans[0]!.fragmentId = sourceSpanFragmentId(
      "entry-1",
      "v1",
      "模型编造的片段",
    )
    expect(() => store.create(invalidFragment)).toThrow("invalid_reference")

    const cyclicFacts = draft([1, 2])
    cyclicFacts.facts[0]!.dependsOnFactIds = ["fact-2"]
    cyclicFacts.facts[1]!.dependsOnFactIds = ["fact-1"]
    expect(() => store.create(cyclicFacts)).toThrow("invalid_reference")
  })

  it("拒绝旧 generation、非当前 decision 或未成功的决策，并在输入失效后停止当前快照", () => {
    const { db, store } = fixture()
    const invalidGeneration = draft([1, 2])
    db.prepare("UPDATE processing_inputs SET generation=2 WHERE seq=1").run()
    expect(() => store.create(invalidGeneration)).toThrow("invalid_reference")

    db.prepare("UPDATE processing_inputs SET generation=1,status='succeeded' WHERE seq=1").run()
    const storyId = "00000000-0000-4000-8000-000000000041"
    store.create(draft([1, 2]), storyId)
    db.prepare("UPDATE processing_inputs SET current=0 WHERE seq=1").run()
    expect(store.currentSnapshot(storyId)).toBeNull()
    expect(store.resolveLink(storyId)).toMatchObject({ kind: "repairing" })
  })

  it("可按外部变更显式失效输入关联的当前 Story，不创建撤回或排除约束", () => {
    const { store } = fixture()
    const storyId = "00000000-0000-4000-8000-000000000042"
    store.create(draft([1, 2]), storyId)

    expect(store.invalidateInputs([1, 999, 1])).toEqual([storyId])
    expect(store.currentSnapshot(storyId)).toBeNull()
    expect(store.invalidateInputs([3])).toEqual([])
  })

  it("批量影响索引只保留当前 revision，并随拆分同步到各子 Story", () => {
    const { store } = fixture()
    const parentId = "00000000-0000-4000-8000-000000000043"
    const firstChildId = "00000000-0000-4000-8000-000000000044"
    const secondChildId = "00000000-0000-4000-8000-000000000045"
    const first = store.create(draft([1, 2]), parentId)
    store.appendRevision(parentId, first.revision, draft([2, 3]))

    // 已被新版移除的 input 不能因历史 revision 被错误修复。
    expect(store.invalidateInputs([1])).toEqual([])
    expect(store.invalidateInputs([3])).toEqual([parentId])

    const repaired = store.repair(parentId, 2, draft([1, 2, 3, 4]))
    const split = store.split({
      storyId: parentId,
      expectedCurrentRevision: repaired.revision,
      children: [
        { storyId: firstChildId, revision: draft([1, 2]) },
        { storyId: secondChildId, revision: draft([3, 4]) },
      ],
    })

    expect(split.childIds).toEqual([firstChildId, secondChildId])
    expect(store.invalidateInputs([1, 4])).toEqual([firstChildId, secondChildId])
  })

  it("revision 不可变且 current 指针使用 CAS；纯展示变化不制造未读", () => {
    const { store } = fixture()
    const storyId = "00000000-0000-4000-8000-000000000001"
    const first = store.create(draft([1, 2]), storyId)
    store.markRead(storyId, "reader")
    const displayOnly = store.appendRevision(
      storyId,
      first.revision,
      draft([1, 2], "事件综述", "  正文\n"),
    )

    expect(displayOnly.revision).toBe(2)
    expect(displayOnly.substantiveRevision).toBe(1)
    expect(store.revision(storyId, 1)).toEqual(first)
    expect(store.readStatus(storyId, "reader")).toEqual({
      readSubstantiveRevision: 1,
      unread: false,
    })
    expect(() => store.appendRevision(storyId, first.revision, draft([1, 2], "新标题"))).toThrow(
      "revision_conflict",
    )
  })

  it("合并保留 ID、历史链接和独立阅读回执，且新 revision 覆盖双方材料", () => {
    const { store } = fixture()
    const keepId = "00000000-0000-4000-8000-000000000011"
    const mergedId = "00000000-0000-4000-8000-000000000012"
    const kept = store.create(draft([1, 2]), keepId)
    const merged = store.create(draft([3, 4]), mergedId)
    store.markRead(mergedId, "reader")

    const result = store.merge({
      keepStoryId: keepId,
      mergeStoryId: mergedId,
      expectedKeepRevision: kept.revision,
      expectedMergedRevision: merged.revision,
      revision: draft([1, 2, 3, 4]),
    })

    expect(result.revision.revision).toBe(2)
    expect(store.resolveLink(mergedId)).toMatchObject({ kind: "merged", mergedInto: keepId })
    expect(store.readStatus(keepId, "reader").unread).toBe(true)
    expect(store.currentSnapshot(keepId)?.members.map((member) => member.inputSeq)).toEqual([
      1, 2, 3, 4,
    ])

    const undo = store.undoCorrection(result.correction.id)
    expect(undo.payload.restoredRevisions).toEqual({ [keepId]: 3, [mergedId]: 2 })
    expect(store.currentSnapshot(keepId)?.members.map((member) => member.inputSeq)).toEqual([1, 2])
    expect(store.currentSnapshot(mergedId)?.members.map((member) => member.inputSeq)).toEqual([
      3, 4,
    ])
    expect(store.resolveLink(mergedId)).toMatchObject({ kind: "current" })
    // 恢复内容与原实质版本相同，不制造新的未读提醒。
    expect(store.readStatus(mergedId, "reader").unread).toBe(false)
  })

  it("拆分后旧链接保留子 Story，跨组成员不会在下一轮自动误合并", () => {
    const { store } = fixture()
    const parentId = "00000000-0000-4000-8000-000000000021"
    const firstChildId = "00000000-0000-4000-8000-000000000022"
    const secondChildId = "00000000-0000-4000-8000-000000000023"
    const parent = store.create(draft([1, 2, 3, 4]), parentId)
    store.markRead(parentId, "reader")

    const result = store.split({
      storyId: parentId,
      expectedCurrentRevision: parent.revision,
      children: [
        { storyId: firstChildId, revision: draft([1, 2], "子 Story 一") },
        { storyId: secondChildId, revision: draft([3, 4], "子 Story 二") },
      ],
    })

    expect(result.childIds).toEqual([firstChildId, secondChildId])
    expect(store.resolveLink(parentId)).toMatchObject({ kind: "split", splitInto: result.childIds })
    expect(store.canAggregate("aggregation-rule", "scope-v1", [1, 3])).toBe(false)
    expect(() => store.create(draft([1, 3]))).toThrow("invalid_reference")
    expect(store.canAggregate("aggregation-rule", "scope-v1", [1, 2])).toBe(true)
    expect(store.readStatus(firstChildId, "reader").unread).toBe(true)

    store.undoCorrection(result.correction.id)
    expect(store.resolveLink(parentId)).toMatchObject({ kind: "current" })
    expect(store.currentSnapshot(parentId)?.members.map((member) => member.inputSeq)).toEqual([
      1, 2, 3, 4,
    ])
    expect(store.resolveLink(firstChildId)).toMatchObject({ kind: "merged", mergedInto: parentId })
    expect(store.resolveLink(secondChildId)).toMatchObject({ kind: "merged", mergedInto: parentId })
    expect(store.canAggregate("aggregation-rule", "scope-v1", [1, 3])).toBe(true)
  })

  it("拓扑纠正后 revision 已推进时拒绝撤销且不产生半恢复状态", () => {
    const { store } = fixture()
    const keepId = "00000000-0000-4000-8000-000000000051"
    const mergedId = "00000000-0000-4000-8000-000000000052"
    const kept = store.create(draft([1, 2]), keepId)
    const merged = store.create(draft([3, 4]), mergedId)
    const result = store.merge({
      keepStoryId: keepId,
      mergeStoryId: mergedId,
      expectedKeepRevision: kept.revision,
      expectedMergedRevision: merged.revision,
      revision: draft([1, 2, 3, 4]),
    })
    store.appendRevision(keepId, result.revision.revision, draft([1, 2, 3, 4], "后续更新"))

    expect(() => store.undoCorrection(result.correction.id)).toThrow("revision_conflict")
    expect(store.resolveLink(mergedId)).toMatchObject({ kind: "merged", mergedInto: keepId })
    expect(store.correction(result.correction.id)?.undoneBy).toBeNull()
  })

  it("撤回材料立即停止当前正文；撤销纠正只记录重算，不复活失效材料", () => {
    const { db, store } = fixture()
    const storyId = "00000000-0000-4000-8000-000000000031"
    const affectedStoryId = "00000000-0000-4000-8000-000000000032"
    const story = store.create(draft([1, 2]), storyId)
    store.create(draft([1, 3]), affectedStoryId)
    const removal = store.removeMember(storyId, story.revision, 1)
    const withdrawal = store.withdrawMaterial(1, "来源已撤回")

    expect(store.currentSnapshot(storyId)).toBeNull()
    expect(store.resolveLink(storyId)).toMatchObject({ kind: "repairing" })
    expect(store.currentSnapshot(affectedStoryId)).toBeNull()
    const undo = store.undoCorrection(removal.id)
    expect(store.correction(removal.id)?.undoneBy).toBe(undo.id)
    expect(store.correction(withdrawal.id)?.kind).toBe("material_withdrawn")
    expect(
      db.prepare("SELECT active FROM story_member_exclusions WHERE correction_id=?").get(removal.id)
        ?.active,
    ).toBe(1)
    expect(() => store.create(draft([1, 2]))).toThrow("invalid_reference")
  })
})
