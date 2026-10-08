import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProcessingInput } from "./automation-store"
import { AutomationStore } from "./automation-store"
import type { ProcessingDecision } from "./processing-decision"
import type { EventIdentity } from "./processing-event"
import type { EventMention } from "./processing-event-mentions"
import type { EventCorrection, EventScope } from "./processing-event-registry"
import { ProcessingEventRegistry } from "./processing-event-registry"

const databases: DatabaseSync[] = []
const directories: string[] = []
const scope: EventScope = { activeSources: new Set(["feed/1", "feed/2"]) }
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  vi.useRealTimers()
})
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path)
  databases.push(db)
  let owner: string | null = "owner"
  const automation = new AutomationStore(db, () => owner)
  if (!automation.releases().length) automation.publish(0, { mode: "future" }, randomUUID())
  const registry = new ProcessingEventRegistry(db, automation, () => owner)
  return {
    db,
    automation,
    registry,
    setOwner: (value: string | null) => {
      owner = value
    },
  }
}
const quote = "OpenAI 发布 GPT 5.2，公告 https://official.test/releases/gpt-5-2 。"
function identity(extra: Partial<EventIdentity> = {}, text = quote): EventIdentity {
  return {
    kind: "event",
    subject: { value: "OpenAI", quote: text },
    action: { value: "product_release", quote: text },
    object: { value: "GPT", quote: text },
    version: { value: "5.2", quote: text },
    round: null,
    anchor: {
      kind: "official_reference",
      value: "https://official.test/releases/gpt-5-2",
      quote: text,
    },
    ...extra,
  }
}
function output(
  input: ProcessingInput,
  event: EventIdentity | null,
  eventMentions?: EventMention[],
): ProcessingDecision {
  return {
    schemaVersion: 2,
    fingerprint: `event-${input.seq}`,
    provider: "qianwen",
    model: "test",
    generatedAt: "2026-10-06T00:00:00Z",
    durationMs: 1,
    usage: null,
    status: "keep",
    title: input.body.title,
    summary: "摘要",
    reason: "有事件证据",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "source",
    context: { source_id: input.sourceKey, contextId: input.sourceKey },
    facts: [],
    reused: false,
    semantic: {
      entryId: input.itemId,
      title: input.body.title,
      summary: "摘要",
      disposition: "keep",
      reason: "有事件证据",
      aggregation: true,
      rewrite: true,
      labels: [],
      facts: [],
      event,
      ...(eventMentions === undefined ? {} : { eventMentions }),
    },
  }
}
function save(
  f: ReturnType<typeof fixture>,
  id: string,
  event = identity(),
  extra: {
    sourceKey?: string
    text?: string
    title?: string
    day?: number
    mentions?: EventMention[]
  } = {},
) {
  const sourceKey = extra.sourceKey ?? "feed/1"
  const seq = f.automation.capture({
    id,
    sourceKey,
    title: extra.title ?? id,
    content: extra.text ?? quote,
    description: null,
    read: false,
    url: null,
    publishedAt: `2026-10-${String(extra.day ?? 1).padStart(2, "0")}T00:00:00Z`,
  })
  const input = f.automation.assign(seq)
  const decision = output(input, event, extra.mentions)
  const completion = f.automation.complete(input, decision)
  const publication = f.registry.publish(input, decision, completion.id)
  return {
    input,
    decision,
    decisionId: completion.id,
    publication,
    events: f.registry.entryEvents(input),
    eventId: f.registry.entryEvents(input)[0]?.event.id,
  }
}
function revisions(f: ReturnType<typeof fixture>, ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, f.registry.queryEvent(id, scope)!.event.revision]))
}
function correct(f: ReturnType<typeof fixture>, action: EventCorrection["action"], ids: string[]) {
  return f.registry.correct(
    { requestId: randomUUID(), expectedRevisions: revisions(f, ids), action },
    scope,
  )
}

