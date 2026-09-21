import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import type { RuleSet } from "@follow/information-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { automationApi } from "./automation-api"
import { AutomationStore } from "./automation-store"
import type { SourceEntry } from "./folo"
import type { ProcessingDecision } from "./processing-decision"
import { ProcessingStateStore } from "./processing-state"
import { Store } from "./store"

const entry: SourceEntry = {
  id: "e1",
  sourceKey: "feed/1",
  title: "原帖",
  url: "https://example.test/1",
  publishedAt: "2000-01-01T00:00:00Z",
  content: "完整原文",
  description: null,
  read: true,
}
const config: RuleSet = {
  formatVersion: 4,
  ownerId: "owner",
  global: { version: 1, markdown: "全局说明" },
  rules: [],
}
const close: (() => void)[] = []
function fixture() {
  const db = new DatabaseSync(":memory:")
  close.push(() => db.close())
  return { db, repository: new AutomationStore(db, () => "owner") }
}
function decision(fingerprint: string): ProcessingDecision {
  return {
    schemaVersion: 1,
    fingerprint,
    provider: "qianwen",
    model: "qwen3.8-flash",
    generatedAt: "2026-09-12T00:00:00.000Z",
    durationMs: 1,
    usage: null,
    status: "keep",
    title: "原帖",
    summary: "摘要",
    reason: "原因",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "source",
    context: { source_id: "f1", contextId: "feed/1" },
    facts: [],
    semantic: null,
    reused: false,
  }
}
afterEach(() => {
  close.splice(0).forEach((fn) => fn())
  vi.useRealTimers()
})

