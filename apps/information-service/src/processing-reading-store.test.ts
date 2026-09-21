import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it } from "vitest"

import type { SourceEntry } from "./folo"
import { processingApi } from "./processing-api"
import type { ProcessingEntryRole } from "./processing-reading-store"
import { Store } from "./store"
import { sourceSpanFragmentId } from "./story-store"

const stores: Store[] = []
const source = {
  key: "feed/f1",
  kind: "feed" as const,
  id: "f1",
  title: "来源",
  view: 0,
  category: null,
}

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source])
  return store
}

function entry(id: string, publishedAt: string): SourceEntry {
  return {
    id,
    sourceKey: "feed/f1",
    title: `来源 ${id}`,
    url: `https://example.test/${id}`,
    publishedAt,
    read: false,
    content: `来源 ${id} 的可核查事实。`,
    description: null,
  }
}

function decision(input: SourceEntry, seq: number) {
  return {
    schemaVersion: 1,
    fingerprint: `fingerprint-${seq}`,
    provider: "codex" as const,
    model: "test-model",
    generatedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    usage: null,
    status: "keep" as const,
    title: input.title,
    summary: `摘要 ${seq}`,
    reason: "测试决定",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "reporting",
    context: { source_id: "f1", contextId: input.sourceKey },
    facts: [],
    semantic: null,
    reused: false,
  }
}

function publishInput(store: Store, input: SourceEntry, always = false) {
  store.saveEntry(input)
  const target = store.automation.assign(store.automation.inputs().at(-1)!.seq)
  const output = decision(input, target.seq)
  if (always) output.policy.standalone = "always"
  store.automation.complete(target, output)
  return target
}

function publishRelease(store: Store) {
  store.automation.publish(0, { mode: "future" }, randomUUID())
}

function publishDecision(
  store: Store,
  input: SourceEntry,
  options: {
    status?: "keep" | "hide" | "needs_context"
    standalone?: "auto" | "always" | "never"
    reason?: string
  } = {},
) {
  store.saveEntry(input)
  const target = store.automation.assign(store.automation.inputs().at(-1)!.seq)
  const base = decision(input, target.seq)
  store.automation.complete(target, {
    ...base,
    status: options.status ?? base.status,
    reason: options.reason ?? base.reason,
    policy: { ...base.policy, standalone: options.standalone ?? base.policy.standalone },
  })
  return target
}

function createAggregateStory(
  store: Store,
  members: Array<{ seq: number; itemId: string; contentVersion: string }>,
  title: string,
) {
  const spans = members.map((target) => ({
    id: `span-${target.seq}`,
    inputSeq: target.seq,
    sourceItemId: target.itemId,
    contentVersion: target.contentVersion,
    fragmentId: sourceSpanFragmentId(
      target.itemId,
      target.contentVersion,
      `来源 ${target.itemId} 的可核查事实。`,
    ),
    quote: `来源 ${target.itemId} 的可核查事实。`,
    sourceRole: "reporting",
  }))
  const storyId = randomUUID()
  store.stories.create(
    {
      title,
      body: `${title}的综述正文`,
      aggregationRuleId: "rule",
      aggregationScopeVersion: "scope",
      appliedRuleSetVersion: 1,
      instructionFingerprint: "instruction",
      members: members.map((target) => ({
        inputSeq: target.seq,
        decisionId: store.processingState
          .published()
          .find((value) => value.input.seq === target.seq)!.decisionId,
      })),
      sourceSpans: spans,
      citations: spans.map((span) => ({
        id: `citation-${span.inputSeq}`,
        sourceSpanId: span.id,
        sentenceId: `sentence-${span.inputSeq}`,
      })),
      sentences: spans.map((span) => ({
        id: `sentence-${span.inputSeq}`,
        text: `事实 ${span.inputSeq}`,
        citationIds: [`citation-${span.inputSeq}`],
      })),
      facts: [
        {
          id: "fact",
          kind: "fact",
          text: "来源支持的事实",
          citationIds: spans.map((span) => `citation-${span.inputSeq}`),
          dependsOnFactIds: [],
        },
      ],
    },
    storyId,
  )
  return storyId
}

