import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import type { TagAssessment } from "@follow/information-core"
import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProcessingInput } from "./automation-store"
import { processingApi } from "./processing-api"
import type { ProcessingDecision } from "./processing-decision"
import { semanticQuerySchema } from "./processing-semantic-store"
import { Store } from "./store"

const stores: Store[] = []
const directories: string[] = []
const available = new Set(["feed/1", "feed/2"])
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  vi.useRealTimers()
})
function fixture(path = ":memory:") {
  const store = new Store(path)
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources(
    [...available].map((key) => ({
      key,
      id: key.slice(5),
      kind: "feed" as const,
      title: key,
      view: 0,
      category: null,
    })),
  )
  if (!store.automation.releases().length)
    store.automation.publish(0, { mode: "future" }, randomUUID())
  return store
}
function assessment(
  state: TagAssessment["state"],
  extra: Partial<TagAssessment> = {},
): TagAssessment {
  return {
    tagId: "signal:social_chatter",
    definitionVersion: 1,
    state,
    confidence: 0.95,
    reason: "已检查完整材料",
    evidenceIds: [],
    ...extra,
  }
}
function decision(input: ProcessingInput, assessments: TagAssessment[]): ProcessingDecision {
  return {
    schemaVersion: 2,
    fingerprint: `semantic-${input.seq}`,
    provider: "qianwen",
    model: "test-model",
    generatedAt: "2026-10-06T00:00:00Z",
    durationMs: 1,
    usage: null,
    status: "keep",
    title: input.body.title,
    summary: "摘要",
    reason: "分析完成",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "source",
    context: { source_id: input.sourceKey, contextId: input.sourceKey },
    facts: [],
    semantic: null,
    reused: false,
    semanticProfile: {
      schemaVersion: 2,
      contentVersion: input.contentVersion,
      materialDigest: "material",
      definitionDigest: "definitions",
      assessedTagIds: assessments.map((item) => item.tagId),
      assessments,
      evidence: {},
      coverage: assessments.some((item) => item.state === "unknown") ? "partial" : "complete",
    },
  }
}
function save(
  store: Store,
  id: string,
  assessments?: TagAssessment[],
  sourceKey = "feed/1",
  day = 1,
) {
  store.saveEntry({
    id,
    sourceKey,
    title: id,
    url: null,
    publishedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`,
    read: false,
    content: `原始正文 ${id}`,
    description: null,
  })
  const input = store.automation.assign(store.automation.current(sourceKey, id)!.seq)
  const output = decision(input, assessments ?? [])
  const result = assessments ? store.semantics.publish(input, output) : null
  return { input, output, result }
}
const query = (extra: object = {}) =>
  semanticQuerySchema.parse({ includeTagIds: ["signal:social_chatter"], ...extra })

// 使用真实 SQLite、事务和重开文件验证投影；不请求模型、不发布任何外部配置。
describe("语义档案存储、查询与人工覆盖", () => {
  it("批量结果索引保留真实置信度和否定判断，纠错与正文替换后同步失效", () => {
    const store = fixture()
    const { input, output } = save(store, "dim", [
      assessment("present", { confidence: 0.78 }),
      assessment("absent", { tagId: "form:pure_entertainment" }),
    ])
    expect(store.semantics.tagAssessmentsByInput().get(input.seq)).toEqual(
      expect.arrayContaining(output.semanticProfile!.assessments),
    )
    const response = processingApi(store, "GET", "/processing/entry-results", null) as {
      results: Array<{ semanticAssessments: TagAssessment[] }>
    }
    expect(response.results[0]!.semanticAssessments).toEqual(
      expect.arrayContaining(output.semanticProfile!.assessments),
    )
    store.semantics.correct(
      input,
      {
        expectedRevision: 0,
        expectedContentVersion: input.contentVersion,
        requestId: randomUUID(),
        changes: [{ tagId: "signal:social_chatter", state: "absent" }],
      },
      () => {
        const result = store.automation.recalculate(
          store.automation.current(input.sourceKey, input.itemId)!,
          output,
        )
        store.semantics.index(result.input, output, result.id)
      },
    )
    expect(
      store.semantics
        .tagAssessmentsByInput()
        .get(input.seq)
        ?.find((item) => item.tagId === "signal:social_chatter"),
    ).toMatchObject({ state: "absent", confidence: 1 })
    store.saveEntry({ ...input.body, content: "新的正文" })
    expect(store.semantics.tagAssessmentsByInput().has(input.seq)).toBe(false)
  })

  it("账号数据库与来源授权隔离，未绑定账号不能读取或重放纠错", () => {
    const store = fixture()
    save(store, "allowed", [assessment("present")])
    save(store, "other-source", [assessment("present")], "feed/2")
    expect(store.semantics.query(query(), new Set(["feed/1"]))).toMatchObject({
      counts: { matched: 1, scopeTotal: 1 },
      entries: [{ itemId: "allowed" }],
    })
    expect(() =>
      store.semantics.query(query({ sourceKeys: ["feed/2"] }), new Set(["feed/1"])),
    ).toThrow("invalid_target")
    expect(() => store.bindOwner("another-owner")).toThrow("account_changed")
    const other = fixture()
    const snapshot = store.semantics.query(query(), available)
    expect(() =>
      other.semantics.query(query({ snapshotId: snapshot.snapshotId }), available),
    ).toThrow("invalid_target")
    const unbound = new Store(":memory:")
    stores.push(unbound)
    expect(() => unbound.semantics.query(query(), available)).toThrow("owner_required")
    expect(() =>
      unbound.semantics.correct(
        save(store, "sample", [assessment("absent")]).input,
        {
          expectedRevision: 0,
          expectedContentVersion: "x",
          requestId: randomUUID(),
          changes: [{ tagId: "signal:social_chatter", state: "present" }],
        },
        () => {},
      ),
    ).toThrow("owner_required")
  })
  it("先筛选整个授权范围再分页，不遗漏后面的匹配，也不混入其它来源", () => {
    const store = fixture()
    save(store, "old-hit", [assessment("present")], "feed/1", 1)
    save(store, "new-hit", [assessment("present")], "feed/1", 2)
    save(store, "newest-miss", [assessment("absent")], "feed/1", 4)
    save(store, "outside", [assessment("present")], "feed/2", 5)
    const first = store.semantics.query(query({ limit: 1 }), new Set(["feed/1"]))
    expect(first.entries.map((item) => item.itemId)).toEqual(["new-hit"])
    expect(first.counts).toEqual({ matched: 2, unknown: 0, indexed: 3, scopeTotal: 3 })
    expect(first.nextOffset).toBe(1)
    const second = store.semantics.query(
      query({ snapshotId: first.snapshotId, offset: 1, limit: 1 }),
      new Set(["feed/1"]),
    )
    expect(second.entries.map((item) => item.itemId)).toEqual(["old-hit"])
    expect(second.nextOffset).toBeNull()
  })
  it("缺失、低置信、过期定义和未知判断不能命中排除条件", () => {
    const store = fixture()
    save(store, "absent", [assessment("absent")])
    save(store, "present", [assessment("present")])
    save(store, "unknown", [assessment("unknown")])
    save(store, "low-confidence", [assessment("absent", { confidence: 0.5 })])
    save(store, "old-definition", [assessment("absent", { definitionVersion: 2 })])
    save(store, "missing-tag", [])
    save(store, "unprocessed")
    const exclude = query({ includeTagIds: [], excludeTagIds: ["signal:social_chatter"] })
    const result = store.semantics.query(exclude, available)
    expect(result.entries.map((item) => item.itemId)).toEqual(["absent"])
    expect(result.counts).toMatchObject({ matched: 1, unknown: 5, scopeTotal: 7 })
    expect(store.semantics.query({ ...exclude, state: "unknown" }, available).entries).toHaveLength(
      5,
    )
  })
  it("快照冻结筛选结果，授权、过滤条件和撤回名单变化不能沿用旧分页", () => {
    const store = fixture()
    const old = save(store, "old", [assessment("present")])
    const first = store.semantics.query(query({ limit: 1 }), available)
    save(store, "new", [assessment("present")], "feed/1", 3)
    expect(
      store.semantics
        .query(query({ snapshotId: first.snapshotId }), available)
        .entries.map((item) => item.itemId),
    ).toEqual(["old"])
    expect(() =>
      store.semantics.query(query({ snapshotId: first.snapshotId }), new Set(["feed/1"])),
    ).toThrow("invalid_target")
    expect(() =>
      store.semantics.query(query({ snapshotId: first.snapshotId, state: "unknown" }), available),
    ).toThrow("invalid_target")
    expect(() =>
      store.semantics.query(
        query({ snapshotId: first.snapshotId }),
        available,
        new Set([old.input.seq]),
      ),
    ).toThrow("invalid_target")
  })
  it("撤回条目在计数和分页之前排除，不能用总数泄漏已撤回材料", () => {
    const store = fixture()
    save(store, "remaining", [assessment("present")])
    const withdrawn = save(store, "withdrawn", [assessment("present")], "feed/1", 5)
    const unknown = save(store, "withdrawn-unknown")
    const result = store.semantics.query(
      query({ limit: 1 }),
      available,
      new Set([withdrawn.input.seq, unknown.input.seq]),
    )
    expect(result.entries.map((item) => item.itemId)).toEqual(["remaining"])
    expect(result.counts).toEqual({ matched: 1, unknown: 0, indexed: 1, scopeTotal: 1 })
    expect(result.nextOffset).toBeNull()
  })
  it("纠错检查 revision、材料版本和请求幂等，覆盖不改原始档案并可撤销", () => {
    const store = fixture()
    const { input, output } = save(store, "correct", [assessment("absent")])
    let recomputations = 0
    const recompute = () => {
      recomputations++
      const result = store.automation.recalculate(
        store.automation.current(input.sourceKey, input.itemId)!,
        output,
      )
      store.semantics.index(result.input, output, result.id)
    }
    const request = {
      expectedRevision: 0,
      expectedContentVersion: input.contentVersion,
      requestId: randomUUID(),
      changes: [{ tagId: "signal:social_chatter" as const, state: "present" as const }],
    }
    expect(() =>
      store.semantics.correct(input, { ...request, expectedRevision: 1 }, recompute),
    ).toThrow("revision_conflict")
    expect(() =>
      store.semantics.correct(input, { ...request, expectedContentVersion: "old" }, recompute),
    ).toThrow("revision_conflict")
    const result = store.semantics.correct(input, request, recompute)
    expect(result.overrideRevision).toBe(1)
    expect(result.assessments[0]).toMatchObject({ state: "present", confidence: 1 })
    expect(result.profile).toEqual(output.semanticProfile)
    expect(result.profile?.assessments[0]?.state).toBe("absent")
    expect(store.semantics.query(query(), available).counts.matched).toBe(1)
    expect(store.semantics.correct(input, request, recompute)).toEqual(result)
    expect(recomputations).toBe(1)
    expect(() =>
      store.semantics.correct(
        input,
        { ...request, changes: [{ tagId: "signal:social_chatter", state: "absent" }] },
        recompute,
      ),
    ).toThrow("revision_conflict")
    const current = store.automation.current(input.sourceKey, input.itemId)!
    const undone = store.semantics.correct(
      current,
      {
        ...request,
        expectedRevision: 1,
        requestId: randomUUID(),
        changes: [{ tagId: "signal:social_chatter", state: "automatic" }],
      },
      recompute,
    )
    expect(undone.assessments).toEqual(output.semanticProfile?.assessments)
    expect(undone.overrideRevision).toBe(2)
    expect(store.semantics.query(query(), available).counts.matched).toBe(0)
  })
  it("重算失败整笔回滚，材料替换后的陈旧纠错无法写入新条目", () => {
    const store = fixture()
    const { input, output } = save(store, "rollback", [assessment("absent")])
    const request = {
      expectedRevision: 0,
      expectedContentVersion: input.contentVersion,
      requestId: randomUUID(),
      changes: [{ tagId: "signal:social_chatter" as const, state: "present" as const }],
    }
    expect(() =>
      store.semantics.correct(input, request, () => {
        throw new Error("projection_failed")
      }),
    ).toThrow("projection_failed")
    expect(store.semantics.view(input)).toMatchObject({
      overrideRevision: 0,
      assessments: [{ state: "absent" }],
    })
    const changed = store.automation.recalculate(input, output)
    store.semantics.index(changed.input, output, changed.id)
    expect(() => store.semantics.correct(input, request, () => {})).toThrow("revision_conflict")
    store.saveEntry({ ...input.body, content: "完全不同的新正文" })
    expect(() => store.semantics.correct(changed.input, request, () => {})).toThrow(
      "revision_conflict",
    )
    expect(store.semantics.view(changed.input).profile).toBeNull()
    expect(store.semantics.query(query(), available).counts).toMatchObject({
      matched: 0,
      unknown: 1,
      indexed: 0,
    })
  })
  it("陈旧发布或直接索引不能替换当前档案，重发只索引首个不可变结果", () => {
    const store = fixture()
    const { input, output, result } = save(store, "immutable", [assessment("absent")])
    const late = decision(input, [assessment("present")])
    expect(store.semantics.publish(input, late).id).toBe(result?.id)
    expect(store.semantics.view(input).profile).toEqual(output.semanticProfile)
    const newOutput = decision(input, [assessment("present")])
    const changed = store.automation.recalculate(
      store.automation.current(input.sourceKey, input.itemId)!,
      newOutput,
    )
    store.semantics.index(changed.input, newOutput, changed.id)
    expect(store.semantics.publish(input, output).published).toBe(false)
    store.semantics.index(input, output, result!.id)
    store.semantics.index(changed.input, output, "wrong-pointer")
    expect(store.semantics.view(changed.input).profile).toEqual(newOutput.semanticProfile)
    expect(store.semantics.query(query(), available).counts.matched).toBe(1)
  })
  it("关闭重开保留客观档案、覆盖版本及查询快照", () => {
    const directory = mkdtempSync(join(tmpdir(), "folo-semantic-store-"))
    directories.push(directory)
    const path = join(directory, "semantics.sqlite")
    const store = fixture(path)
    const { input, output } = save(store, "persisted", [assessment("absent")])
    store.semantics.correct(
      input,
      {
        expectedRevision: 0,
        expectedContentVersion: input.contentVersion,
        requestId: randomUUID(),
        changes: [{ tagId: "signal:social_chatter", state: "present" }],
      },
      () => {
        const changed = store.automation.recalculate(input, output)
        store.semantics.index(changed.input, output, changed.id)
      },
    )
    const snapshot = store.semantics.query(query(), available)
    stores.splice(stores.indexOf(store), 1)
    store.close()
    const reopened = fixture(path)
    const current = reopened.automation.current(input.sourceKey, input.itemId)!
    expect(reopened.semantics.view(current)).toMatchObject({
      overrideRevision: 1,
      profile: output.semanticProfile,
      assessments: [{ state: "present" }],
    })
    expect(reopened.semantics.query(query({ snapshotId: snapshot.snapshotId }), available)).toEqual(
      snapshot,
    )
  })
  it("快照保留最近一百份并在二十四小时后失效", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-06T00:00:00Z"))
    const directory = mkdtempSync(join(tmpdir(), "folo-semantic-snapshots-"))
    directories.push(directory)
    const path = join(directory, "snapshots.sqlite")
    const store = fixture(path)
    const first = store.semantics.query(query(), available)
    for (let i = 0; i < 101; i++) store.semantics.query(query(), available)
    expect(() => store.semantics.query(query({ snapshotId: first.snapshotId }), available)).toThrow(
      "invalid_target",
    )
    const db = new DatabaseSync(path)
    try {
      expect(db.prepare("SELECT count(*) AS n FROM semantic_query_snapshots").get()?.n).toBe(100)
    } finally {
      db.close()
    }
    const current = store.semantics.query(query(), available)
    vi.setSystemTime(new Date("2026-10-07T00:00:01Z"))
    expect(() =>
      store.semantics.query(query({ snapshotId: current.snapshotId }), available),
    ).toThrow("invalid_target")
    expect(store.semantics.query(query(), available).entries).toEqual([])
  })
})