describe("发布范围与输入版本", () => {
  it("草稿保存不发布；旧 revision 与跨账号配置不能覆盖新草稿", () => {
    const { repository } = fixture()
    expect(repository.saveDraft(config, 0).revision).toBe(1)
    expect(repository.releases()).toEqual([])
    expect(() => repository.saveDraft(config, 0)).toThrow("revision_conflict")
    expect(() => repository.saveDraft({ ...config, ownerId: "other" }, 1)).toThrow(
      "invalid_rule_set",
    )
    expect(repository.draft().revision).toBe(1)
  })

  it("仅未来输入保留已分配目标；首次未分配和后来输入使用新发布", () => {
    const { repository } = fixture()
    const old = repository.capture(entry)
    const first = repository.publish(0, { mode: "future" }, randomUUID())
    const assigned = repository.assign(old)
    repository.complete(assigned, { answer: "旧结果" })
    repository.saveDraft(config, 0)
    const waiting = repository.capture({ ...entry, id: "e2" })
    const next = repository.publish(1, { mode: "future" }, randomUUID())
    expect(next.targetInputIds).toEqual([waiting])
    expect(repository.assign(old)).toMatchObject({
      releaseVersion: first.version,
      generation: 1,
      status: "succeeded",
    })
    const later = repository.capture({ ...entry, id: "e3" })
    expect(repository.assign(later).releaseVersion).toBe(next.version)
    expect(repository.release(first.version)?.global.markdown).toBe("")
    expect(repository.release(next.version)?.global.markdown).toBe("全局说明")
  })

  it("最近范围按摄取时间，旧文章新摄取不会漏掉；晚到旧任务不能覆盖重算", () => {
    vi.useFakeTimers()
    const { repository, db } = fixture()
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"))
    const older = repository.capture(entry)
    repository.publish(0, { mode: "future" }, randomUUID())
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"))
    const fresh = repository.capture({ ...entry, id: "e2" })
    const staleTarget = repository.assign(fresh)
    const release = repository.publish(
      0,
      { mode: "recent", since: "2026-09-11T00:00:00Z" },
      randomUUID(),
    )
    expect(release.targetInputIds).toEqual([fresh])
    expect(repository.assign(older).releaseVersion).toBe(1)
    const current = repository.assign(fresh)
    expect(current.generation).toBe(staleTarget.generation + 1)
    const valid = repository.complete(current, { answer: "新结果" })
    expect(valid.published).toBe(true)
    expect(repository.complete(staleTarget, { answer: "旧结果" }).published).toBe(false)
    expect(
      db.prepare("SELECT decision_id FROM processing_inputs WHERE seq=?").get(fresh)?.decision_id,
    ).toBe(valid.id)
    expect(db.prepare("SELECT count(*) AS n FROM entry_decisions").get()?.n).toBe(2)
  })

  it("指定目标与重发请求冻结范围，重发不会增加发布或 generation", () => {
    const { repository } = fixture()
    const seq = repository.capture(entry)
    repository.publish(0, { mode: "future" }, randomUUID())
    const requestId = randomUUID()
    const release = repository.publish(0, { mode: "selected", inputIds: [seq] }, requestId)
    const later = repository.capture({ ...entry, id: "later" })
    repository.saveDraft(config, 0)
    expect(repository.publish(0, { mode: "selected", inputIds: [seq] }, requestId)).toEqual(release)
    expect(repository.inputs().find((row) => row.seq === later)?.releaseVersion).toBeNull()
    expect(repository.assign(seq).generation).toBe(2)
    expect(repository.releases()).toHaveLength(2)
    expect(() => repository.publish(0, { mode: "future" }, requestId)).toThrow("revision_conflict")
    expect(() =>
      repository.publish(1, { mode: "selected", inputIds: [999] }, randomUUID()),
    ).toThrow("invalid_target")
    expect(repository.releases()).toHaveLength(2)
  })

  it("发布预览与真实发布共用目标，并区分新分配、重算、旧队列和历史", () => {
    const { repository } = fixture()
    const queued = repository.capture({ ...entry, id: "queued" })
    const historical = repository.capture({ ...entry, id: "historical" })
    const recalculate = repository.capture({ ...entry, id: "recalculate" })
    repository.publish(0, { mode: "future" }, randomUUID())
    repository.complete(repository.assign(historical), decision("h".repeat(64)))
    const unassigned = repository.capture({ ...entry, id: "unassigned" })
    const scope = { mode: "selected" as const, inputIds: [recalculate, recalculate] }

    const preview = repository.previewPublication(scope)
    expect(preview).toEqual({
      scope: { mode: "selected", inputIds: [recalculate] },
      targetInputIds: [recalculate, unassigned],
      impact: {
        newAssignments: 1,
        recalculated: 1,
        queuedUnchanged: 1,
        historicalUnchanged: 1,
      },
    })
    expect(repository.publish(0, scope, randomUUID()).targetInputIds).toEqual(
      preview.targetInputIds,
    )
    expect(repository.assign(queued).releaseVersion).toBe(1)
  })

  it("原文变化产生新输入，阅读变化不会；旧内容决策只留历史", () => {
    const { repository, db } = fixture()
    const seq = repository.capture(entry)
    repository.publish(0, { mode: "future" }, randomUUID())
    const target = repository.assign(seq)
    expect(repository.capture({ ...entry, read: false })).toBe(seq)
    expect(repository.assign(seq).body.read).toBe(true)
    const newer = repository.capture({ ...entry, content: "修正后的原文" })
    expect(newer).toBeGreaterThan(seq)
    expect(repository.complete(target, { answer: "基于旧原文" }).published).toBe(false)
    expect(repository.inputs().map((row) => row.seq)).toEqual([newer])
    const newTarget = repository.assign(newer)
    const result = repository.complete(newTarget, { answer: "首次完成" })
    expect(repository.complete(newTarget, { answer: "重复完成" })).toEqual(result)
    expect(
      JSON.parse(
        String(db.prepare("SELECT body FROM entry_decisions WHERE id=?").get(result.id)?.body),
      ),
    ).toEqual({ answer: "首次完成" })
  })

  it("页面事务回滚时条目和摄取序号一同回滚", () => {
    const store = new Store(":memory:")
    close.push(() => store.close())
    store.bindOwner("owner")
    expect(() =>
      store.transaction(() => {
        store.saveEntry(entry)
        throw new Error("page_failed")
      }),
    ).toThrow("page_failed")
    expect(store.entry(entry.sourceKey, entry.id)).toBeNull()
    expect(store.automation.inputs()).toEqual([])
    store.saveEntry(entry)
    expect(store.automation.inputs()).toHaveLength(1)
  })
})