function rolesOf(store: Store) {
  return (processingApi(store, "GET", "/processing/roles", {}) as { roles: ProcessingEntryRole[] })
    .roles
}

afterEach(() => stores.splice(0).forEach((store) => store.close()))

describe("时间线角色投影", () => {
  it("隐藏决定落成 hidden，always 例外与未处理输入都不产生角色", () => {
    const store = fixture()
    publishRelease(store)
    publishDecision(store, entry("kept", "2026-01-01T00:00:00.000Z"))
    const hidden = publishDecision(store, entry("hidden", "2026-01-02T00:00:00.000Z"), {
      status: "hide",
      reason: "娱乐内容",
    })
    const pinned = publishDecision(store, entry("pinned", "2026-01-03T00:00:00.000Z"), {
      status: "hide",
      standalone: "always",
    })
    publishDecision(store, entry("never", "2026-01-04T00:00:00.000Z"), { standalone: "never" })
    store.saveEntry(entry("pending", "2026-01-05T00:00:00.000Z"))
    expect(pinned.seq).toBeGreaterThan(hidden.seq)

    expect(rolesOf(store)).toEqual([
      {
        itemId: "hidden",
        inputSeq: hidden.seq,
        kind: "hidden",
        reason: "娱乐内容",
        relatedEntryIds: [],
        storyId: null,
        storyTitle: null,
      },
      {
        itemId: "never",
        inputSeq: 4,
        kind: "hidden",
        reason: "测试决定",
        relatedEntryIds: [],
        storyId: null,
        storyTitle: null,
      },
    ])
  })

  it("恢复覆盖让隐藏条目回到时间线，手动隐藏无需重新处理", () => {
    const store = fixture()
    publishRelease(store)
    const restored = publishDecision(store, entry("restored", "2026-01-01T00:00:00.000Z"), {
      status: "hide",
    })
    const forced = publishDecision(store, entry("forced", "2026-01-02T00:00:00.000Z"))
    store.processingState.setOverride(restored.seq, "restore", 0)
    store.processingState.setOverride(forced.seq, "hide", 0)

    expect(rolesOf(store)).toEqual([expect.objectContaining({ itemId: "forced", kind: "hidden" })])
  })

  it("综述按最新成员代表整篇，其余成员与同内容转载都并入它", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const post = "1900000000000000001"
    const first = publishDecision(store, {
      ...entry(`x:${post}`, "2026-01-01T00:00:00.000Z"),
      url: `https://x.com/u/status/${post}`,
    })
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const repost = publishDecision(store, {
      ...entry(`x:${post}`, "2026-01-03T00:00:00.000Z"),
      sourceKey: otherSource.key,
      url: `https://x.com/u/status/${post}`,
    })
    const storyId = createAggregateStory(store, [first, second], "同事件综述")

    expect(rolesOf(store)).toEqual([
      {
        itemId: `x:${post}`,
        inputSeq: first.seq,
        kind: "merged",
        reason: "同事件综述",
        relatedEntryIds: ["two"],
        storyId,
        storyTitle: "同事件综述",
      },
      {
        itemId: "two",
        inputSeq: second.seq,
        kind: "story",
        reason: "同事件综述",
        relatedEntryIds: [`x:${post}`],
        storyId,
        storyTitle: "同事件综述",
      },
      {
        itemId: `x:${post}`,
        inputSeq: repost.seq,
        kind: "merged",
        reason: "同事件综述",
        relatedEntryIds: ["two"],
        storyId,
        storyTitle: "同事件综述",
      },
    ])
  })

  it("成员全部被隐藏时不再产生综述角色", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishDecision(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const storyId = createAggregateStory(store, [first, second], "同事件综述")
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "one", kind: "merged", storyId }),
      expect.objectContaining({ itemId: "two", kind: "story", storyId }),
    ])

    store.processingState.setOverride(first.seq, "hide", 0)
    store.processingState.setOverride(second.seq, "hide", 0)
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "one", kind: "hidden", storyId: null }),
      expect.objectContaining({ itemId: "two", kind: "hidden", storyId: null }),
    ])
  })
})