// 真实 SQLite 验证事件登记、关系纠错和快照；所有模型结果均为本地固定样本。
describe("同账号事件登记与关系纠错", () => {
  it("单篇成员读取通过 SQL 主键范围定位，仍核验当前决定指针", () => {
    const f = fixture()
    const first = save(f, "first")
    save(f, "second")
    const prepare = vi.spyOn(f.db, "prepare")
    expect(f.registry.entryEvents(first.input)).toMatchObject([
      { event: { id: first.eventId }, membership: first.events[0]!.membership },
    ])
    const query = prepare.mock.calls.find(([sql]) => sql.includes("SELECT members.body"))?.[0]
    expect(query).toContain("WHERE members.input_seq IN (?)")
    expect(query).toContain("current.content_version=members.content_version")
    expect(query).toContain("current.decision_id=members.decision_id")
    prepare.mockRestore()
    f.automation.capture({ ...first.input.body, content: "正文已更新" })
    expect(f.registry.entryEvents(first.input)).toEqual([])
  })

  it("单篇旧 event 可登记，重发只读取当前不可变结果且不重复修订", () => {
    const f = fixture()
    const first = save(f, "原始公告")
    expect(first.eventId).toMatch(/^evt_/u)
    expect(first.events[0]).toMatchObject({
      event: { title: "原始公告", status: "confirmed" },
      membership: {
        mentionId: "M1",
        role: "reports",
        isPrimary: true,
        state: "confirmed",
        origin: "automatic",
        evidence: [quote],
      },
    })
    const initial = f.registry.queryEvent(first.eventId!, scope)!.event
    const forged = output(first.input, identity({ version: { value: "9.0", quote } }))
    f.registry.publish(first.input, forged, first.decisionId)
    expect(f.registry.queryEvent(first.eventId!, scope)!.event).toEqual(initial)
    expect(
      f.registry.confirmedEventIdsForMembers([
        { inputSeq: first.input.seq, decisionId: first.decisionId },
      ]),
    ).toEqual([first.eventId])
  })
  it("幂等同步定向查关系，证据核验使用已保存原始材料且不接受来源身份伪装", () => {
    const f = fixture()
    const seq = f.automation.capture({
      id: "canonical",
      sourceKey: "feed/1",
      title: "原公告",
      content: quote,
      description: null,
      read: false,
      url: null,
      publishedAt: "2026-10-06T00:00:00Z",
    })
    const input = f.automation.assign(seq)
    const decision = output(input, identity())
    const completed = f.automation.complete(input, decision)
    f.registry.publish(
      { ...input, body: { ...input.body, content: "调用方传来的伪造材料" } },
      decision,
      completed.id,
    )
    const registered = f.registry.entryEvents(input)
    expect(registered[0]?.membership.state).toBe("confirmed")
    const entryEvents = vi.spyOn(f.registry, "entryEvents")
    expect(f.registry.publish(input, decision, completed.id).eventIds).toEqual([
      registered[0]!.event.id,
    ])
    expect(entryEvents).not.toHaveBeenCalled()
    expect(
      f.registry.publish({ ...input, sourceKey: "feed/forged" }, decision, completed.id).eventIds,
    ).toEqual([])
  })

  it("跨来源、跨语言标题通过原文实体与同一官方引用归组，后续标题仅作别名", () => {
    const f = fixture()
    const first = save(f, "中文报道", identity(), { title: "GPT 新版发布" })
    const english = "OpenAI released GPT 5.2. Official: https://official.test/releases/gpt-5-2 ."
    const second = save(f, "English report", identity({}, english), {
      sourceKey: "feed/2",
      text: english,
      title: "A new model arrives",
    })
    expect(second.eventId).toBe(first.eventId)
    expect(f.registry.queryEvent(first.eventId!, scope)!.event).toMatchObject({
      title: "GPT 新版发布",
      aliases: ["A new model arrives"],
    })
    expect(f.registry.queryMembers({ eventId: first.eventId! }, scope).total).toBe(2)
    expect(
      f.registry.confirmedEventIdsForMembers(
        [first, second].map((item) => ({ inputSeq: item.input.seq, decisionId: item.decisionId })),
      ),
    ).toEqual([first.eventId])
  })
  it("同主题不同版本、动作或官方引用分别登记，不能靠共享标题合并", () => {
    const f = fixture()
    const first = save(f, "base")
    const versionQuote = quote.replaceAll("5.2", "5.3").replaceAll("gpt-5-2", "gpt-5-3")
    const version = save(
      f,
      "version",
      identity(
        {
          version: { value: "5.3", quote: versionQuote },
          anchor: {
            kind: "official_reference",
            value: "https://official.test/releases/gpt-5-3",
            quote: versionQuote,
          },
        },
        versionQuote,
      ),
      { text: versionQuote },
    )
    const action = save(f, "action", identity({ action: { value: "announcement", quote } }))
    const referenceQuote = quote.replace("gpt-5-2", "second-notice")
    const reference = save(
      f,
      "reference",
      identity(
        {
          anchor: {
            kind: "official_reference",
            value: "https://official.test/releases/second-notice",
            quote: referenceQuote,
          },
        },
        referenceQuote,
      ),
      { text: referenceQuote },
    )
    expect(new Set([first.eventId, version.eventId, action.eventId, reference.eventId]).size).toBe(
      4,
    )
  })
  it("未知版本的首篇不能桥接后续冲突版本，归组逐一核验全部当前已确认成员", () => {
    const f = fixture()
    const reference = "https://official.test/launch"
    const unknownQuote = `OpenAI 发布 GPT，新版公告 ${reference} 。`
    const knownQuote = (version: string) => `OpenAI 发布 GPT ${version}，公告 ${reference} 。`
    const unknown = save(
      f,
      "unknown-version",
      identity(
        {
          version: null,
          anchor: { kind: "official_reference", value: reference, quote: unknownQuote },
        },
        unknownQuote,
      ),
      { text: unknownQuote },
    )
    const secondQuote = knownQuote("2.0")
    const second = save(
      f,
      "v2",
      identity(
        {
          version: { value: "2.0", quote: secondQuote },
          anchor: { kind: "official_reference", value: reference, quote: secondQuote },
        },
        secondQuote,
      ),
      { text: secondQuote },
    )
    const thirdQuote = knownQuote("3.0")
    const third = save(
      f,
      "v3",
      identity(
        {
          version: { value: "3.0", quote: thirdQuote },
          anchor: { kind: "official_reference", value: reference, quote: thirdQuote },
        },
        thirdQuote,
      ),
      { text: thirdQuote },
    )
    expect(second.eventId).toBe(unknown.eventId)
    expect(third.eventId).not.toBe(unknown.eventId)
    expect(f.registry.queryMembers({ eventId: unknown.eventId! }, scope).total).toBe(2)
    const isolated = fixture()
    const unknownIdentity = identity(
      {
        version: null,
        anchor: { kind: "official_reference", value: reference, quote: unknownQuote },
      },
      unknownQuote,
    )
    const secondIdentity = identity(
      {
        version: { value: "2.0", quote: secondQuote },
        anchor: { kind: "official_reference", value: reference, quote: secondQuote },
      },
      secondQuote,
    )
    const thirdIdentity = identity(
      {
        version: { value: "3.0", quote: thirdQuote },
        anchor: { kind: "official_reference", value: reference, quote: thirdQuote },
      },
      thirdQuote,
    )
    const sameArticle = save(isolated, "three-mentions", unknownIdentity, {
      text: [unknownQuote, secondQuote, thirdQuote].join("\n"),
      mentions: [
        { identity: unknownIdentity, role: "reports", isPrimary: true },
        { identity: secondIdentity, role: "mentions", isPrimary: false },
        { identity: thirdIdentity, role: "mentions", isPrimary: false },
      ],
    })
    expect(sameArticle.events[0]?.event.id).toBe(sameArticle.events[1]?.event.id)
    expect(sameArticle.events[2]?.event.id).not.toBe(sameArticle.events[0]?.event.id)
  })

  it("分析、教程指向可追溯底层事件，同事件仍保留各自阅读角色", () => {
    const f = fixture()
    const first = save(f, "report")
    const analysis = save(f, "analysis", identity({ kind: "analysis" }), { title: "深入分析" })
    const tutorial = save(f, "tutorial", identity({ kind: "tutorial" }), { title: "配置教程" })
    expect([analysis.eventId, tutorial.eventId]).toEqual([first.eventId, first.eventId])
    expect(analysis.events[0]?.membership.role).toBe("analysis_of")
    expect(tutorial.events[0]?.membership.role).toBe("tutorial_for")
    expect(
      f.registry
        .queryMembers({ eventId: first.eventId!, role: "tutorial_for" }, scope)
        .rows.map((item) => item.itemId),
    ).toEqual(["tutorial"])
    expect(
      f.registry.confirmedEventIdsForMembers([
        { inputSeq: analysis.input.seq, decisionId: analysis.decisionId },
      ]),
    ).toEqual([])
  })
  it("身份材料不足或官方引用未在原始 URL 中出现只能为候选，不参与 Story", () => {
    const f = fixture()
    const candidate = save(f, "candidate", identity({ version: null, anchor: null }))
    expect(candidate.events[0]?.membership.state).toBe("candidate")
    // 引用值在 quote 中虽然看似出现，转义属性里的假 URL 不能作为实际官方 href。
    const invented = "OpenAI 发布 GPT 5.2，引用 official.test，不含完整官方 URL。"
    const missing = save(
      f,
      "missing-reference",
      identity(
        {
          anchor: {
            kind: "official_reference",
            value: "https://official.test/unknown",
            quote: invented,
          },
        },
        invented,
      ),
      { text: invented },
    )
    expect(missing.events[0]?.event.status).toBe("candidate")
    expect(
      f.registry.confirmedEventIdsForMembers([
        { inputSeq: candidate.input.seq, decisionId: candidate.decisionId },
      ]),
    ).toEqual([])
    const untraceable = save(f, "wrong-quote", identity({}, "不在原文的证据"))
    expect(untraceable.events).toEqual([])
  })
  it("一篇多事件最多四项，关系独立且提及顺序变化仍保持 mentionId", () => {
    const f = fixture()
    const otherQuote = quote.replaceAll("5.2", "5.3").replaceAll("gpt-5-2", "gpt-5-3")
    const firstIdentity = identity()
    const secondIdentity = identity(
      {
        version: { value: "5.3", quote: otherQuote },
        anchor: {
          kind: "official_reference",
          value: "https://official.test/releases/gpt-5-3",
          quote: otherQuote,
        },
      },
      otherQuote,
    )
    const first = save(f, "multi", firstIdentity, {
      text: `${quote}\n${otherQuote}`,
      mentions: [
        { identity: firstIdentity, role: "reports", isPrimary: true },
        { identity: secondIdentity, role: "mentions", isPrimary: false },
      ],
    })
    expect(first.events).toHaveLength(2)
    expect(first.events.map((item) => item.membership.mentionId)).toEqual(["M1", "M2"])
    expect(
      f.registry.confirmedEventIdsForMembers([
        { inputSeq: first.input.seq, decisionId: first.decisionId },
      ]),
    ).toEqual([first.events.find((item) => item.membership.isPrimary)!.event.id])
    const changed = output(first.input, secondIdentity, [
      { identity: secondIdentity, role: "reports", isPrimary: true },
      { identity: firstIdentity, role: "mentions", isPrimary: false },
    ])
    const recalculated = f.automation.recalculate(first.input, changed)
    f.registry.publish(recalculated.input, changed, recalculated.id)
    const mentions = f.registry.entryEvents(recalculated.input)
    expect(
      mentions.find((item) => item.event.identity.version?.value === "5.2")?.membership.mentionId,
    ).toBe("M1")
    expect(
      mentions.find((item) => item.event.identity.version?.value === "5.3")?.membership.mentionId,
    ).toBe("M2")
  })
  it("源范围和撤回先于计数分页，newest 按文章发布时间而非摄取顺序", () => {
    const f = fixture()
    const newest = save(f, "newest", identity(), { day: 5 })
    save(f, "oldest", identity(), { day: 1 })
    const outside = save(f, "outside", identity(), { sourceKey: "feed/2", day: 6 })
    const result = f.registry.queryMembers(
      { eventId: newest.eventId!, limit: 1 },
      { activeSources: new Set(["feed/1"]) },
    )
    expect(result.total).toBe(2)
    expect(result.rows[0]).toMatchObject({
      itemId: "newest",
      title: "newest",
      publishedAt: "2026-10-05T00:00:00Z",
    })
    const allSnapshot = f.registry.queryMembers({ eventId: newest.eventId! }, scope)
    expect(() =>
      f.registry.queryMembers(
        { eventId: newest.eventId!, snapshotId: allSnapshot.snapshotId },
        { ...scope, excludedInputSeqs: new Set([outside.input.seq]) },
      ),
    ).toThrow("revision_conflict")
    expect(
      f.registry.queryMembers(
        { eventId: newest.eventId!, snapshotId: result.snapshotId, offset: 1, limit: 1 },
        { activeSources: new Set(["feed/1"]) },
      ).rows[0]?.itemId,
    ).toBe("oldest")
    expect(() =>
      f.registry.queryMembers({ eventId: newest.eventId!, snapshotId: result.snapshotId }, scope),
    ).toThrow("revision_conflict")
    expect(
      f.registry.queryMembers(
        { eventId: newest.eventId! },
        { ...scope, excludedInputSeqs: new Set([newest.input.seq, outside.input.seq]) },
      ).total,
    ).toBe(1)
    expect(() => f.registry.queryEvent(newest.eventId!, { activeSources: new Set() })).toThrow(
      "invalid_target",
    )
  })
  it("正文或代际更新使旧成员和事件快照失效，即使事件修订号未变", () => {
    const f = fixture()
    const first = save(f, "snapshot-first")
    const second = save(f, "snapshot-second")
    const members = f.registry.queryMembers({ eventId: first.eventId! }, scope)
    const events = f.registry.queryEvents({}, scope)
    const revision = f.registry.queryEvent(first.eventId!, scope)!.event.revision
    f.automation.capture({ ...second.input.body, content: "更新正文，尚未发布新的处理结果" })
    expect(f.registry.queryEvent(first.eventId!, scope)!.event.revision).toBe(revision)
    expect(() =>
      f.registry.queryMembers({ eventId: first.eventId!, snapshotId: members.snapshotId }, scope),
    ).toThrow("revision_conflict")
    expect(() => f.registry.queryEvents({ snapshotId: events.snapshotId }, scope)).toThrow(
      "revision_conflict",
    )
    expect(f.registry.queryMembers({ eventId: first.eventId! }, scope).total).toBe(1)
    const refreshedEvents = f.registry.queryEvents({}, scope)
    f.automation.recalculate(first.input, first.decision)
    expect(() => f.registry.queryEvents({ snapshotId: refreshedEvents.snapshotId }, scope)).toThrow(
      "revision_conflict",
    )
    expect(f.registry.queryEvents({}, scope).total).toBe(0)
  })
  it("新版本和陈旧发布指针不冒充当前事件，未绑定账号拒绝查询和纠错", () => {
    const f = fixture()
    const first = save(f, "stale")
    const newDecision = output(first.input, identity({ action: { value: "announcement", quote } }))
    const current = f.automation.recalculate(first.input, newDecision)
    f.registry.publish(first.input, first.decision, first.decisionId)
    expect(f.registry.entryEvents(current.input)).toEqual([])
    f.registry.publish(current.input, newDecision, current.id)
    expect(f.registry.entryEvents(current.input)[0]?.event.identity.action.value).toBe(
      "announcement",
    )
    f.automation.capture({ ...first.input.body, content: "完全不同的新版本" })
    expect(f.registry.entryEvents(first.input)).toEqual([])
    f.setOwner(null)
    expect(() => f.registry.queryEvents({}, scope)).toThrow("owner_required")
    expect(() =>
      f.registry.correct(
        {
          requestId: randomUUID(),
          expectedRevisions: {},
          action: { type: "rename", eventId: first.eventId!, title: "新名称" },
        },
        scope,
      ),
    ).toThrow("owner_required")
  })
  it("移出保存人工覆盖并使旧分页失效，同材料重跑不会复活关系", () => {
    const f = fixture()
    const first = save(f, "exclude")
    const before = f.registry.queryMembers({ eventId: first.eventId! }, scope)
    const request = {
      requestId: randomUUID(),
      expectedRevisions: revisions(f, [first.eventId!]),
      action: {
        type: "remove" as const,
        eventId: first.eventId!,
        inputSeq: first.input.seq,
        mentionId: "M1",
      },
    }
    const removed = f.registry.correct(request, scope)
    expect(removed.affectedInputSeqs).toEqual([first.input.seq])
    expect(f.registry.correct(request, scope)).toEqual(removed)
    expect(() =>
      f.registry.queryMembers({ eventId: first.eventId!, snapshotId: before.snapshotId }, scope),
    ).toThrow("revision_conflict")
    expect(f.registry.queryMembers({ eventId: first.eventId! }, scope).total).toBe(0)
    expect(
      f.registry.queryMembers({ eventId: first.eventId!, state: "excluded" }, scope).rows[0]
        ?.origin,
    ).toBe("manual")
    const rerun = f.automation.recalculate(first.input, first.decision)
    f.registry.publish(rerun.input, first.decision, rerun.id)
    expect(f.registry.entryEvents(rerun.input)[0]?.membership).toMatchObject({
      state: "excluded",
      origin: "manual",
      eventId: first.eventId,
    })
    expect(
      f.registry.confirmedEventIdsForMembers([{ inputSeq: rerun.input.seq, decisionId: rerun.id }]),
    ).toEqual([])
  })
  it("人工排除后的同正文身份漂移保留独立候选，重复重跑不能重新归组", () => {
    const f = fixture()
    const first = save(f, "identity-drift")
    save(f, "still-confirmed", identity(), { sourceKey: "feed/2" })
    correct(
      f,
      { type: "remove", eventId: first.eventId!, inputSeq: first.input.seq, mentionId: "M1" },
      [first.eventId!],
    )
    // 模型遗漏可选版本字段，仍有真实官方锚点；不能由新 identityKey 绕过人工排除。
    const drifted = output(first.input, identity({ version: null }))
    const rerun = f.automation.recalculate(first.input, drifted)
    f.registry.publish(rerun.input, drifted, rerun.id)
    const relations = f.registry.entryEvents(rerun.input)
    expect(relations.find((row) => row.membership.mentionId === "M1")?.membership).toMatchObject({
      state: "excluded",
      origin: "manual",
      eventId: first.eventId,
    })
    const candidate = relations.find((row) => row.membership.mentionId === "M2")!
    expect(candidate.membership.state).toBe("candidate")
    expect(candidate.event.status).toBe("candidate")
    expect(candidate.event.id).not.toBe(first.eventId)
    const repeated = f.automation.recalculate(rerun.input, drifted)
    f.registry.publish(repeated.input, drifted, repeated.id)
    expect(
      f.registry.entryEvents(repeated.input).find((row) => row.membership.mentionId === "M2"),
    ).toMatchObject({
      event: { id: candidate.event.id, status: "candidate" },
      membership: { state: "candidate" },
    })
    expect(f.registry.queryMembers({ eventId: first.eventId! }, scope).total).toBe(1)
  })
  it("重命名、移动和撤销只改指定关系，陈旧 revision 和幂等键内容冲突拒绝", () => {
    const f = fixture()
    const first = save(f, "first")
    const otherQuote = quote.replaceAll("5.2", "5.3").replaceAll("gpt-5-2", "gpt-5-3")
    const second = save(
      f,
      "second",
      identity(
        {
          version: { value: "5.3", quote: otherQuote },
          anchor: {
            kind: "official_reference",
            value: "https://official.test/releases/gpt-5-3",
            quote: otherQuote,
          },
        },
        otherQuote,
      ),
      { text: otherQuote },
    )
    const moved = correct(
      f,
      {
        type: "move",
        fromEventId: first.eventId!,
        toEventId: second.eventId!,
        inputSeq: first.input.seq,
        mentionId: "M1",
      },
      [first.eventId!, second.eventId!],
    )
    expect(f.registry.entryEvents(first.input)[0]?.event.id).toBe(second.eventId)
    const restored = correct(
      f,
      { type: "undo", correctionRequestId: moved.correctionId },
      moved.eventIds,
    )
    expect(restored.affectedInputSeqs).toContain(first.input.seq)
    expect(f.registry.entryEvents(first.input)[0]?.event.id).toBe(first.eventId)
    const request = {
      requestId: randomUUID(),
      expectedRevisions: revisions(f, [first.eventId!]),
      action: { type: "rename" as const, eventId: first.eventId!, title: "更清楚的事件名称" },
    }
    const renamed = f.registry.correct(request, scope)
    expect(renamed.events[0]?.title).toBe("更清楚的事件名称")
    expect(() => f.registry.correct({ ...request, requestId: randomUUID() }, scope)).toThrow(
      "revision_conflict",
    )
    expect(() =>
      f.registry.correct({ ...request, action: { ...request.action, title: "另外的名称" } }, scope),
    ).toThrow("revision_conflict")
  })
  it("合并/拆分保留后继旧链接，undo 恢复原关系且不回滚其它事件", () => {
    const f = fixture()
    const first = save(f, "a")
    const second = save(f, "b")
    const otherQuote = quote.replaceAll("5.2", "5.3").replaceAll("gpt-5-2", "gpt-5-3")
    const other = save(
      f,
      "unrelated",
      identity(
        {
          version: { value: "5.3", quote: otherQuote },
          anchor: {
            kind: "official_reference",
            value: "https://official.test/releases/gpt-5-3",
            quote: otherQuote,
          },
        },
        otherQuote,
      ),
      { text: otherQuote },
    )
    const split = correct(
      f,
      {
        type: "split",
        eventId: first.eventId!,
        groups: [
          { title: "材料 A", members: [{ inputSeq: first.input.seq, mentionId: "M1" }] },
          { title: "材料 B", members: [{ inputSeq: second.input.seq, mentionId: "M1" }] },
        ],
      },
      [first.eventId!],
    )
    const children = f.registry.queryEvent(first.eventId!, scope)!.successors
    expect(children).toHaveLength(2)
    correct(f, { type: "rename", eventId: other.eventId!, title: "无关事件保留编辑" }, [
      other.eventId!,
    ])
    correct(f, { type: "undo", correctionRequestId: split.correctionId }, split.eventIds)
    expect(f.registry.entryEvents(first.input)[0]?.event.id).toBe(first.eventId)
    expect(f.registry.queryEvent(children[0]!.id, scope)!.event.mergedInto).toBe(first.eventId)
    expect(f.registry.queryEvent(other.eventId!, scope)!.event.title).toBe("无关事件保留编辑")
    const merged = correct(
      f,
      { type: "merge", sourceEventIds: [other.eventId!], targetEventId: first.eventId! },
      [other.eventId!, first.eventId!],
    )
    expect(f.registry.queryEvent(other.eventId!, scope)!.event).toMatchObject({
      status: "merged",
      mergedInto: first.eventId,
    })
    expect(f.registry.entryEvents(other.input)[0]?.event.id).toBe(first.eventId)
    correct(f, { type: "undo", correctionRequestId: merged.correctionId }, merged.eventIds)
    expect(f.registry.entryEvents(other.input)[0]?.event.id).toBe(other.eventId)
  })
  it("纠错回调与关系同事务，重放不执行回调，回调失败完整回滚", () => {
    const f = fixture()
    const first = save(f, "callback")
    const before = f.registry.queryEvent(first.eventId!, scope)!.event
    const request = {
      requestId: randomUUID(),
      expectedRevisions: revisions(f, [first.eventId!]),
      action: {
        type: "remove" as const,
        eventId: first.eventId!,
        inputSeq: first.input.seq,
        mentionId: "M1",
      },
    }
    const failed = vi.fn(() => {
      throw new Error("story_invalidation_failed")
    })
    expect(() => f.registry.correct(request, scope, failed)).toThrow("story_invalidation_failed")
    expect(f.registry.queryEvent(first.eventId!, scope)!.event).toEqual(before)
    expect(f.registry.entryEvents(first.input)[0]?.membership.state).toBe("confirmed")
    const afterChange = vi.fn()
    const result = f.registry.correct(request, scope, afterChange)
    expect(f.registry.correct(request, scope, afterChange)).toEqual(result)
    expect(afterChange).toHaveBeenCalledTimes(1)
    expect(afterChange).toHaveBeenCalledWith(result)
  })
  it("undo 不恢复已更新正文或尚未重新发布的旧成员，即使事件仍有其它有效成员", () => {
    const f = fixture()
    const first = save(f, "old-material")
    save(f, "remaining-member")
    const removed = correct(
      f,
      { type: "remove", eventId: first.eventId!, inputSeq: first.input.seq, mentionId: "M1" },
      [first.eventId!],
    )
    f.automation.capture({ ...first.input.body, content: "新的正文材料" })
    expect(f.registry.queryEvent(first.eventId!, scope)!.membershipCount).toBe(1)
    expect(() =>
      correct(f, { type: "undo", correctionRequestId: removed.correctionId }, removed.eventIds),
    ).toThrow("revision_conflict")
    expect(
      f.registry.queryMembers({ eventId: first.eventId! }, scope).rows.map((row) => row.itemId),
    ).toEqual(["remaining-member"])
  })

  it("合并/拆分若涉及范围外有效成员即拒绝，不按界面范围隐式改全局关系", () => {
    const f = fixture()
    const first = save(f, "visible")
    const outside = save(f, "outside-scope", identity(), { sourceKey: "feed/2" })
    const thirdQuote = quote.replaceAll("5.2", "5.3").replaceAll("gpt-5-2", "gpt-5-3")
    const target = save(
      f,
      "target",
      identity(
        {
          version: { value: "5.3", quote: thirdQuote },
          anchor: {
            kind: "official_reference",
            value: "https://official.test/releases/gpt-5-3",
            quote: thirdQuote,
          },
        },
        thirdQuote,
      ),
      { text: thirdQuote },
    )
    const before = f.registry.queryEvent(first.eventId!, scope)!.event
    const merge = {
      requestId: randomUUID(),
      expectedRevisions: revisions(f, [first.eventId!, target.eventId!]),
      action: {
        type: "merge" as const,
        sourceEventIds: [first.eventId!],
        targetEventId: target.eventId!,
      },
    }
    expect(() => f.registry.correct(merge, { activeSources: new Set(["feed/1"]) })).toThrow(
      "invalid_target",
    )
    expect(() =>
      f.registry.correct(merge, { ...scope, excludedInputSeqs: new Set([outside.input.seq]) }),
    ).toThrow("invalid_target")
    const split = {
      requestId: randomUUID(),
      expectedRevisions: revisions(f, [first.eventId!]),
      action: {
        type: "split" as const,
        eventId: first.eventId!,
        groups: [
          { title: "第一组", members: [{ inputSeq: first.input.seq, mentionId: "M1" }] },
          { title: "第二组", members: [{ inputSeq: outside.input.seq, mentionId: "M1" }] },
        ],
      },
    }
    expect(() => f.registry.correct(split, { activeSources: new Set(["feed/1"]) })).toThrow(
      "invalid_target",
    )
    expect(f.registry.queryEvent(first.eventId!, scope)!.event).toEqual(before)
    expect(f.registry.entryEvents(outside.input)[0]?.event.id).toBe(first.eventId)
  })
  it("拆分子事件保留各组原始身份，新同版本材料归入相应子组而非旧父身份", () => {
    const f = fixture()
    const first = save(f, "v5.2")
    const thirdQuote = quote.replaceAll("5.2", "5.3").replaceAll("gpt-5-2", "gpt-5-3")
    const thirdIdentity = identity(
      {
        version: { value: "5.3", quote: thirdQuote },
        anchor: {
          kind: "official_reference",
          value: "https://official.test/releases/gpt-5-3",
          quote: thirdQuote,
        },
      },
      thirdQuote,
    )
    const second = save(f, "v5.3", thirdIdentity, { text: thirdQuote })
    correct(
      f,
      {
        type: "move",
        fromEventId: second.eventId!,
        toEventId: first.eventId!,
        inputSeq: second.input.seq,
        mentionId: "M1",
      },
      [first.eventId!, second.eventId!],
    )
    const split = correct(
      f,
      {
        type: "split",
        eventId: first.eventId!,
        groups: [
          { title: "5.2 组", members: [{ inputSeq: first.input.seq, mentionId: "M1" }] },
          { title: "5.3 组", members: [{ inputSeq: second.input.seq, mentionId: "M1" }] },
        ],
      },
      [first.eventId!],
    )
    const child = split.events.find((event) => event.title === "5.3 组")!
    expect(child.identity.version).toEqual({ value: "5.3", quote: thirdQuote })
    const incoming = save(f, "new-v5.3-report", thirdIdentity, { text: thirdQuote })
    expect(incoming.eventId).toBe(child.id)
    expect(incoming.events[0]?.membership.state).toBe("confirmed")
  })

  it("未覆盖全部成员的拆分事务回滚，undo 不越过后来的同事件修订", () => {
    const f = fixture()
    const first = save(f, "one")
    save(f, "two")
    save(f, "three")
    const event = f.registry.queryEvent(first.eventId!, scope)!.event
    expect(() =>
      correct(
        f,
        {
          type: "split",
          eventId: first.eventId!,
          groups: [
            { title: "A", members: [{ inputSeq: first.input.seq, mentionId: "M1" }] },
            { title: "B", members: [{ inputSeq: first.input.seq, mentionId: "M1" }] },
          ],
        },
        [first.eventId!],
      ),
    ).toThrow("invalid_target")
    expect(f.registry.queryEvent(first.eventId!, scope)!.event).toEqual(event)
    const renamed = correct(f, { type: "rename", eventId: first.eventId!, title: "先修订" }, [
      first.eventId!,
    ])
    correct(f, { type: "rename", eventId: first.eventId!, title: "后修订" }, [first.eventId!])
    expect(() =>
      correct(f, { type: "undo", correctionRequestId: renamed.correctionId }, renamed.eventIds),
    ).toThrow("revision_conflict")
  })
  it("文件重开保留排除与纠错记录，快照账号隔离并在一天/百份后清理", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-06T00:00:00Z"))
    const directory = mkdtempSync(join(tmpdir(), "folo-event-registry-"))
    directories.push(directory)
    const path = join(directory, "events.sqlite")
    const f = fixture(path)
    const first = save(f, "persisted")
    const removed = correct(
      f,
      { type: "remove", eventId: first.eventId!, inputSeq: first.input.seq, mentionId: "M1" },
      [first.eventId!],
    )
    const snapshot = f.registry.queryMembers({ eventId: first.eventId!, state: "excluded" }, scope)
    for (let i = 0; i < 101; i++) f.registry.queryEvents({}, scope)
    expect(() =>
      f.registry.queryMembers(
        { eventId: first.eventId!, state: "excluded", snapshotId: snapshot.snapshotId },
        scope,
      ),
    ).toThrow("invalid_target")
    expect(f.db.prepare("SELECT count(*) AS n FROM processing_event_snapshots").get()?.n).toBe(100)
    databases.splice(databases.indexOf(f.db), 1)
    f.db.close()
    const reopened = fixture(path)
    expect(reopened.registry.entryEvents(first.input)[0]?.membership).toMatchObject({
      state: "excluded",
      origin: "manual",
    })
    correct(reopened, { type: "undo", correctionRequestId: removed.correctionId }, removed.eventIds)
    expect(reopened.registry.entryEvents(first.input)[0]?.membership.state).toBe("confirmed")
    const latest = reopened.registry.queryMembers({ eventId: first.eventId! }, scope)
    vi.setSystemTime(new Date("2026-10-07T00:00:01Z"))
    expect(() =>
      reopened.registry.queryMembers(
        { eventId: first.eventId!, snapshotId: latest.snapshotId },
        scope,
      ),
    ).toThrow("invalid_target")
    const separate = fixture()
    expect(separate.registry.queryEvent(first.eventId!, scope)).toBeNull()
  })
})