describe("事故输入指针恢复", () => {
  it("原文身份不变时原子恢复旧成功决策，并保持历史输入不可变", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-12T08:00:00.000Z"))
    const { repository, db } = fixture()
    const state = new ProcessingStateStore(db, repository)
    db.exec(
      "CREATE TABLE entries(source_key TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_key,id))",
    )
    const historicalSeq = repository.capture(entry)
    repository.publish(0, { mode: "future" }, randomUUID())
    const oldTarget = state.prepare(historicalSeq, {
      context: { title: entry.title, source_id: "f1", contextId: entry.sourceKey },
      provider: "qianwen",
      model: "qwen3.8-flash",
      sourceRole: "source",
      metadataVersion: 1,
    }).input
    const oldDecision = decision("a".repeat(64))
    state.saveCache(oldDecision)
    const oldResult = repository.complete(oldTarget, oldDecision)
    state.setMaterial(oldTarget, "complete")
    repository.capture({ ...entry, content: null })
    vi.setSystemTime(new Date("2026-09-12T09:00:00.000Z"))
    const currentSeq = repository.capture({ ...entry, read: false })
    const currentTarget = repository.assign(currentSeq)
    const currentResult = repository.complete(currentTarget, decision("b".repeat(64)))
    db.prepare("INSERT INTO entries VALUES(?,?,?)").run(
      entry.sourceKey,
      entry.id,
      JSON.stringify({ ...entry, read: false }),
    )
    const current = repository.current(entry.sourceKey, entry.id)!

    expect(
      repository.reconcileUnchangedInput(
        [
          {
            currentSeq,
            historicalSeq,
            sourceKey: entry.sourceKey,
            itemId: entry.id,
            contentVersion: oldTarget.contentVersion,
            expectedHistoricalStatus: "succeeded",
            expectedCurrentStatus: "succeeded",
            expectedReleaseVersion: oldTarget.releaseVersion!,
            expectedGeneration: oldTarget.generation,
            expectedDecisionId: oldResult.id,
            expectedCurrentDecisionId: currentResult.id,
            expectedSnapshotError: null,
            expectedCurrentReceivedAt: current.receivedAt,
          },
        ],
        {
          expectedCount: 1,
          minimumCurrentSeq: currentSeq,
          minimumCurrentReceivedAt: "2026-09-12T08:59:36.000Z",
          maximumHistoricalSeq: historicalSeq,
        },
      ),
    ).toEqual({ total: 1, succeeded: 1, failed: 0, pending: 0 })
    expect(repository.current(entry.sourceKey, entry.id)).toMatchObject({
      seq: historicalSeq,
      status: "succeeded",
      releaseVersion: oldTarget.releaseVersion,
      generation: oldTarget.generation,
      body: { read: true },
    })
    expect(
      db.prepare("SELECT current FROM processing_inputs WHERE seq=?").get(currentSeq)?.current,
    ).toBe(0)
    expect(db.prepare("SELECT count(*) AS n FROM entry_decisions").get()?.n).toBe(2)
    expect(JSON.parse(String(db.prepare("SELECT body FROM entries").get()?.body))).toMatchObject({
      read: false,
    })
  })

  it("白名单可恢复历史失败与显式重试状态，并保留原快照错误", () => {
    vi.useFakeTimers()
    const { repository, db } = fixture()
    const state = new ProcessingStateStore(db, repository)
    const makeHistorical = (id: string, status: "failed" | "pending") => {
      vi.setSystemTime(new Date("2026-09-12T08:00:00.000Z"))
      const source = { ...entry, id, url: `https://example.test/${id}` }
      const historicalSeq = repository.capture(source)
      repository.publish(0, { mode: "future" }, randomUUID())
      const historical = state.prepare(historicalSeq, {
        context: { title: source.title, source_id: "f1", contextId: source.sourceKey },
        provider: "qianwen",
        model: "qwen3.8-flash",
        sourceRole: "source",
        metadataVersion: 1,
      }).input
      state.start(historical)
      state.fail(historical, status === "failed" ? "codex_timeout" : "invalid_model_reference")
      if (status === "pending") state.retry(historicalSeq)
      state.setMaterial(historical, "complete")
      repository.capture({ ...source, content: null })
      vi.setSystemTime(new Date("2026-09-12T09:00:00.000Z"))
      const currentSeq = repository.capture({ ...source, read: false })
      return { historical, historicalSeq, currentSeq, source }
    }
    const failed = makeHistorical("failed", "failed")
    const pending = makeHistorical("pending", "pending")
    const manifest = [failed, pending].map((value, index) => {
      const current = repository.current(value.source.sourceKey, value.source.id)!
      return {
        currentSeq: value.currentSeq,
        historicalSeq: value.historicalSeq,
        sourceKey: value.source.sourceKey,
        itemId: value.source.id,
        contentVersion: value.historical.contentVersion,
        expectedHistoricalStatus: index === 0 ? ("failed" as const) : ("pending" as const),
        expectedCurrentStatus: "pending" as const,
        expectedReleaseVersion: value.historical.releaseVersion!,
        expectedGeneration: value.historical.generation,
        expectedDecisionId: null,
        expectedCurrentDecisionId: null,
        expectedSnapshotError: index === 0 ? "codex_timeout" : "invalid_model_reference",
        expectedCurrentReceivedAt: current.receivedAt,
      }
    })
    expect(
      repository.reconcileUnchangedInput(manifest, {
        expectedCount: 2,
        minimumCurrentSeq: Math.min(failed.currentSeq, pending.currentSeq),
        minimumCurrentReceivedAt: "2026-09-12T08:59:36.000Z",
        maximumHistoricalSeq: Math.max(failed.historicalSeq, pending.historicalSeq),
      }),
    ).toEqual({ total: 2, succeeded: 0, failed: 1, pending: 1 })
    expect(repository.current(entry.sourceKey, "failed")?.status).toBe("failed")
    expect(repository.current(entry.sourceKey, "pending")?.status).toBe("pending")
    expect(
      db
        .prepare("SELECT error FROM processing_target_snapshots WHERE input_seq=? AND generation=?")
        .get(failed.historicalSeq, failed.historical.generation)?.error,
    ).toBe("codex_timeout")
  })

  it("快照错误与固定清单不一致时整批回滚", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-12T08:00:00.000Z"))
    const { repository, db } = fixture()
    const state = new ProcessingStateStore(db, repository)
    const historicalSeq = repository.capture(entry)
    repository.publish(0, { mode: "future" }, randomUUID())
    const target = state.prepare(historicalSeq, {
      context: { title: entry.title, source_id: "f1", contextId: entry.sourceKey },
      provider: "qianwen",
      model: "qwen3.8-flash",
      sourceRole: "source",
      metadataVersion: 1,
    }).input
    state.start(target)
    state.fail(target, "codex_timeout")
    state.setMaterial(target, "complete")
    repository.capture({ ...entry, content: null })
    const validEntry = { ...entry, id: "valid", url: "https://example.test/valid" }
    const validHistoricalSeq = repository.capture(validEntry)
    const validTarget = state.prepare(validHistoricalSeq, {
      context: { title: validEntry.title, source_id: "f1", contextId: validEntry.sourceKey },
      provider: "qianwen",
      model: "qwen3.8-flash",
      sourceRole: "source",
      metadataVersion: 1,
    }).input
    state.start(validTarget)
    state.fail(validTarget, "codex_timeout")
    state.setMaterial(validTarget, "complete")
    repository.capture({ ...validEntry, content: null })
    vi.setSystemTime(new Date("2026-09-12T09:00:00.000Z"))
    const currentSeq = repository.capture({ ...entry, read: false })
    const validCurrentSeq = repository.capture({ ...validEntry, read: false })
    const current = repository.current(entry.sourceKey, entry.id)!
    const validCurrent = repository.current(validEntry.sourceKey, validEntry.id)!
    expect(() =>
      repository.reconcileUnchangedInput(
        [
          {
            currentSeq: validCurrentSeq,
            historicalSeq: validHistoricalSeq,
            sourceKey: validEntry.sourceKey,
            itemId: validEntry.id,
            contentVersion: validTarget.contentVersion,
            expectedHistoricalStatus: "failed",
            expectedCurrentStatus: "pending",
            expectedReleaseVersion: validTarget.releaseVersion!,
            expectedGeneration: validTarget.generation,
            expectedDecisionId: null,
            expectedCurrentDecisionId: null,
            expectedSnapshotError: "codex_timeout",
            expectedCurrentReceivedAt: validCurrent.receivedAt,
          },
          {
            currentSeq,
            historicalSeq,
            sourceKey: entry.sourceKey,
            itemId: entry.id,
            contentVersion: target.contentVersion,
            expectedHistoricalStatus: "failed",
            expectedCurrentStatus: "pending",
            expectedReleaseVersion: target.releaseVersion!,
            expectedGeneration: target.generation,
            expectedDecisionId: null,
            expectedCurrentDecisionId: null,
            expectedSnapshotError: "wrong_error",
            expectedCurrentReceivedAt: current.receivedAt,
          },
        ],
        {
          expectedCount: 2,
          minimumCurrentSeq: Math.min(currentSeq, validCurrentSeq),
          minimumCurrentReceivedAt: "2026-09-12T08:59:36.000Z",
          maximumHistoricalSeq: Math.max(historicalSeq, validHistoricalSeq),
        },
      ),
    ).toThrow("invalid_reconciliation")
    expect(repository.current(entry.sourceKey, entry.id)?.seq).toBe(currentSeq)
    expect(repository.current(validEntry.sourceKey, validEntry.id)?.seq).toBe(validCurrentSeq)
    expect(
      db.prepare("SELECT current FROM processing_inputs WHERE seq=?").get(historicalSeq)?.current,
    ).toBe(0)
  })
})