describe("稳定阅读快照", () => {
  it("从固定成员汇总独立项、隐藏、待处理和失败，并单列当前来源状态", () => {
    const store = fixture()
    publishRelease(store)
    const readyTarget = publishInput(store, entry("ready", "2026-01-01T00:00:00.000Z"))
    const hidden = entry("hidden", "2026-01-02T00:00:00.000Z")
    store.saveEntry(hidden)
    const hiddenTarget = store.automation.assign(store.automation.inputs().at(-1)!.seq)
    store.automation.complete(hiddenTarget, {
      ...decision(hidden, hiddenTarget.seq),
      status: "hide",
    })
    store.saveEntry(entry("pending", "2026-01-03T00:00:00.000Z"))
    const pendingTarget = store.automation.inputs().at(-1)!
    store.saveEntry(entry("failed", "2026-01-04T00:00:00.000Z"))
    const failedTarget = store.automation.assign(store.automation.inputs().at(-1)!.seq)
    store.processingState.fail(failedTarget, "model_failed")
    store.schedule.save(
      {
        sourceKeys: [source.key],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: true,
        times: ["08:00"],
      },
      0,
    )
    const trigger = store.schedule.manual(randomUUID(), "2026-01-04T00:00:00.000Z")
    store.processingState.report(trigger.id, {
      sources: [{ sourceKey: source.key, pages: 1, entries: 4, coverage: "budget", failure: null }],
      finishedAt: "2026-01-04T00:01:00.000Z",
    })

    expect(processingApi(store, "GET", "/reading-snapshot", {})).toMatchObject({
      counts: { standalone: 3, stories: 0, hidden: 1, pending: 1, failed: 1 },
      processing: {
        runStatus: "pending",
        sourceTotal: 1,
        incompleteSources: 1,
        sourceStatusAt: "2026-01-04T00:01:00.000Z",
      },
      schedule: { enabled: true, timeZone: "Asia/Shanghai" },
    })
    const snapshot = store.reading.snapshot()
    expect(store.reading.page({ snapshotId: snapshot.id })).toMatchObject({
      view: "smart",
      total: 1,
      items: [{ kind: "entry", state: "ready", inputSeq: readyTarget.seq }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "pending" })).toMatchObject({
      total: 1,
      items: [{ kind: "entry", state: "pending", inputSeq: pendingTarget.seq }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "failed" })).toMatchObject({
      total: 1,
      items: [{ kind: "entry", state: "pending", inputSeq: failedTarget.seq, status: "failed" }],
    })
  })

  it("待处理输入占位并计入总数，晚到决定只能在刷新后进入可读状态", () => {
    const store = fixture()
    publishRelease(store)
    const input = entry("pending", "2026-01-01T00:00:00.000Z")
    store.saveEntry(input)
    const target = store.automation.inputs()[0]!
    const snapshot = store.reading.snapshot()
    expect(store.reading.page({ snapshotId: snapshot.id })).toMatchObject({
      view: "smart",
      total: 0,
      items: [],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "pending" })).toMatchObject({
      total: 1,
      items: [{ ordinal: 0, inputSeq: target.seq, state: "pending" }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "all" })).toMatchObject({
      total: 1,
      items: [
        {
          kind: "entry",
          state: "pending",
          inputSeq: target.seq,
          status: "pending",
          decision: null,
        },
      ],
    })
    const assigned = store.automation.assign(target.seq)
    store.automation.complete(assigned, decision(input, assigned.seq))
    expect(store.reading.page({ snapshotId: snapshot.id, view: "all" })).toMatchObject({
      snapshot: { latestAvailable: true },
      items: [{ kind: "entry", state: "pending", decision: null }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "pending" })).toMatchObject({
      snapshot: { latestAvailable: true },
      total: 1,
      items: [{ ordinal: 0, inputSeq: target.seq, state: "pending" }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id })).toMatchObject({ total: 0, items: [] })
    const refreshed = store.reading.refresh()
    expect(store.reading.page({ snapshotId: refreshed.id })).toMatchObject({
      view: "smart",
      total: 1,
      items: [{ kind: "entry", state: "ready", inputSeq: target.seq }],
    })
    expect(store.reading.page({ snapshotId: refreshed.id, view: "all" }).items).toEqual([
      expect.objectContaining({ kind: "entry", state: "ready", inputSeq: target.seq }),
    ])
  })

  it("首次固定顺序与总数，迟到发布只报告可刷新而不跳位", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const snapshot = processingApi(store, "GET", "/reading-snapshot", {}) as {
      snapshot: { id: string; maxSeq: number; latestAvailable: boolean }
    }
    const original = processingApi(store, "POST", "/reading-snapshot", {
      snapshotId: snapshot.snapshot.id,
      view: "all",
      offset: 0,
      limit: 50,
    }) as { total: number; items: Array<{ inputSeq: number }> }
    expect(original).toMatchObject({ total: 1, items: [{ inputSeq: first.seq }] })

    publishInput(store, entry("late", "2026-01-02T00:00:00.000Z"))
    const stable = processingApi(store, "POST", "/reading-snapshot", {
      snapshotId: snapshot.snapshot.id,
      view: "all",
    }) as {
      snapshot: { latestAvailable: boolean }
      total: number
      items: Array<{ inputSeq: number }>
    }
    expect(stable).toMatchObject({
      snapshot: { latestAvailable: true },
      total: 1,
      items: [{ inputSeq: first.seq }],
    })
    expect(processingApi(store, "POST", "/reading-snapshot/refresh", {})).toMatchObject({
      snapshot: { latestAvailable: false, maxSeq: 2 },
    })
  })

  it("新快照遵循保存的来源和历史边界，计划变化不改旧快照成员", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const before = entry("before", "2026-01-01T23:59:59.999Z")
    const boundary = entry("boundary", "2026-01-02T00:00:00.000Z")
    const after = entry("after", "2026-01-03T00:00:00.000Z")
    const outside = {
      ...entry("outside", "2026-01-03T00:00:00.000Z"),
      sourceKey: otherSource.key,
    }
    for (const item of [before, boundary, after, outside]) store.saveEntry(item)
    store.schedule.save(
      {
        sourceKeys: [source.key],
        historySince: "2026-01-02T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: false,
      },
      0,
    )

    const scoped = store.reading.refresh()
    expect(
      store.reading
        .page({ snapshotId: scoped.id, view: "all" })
        .items.flatMap((item) => (item.kind === "entry" ? [item.inputSeq] : [])),
    ).toEqual([3, 2])

    store.schedule.save(
      {
        sourceKeys: [source.key, otherSource.key],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: false,
      },
      1,
    )
    expect(
      store.reading
        .page({ snapshotId: scoped.id, view: "all" })
        .items.flatMap((item) => (item.kind === "entry" ? [item.inputSeq] : [])),
    ).toEqual([3, 2])
    expect(store.reading.page({ snapshotId: store.reading.refresh().id, view: "all" }).total).toBe(
      4,
    )
  })

  it("正文版本变化后旧决定显示 repairing，不返回旧摘要", () => {
    const store = fixture()
    publishRelease(store)
    const original = entry("one", "2026-01-01T00:00:00.000Z")
    const target = publishInput(store, original)
    const snapshot = store.reading.snapshot()
    store.saveEntry({ ...original, content: "来源 one 的更新正文。" })

    const page = store.reading.page({ snapshotId: snapshot.id, view: "all" })
    expect(page.items).toEqual([
      expect.objectContaining({ kind: "entry", state: "repairing", inputSeq: target.seq }),
    ])
    expect(JSON.stringify(page.items)).not.toContain("摘要")
  })

  it("材料撤回立即让 Story 快照和本地研究包停止提供旧正文", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"), true)
    const second = publishInput(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const storyId = randomUUID()
    const members = [first, second]
    const spans = members.map((target) => ({
      id: `span-${target.seq}`,
      inputSeq: target.seq,
      sourceItemId: target.itemId,
      contentVersion: target.contentVersion,
      fragmentId: sourceSpanFragmentId(
        target.itemId,
        target.contentVersion,
        `来源 ${target.itemId} 的可核查事实。`,
      ),
      quote: `来源 ${target.itemId} 的可核查事实。`,
      sourceRole: "reporting",
    }))
    store.stories.create(
      {
        title: "事件综述",
        body: "可读取的综述正文",
        aggregationRuleId: "rule",
        aggregationScopeVersion: "scope",
        appliedRuleSetVersion: 1,
        instructionFingerprint: "instruction",
        members: members.map((target) => ({
          inputSeq: target.seq,
          decisionId: store.processingState
            .published()
            .find((value) => value.input.seq === target.seq)!.decisionId,
        })),
        sourceSpans: spans,
        citations: spans.map((span) => ({
          id: `citation-${span.inputSeq}`,
          sourceSpanId: span.id,
          sentenceId: `sentence-${span.inputSeq}`,
        })),
        sentences: spans.map((span) => ({
          id: `sentence-${span.inputSeq}`,
          text: `事实 ${span.inputSeq}`,
          citationIds: [`citation-${span.inputSeq}`],
        })),
        facts: [
          {
            id: "fact",
            kind: "fact",
            text: "来源支持的事实",
            citationIds: spans.map((span) => `citation-${span.inputSeq}`),
            dependsOnFactIds: [],
          },
        ],
      },
      storyId,
    )
    const snapshot = store.reading.refresh()
    expect(store.reading.page({ snapshotId: snapshot.id, view: "stories" }).items).toEqual([
      expect.objectContaining({ kind: "story", state: "ready", body: "可读取的综述正文" }),
    ])
    // 明确保留原始公告时，即使已生成 Story，也继续提供独立入口。
    expect(store.reading.page({ snapshotId: snapshot.id, view: "standalone" }).items).toEqual([
      expect.objectContaining({ kind: "entry", inputSeq: first.seq }),
    ])
    expect(store.reading.page({ snapshotId: snapshot.id, view: "smart" }).items).toEqual([
      expect.objectContaining({
        kind: "story",
        state: "ready",
        story: expect.objectContaining({ id: storyId }),
      }),
      expect.objectContaining({ kind: "entry", state: "ready", inputSeq: first.seq }),
    ])
    const researchPack = processingApi(store, "GET", `/research-pack/${storyId}`, {}) as {
      references: unknown[]
    }
    expect(researchPack).toMatchObject({
      status: "ready",
      storyId,
      revision: 1,
      title: "事件综述",
      markdown: expect.stringContaining("## 来源"),
    })
    expect(researchPack.references).toEqual(
      expect.arrayContaining([expect.objectContaining({ inputSeq: first.seq })]),
    )
    store.stories.withdrawMaterial(first.seq, "原始材料撤回")
    const page = store.reading.page({ snapshotId: snapshot.id, view: "stories" })
    expect(page.items).toEqual([
      expect.objectContaining({ kind: "story", state: "repairing", storyId }),
    ])
    expect(JSON.stringify(page.items)).not.toContain("可读取的综述正文")
    expect(store.reading.researchPack(storyId)).toEqual({
      status: "repairing",
      storyId,
      revision: null,
      title: null,
      markdown: null,
      references: [],
    })
  })
})