it("指定周报事件片段分别获得确认资格，人工移出一个片段不授权另一事件或旧主归属", () => {
  const f = fixture()
  const otherQuote = quote.replaceAll("5.2", "5.3").replaceAll("gpt-5-2", "gpt-5-3")
  const identities = [
    identity(),
    identity(
      {
        version: { value: "5.3", quote: otherQuote },
        anchor: {
          kind: "official_reference",
          value: "https://official.test/releases/gpt-5-3",
          quote: otherQuote,
        },
      },
      otherQuote,
    ),
  ]
  const seq = f.automation.capture({
    id: "weekly",
    sourceKey: "feed/1",
    title: "并列周报",
    content: `${quote}\n${otherQuote}`,
    description: null,
    read: false,
    url: null,
    publishedAt: "2026-10-06T00:00:00Z",
  })
  const input = f.automation.assign(seq)
  const decision = output(
    input,
    null,
    identities.map((identity) => ({ identity, role: "reports", isPrimary: false })),
  )
  decision.facts = [quote, otherQuote].map((quote, eventMentionIndex) => ({
    text: quote,
    quote,
    kind: "fact",
    eventMentionIndex,
  }))
  const completion = f.automation.complete(input, decision)
  f.registry.publish(input, decision, completion.id)
  const members = f.registry.entryEvents(input)
  const refs = [0, 1].map((eventMentionIndex) => ({
    inputSeq: seq,
    decisionId: completion.id,
    eventMentionIndex,
  }))
  expect(f.registry.confirmedEventIdsForMembers([refs[0]!])).toEqual([members[0]!.event.id])
  expect(f.registry.confirmedEventIdsForMembers([refs[1]!])).toEqual([members[1]!.event.id])
  expect(f.registry.confirmedEventIdsForMembers(refs)).toEqual([])
  expect(
    f.registry.confirmedEventIdsForMembers([{ inputSeq: seq, decisionId: completion.id }]),
  ).toEqual([])
  expect(f.registry.confirmedEventIdsForMembers([{ ...refs[0]!, eventMentionIndex: 3 }])).toEqual(
    [],
  )
  correct(
    f,
    {
      type: "remove",
      eventId: members[0]!.event.id,
      inputSeq: seq,
      mentionId: members[0]!.membership.mentionId,
    },
    [members[0]!.event.id],
  )
  expect(f.registry.confirmedEventIdsForMembers([refs[0]!])).toEqual([])
  expect(f.registry.confirmedEventIdsForMembers([refs[1]!])).toEqual([members[1]!.event.id])
})

it("分析教程只有指定已确认片段才可贡献，旧全篇角色和背景mentions不获许可", () => {
  const f = fixture()
  const report = save(f, "report")
  const analysis = save(f, "analysis-explicit", identity({ kind: "analysis" }))
  expect(
    f.registry.confirmedEventIdsForMembers([
      { inputSeq: analysis.input.seq, decisionId: analysis.decisionId, eventMentionIndex: 0 },
    ]),
  ).toEqual([report.eventId])
  expect(
    f.registry.confirmedEventIdsForMembers([
      { inputSeq: analysis.input.seq, decisionId: analysis.decisionId },
    ]),
  ).toEqual([])
  const background = save(f, "background", identity(), {
    mentions: [{ identity: identity(), role: "mentions", isPrimary: false }],
  })
  expect(
    f.registry.confirmedEventIdsForMembers([
      { inputSeq: background.input.seq, decisionId: background.decisionId, eventMentionIndex: 0 },
    ]),
  ).toEqual([])
})