describe("规则编辑接口", () => {
  it("创建、完整重排与删除使用同一草稿并强制 revision", () => {
    const store = new Store(":memory:")
    close.push(() => store.close())
    store.bindOwner("owner")
    const rule = {
      name: "语义规则",
      enabled: true,
      when: { all: true },
      actions: [{ type: "ai_transform", prompt: "保留重要公告" }],
      executionLocation: "processing_service",
    }
    automationApi(store, "POST", "/rules", { expectedRevision: 0, rule })
    automationApi(store, "POST", "/rules", { expectedRevision: 1, rule })
    const ids = store.automation.draft().config.rules.map((item) => item.id)
    expect(() =>
      automationApi(store, "POST", "/rules/reorder", {
        expectedRevision: 2,
        ids: [ids[0], ids[0]],
      }),
    ).toThrow("invalid_rule_set")
    automationApi(store, "POST", "/rules/reorder", { expectedRevision: 2, ids: [...ids].reverse() })
    expect(store.automation.draft().config.rules.map((item) => item.id)).toEqual([...ids].reverse())
    expect(() =>
      automationApi(store, "DELETE", `/rules/${ids[0]}`, { expectedRevision: 2 }),
    ).toThrow("revision_conflict")
    automationApi(store, "DELETE", `/rules/${ids[0]}`, { expectedRevision: 3 })
    expect(store.automation.draft().config.rules).toHaveLength(1)
    expect(store.automation.releases()).toEqual([])
  })

  it("发布预览和历史版本接口只读返回影响与不可变配置", () => {
    const store = new Store(":memory:")
    close.push(() => store.close())
    store.bindOwner("owner")
    const seq = store.automation.capture(entry)
    expect(
      automationApi(store, "POST", "/rule-set-releases/preview", {
        scope: { mode: "future" },
      }),
    ).toEqual({
      scope: { mode: "future" },
      targetInputIds: [seq],
      impact: {
        newAssignments: 1,
        recalculated: 0,
        queuedUnchanged: 0,
        historicalUnchanged: 0,
      },
    })
    store.automation.saveDraft(config, 0)
    const release = store.automation.publish(1, { mode: "future" }, randomUUID())
    const publishedConfig = store.automation.draft().config
    store.automation.saveDraft({ ...config, global: { version: 2, markdown: "后来修改的草稿" } }, 1)

    expect(automationApi(store, "GET", `/rule-set-releases/${release.version}`, undefined)).toEqual(
      { release, config: publishedConfig },
    )
    expect(store.automation.draft().config.global.markdown).toBe("后来修改的草稿")
  })
})
