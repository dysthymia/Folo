import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { afterEach, expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { generatedFeedQuerySchema } from "./generated-feeds"
import type { ProcessingDecision } from "./processing-decision"
import type { EventIdentity } from "./processing-event"
import { compatibleEvents, traceableRelatedEvent } from "./processing-event"
import { isJointAnnouncement } from "./processing-event-mentions"
import { Store } from "./store"
import type { StoryModelOutput } from "./story-engine"
import { runStoryAggregation } from "./story-engine"

const stores: Store[] = []
const directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

// 同一真实公告的三种抽取形态：缺轮次、动作不同、事实归属为空；所有证据均从本地正文取出。
function identity(
  quote: string,
  object = "Arena B 轮融资",
  action: "announcement" | "transaction" = "transaction",
): EventIdentity {
  return {
    kind: "event",
    subject: { value: "Arena", quote },
    action: { value: action, quote },
    object: { value: object, quote },
    version: null,
    round: null,
    anchor: null,
  }
}
function fixture(mode: "same_event" | "topic" = "same_event", missingImages = false) {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([
    { key: "feed/1", kind: "feed", id: "1", title: "AI", view: 0, category: "AI" },
  ])
  const draft = store.automation.draft()
  store.automation.saveDraft(
    {
      ...draft.config,
      rules: [
        {
          id: "announcement",
          ownerId: "owner",
          name: "同事件综述",
          enabled: true,
          order: 0,
          when: { all: true },
          version: 1,
          executionLocation: "processing_service",
          actions: [
            {
              type: "ai_aggregate",
              mode,
              scope: { all: true },
              createPrompt: "保留所有独有事实",
              updatePrompt: "保留仍有效事实",
            },
          ],
        },
      ],
    },
    draft.revision,
  )
  store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
  const directory = mkdtempSync(`${tmpdir()}/folo-announcement-`)
  directories.push(directory)
  writeFileSync(`${directory}/ai.json`, JSON.stringify({ provider: "codex", model: "test" }))
  const quotes = [
    "Arena 完成 2 亿美元 B 轮融资，估值 31 亿美元，由 Lightspeed 和 Khosla Ventures 联合领投。",
    "Arena 宣布完成由 Lightspeed 领投的 2 亿美元 B 轮融资，估值 31 亿美元。",
    "Arena 宣布完成 2 亿美元 B 轮融资，估值 31 亿美元。",
  ]
  for (const [index, quote] of quotes.entries()) {
    const release = "融资同时，Arena 发布 Alignment Index，评估智能体安全行为。"
    const extra = [
      `Arena 用户遍布 150 多个国家。`,
      `Arena 年化收入超过 1 亿美元。`,
      `Arena 累计 6200 万次投票。`,
    ][index]!
    const body = {
      id: `arena-${index}`,
      sourceKey: "feed/1",
      title: quote,
      content: [quote, release, extra].join("\n"),
      description: null,
      url: `https://example.test/arena-${index}`,
      read: false,
      publishedAt: "2026-10-09T00:00:00Z",
      ...(missingImages && index === 0 ? { imageCount: 1 } : {}),
    }
    store.saveEntry(body)
    const input = store.automation.assign(store.automation.inputs().at(-1)!.seq)
    const primary = identity(
      quote,
      index === 2 ? "2 亿美元 B 轮融资" : "Arena B 轮融资",
      index === 2 ? "announcement" : "transaction",
    )
    const secondary: EventIdentity = {
      ...identity(release),
      action: { value: "product_release", quote: release },
      object: { value: "Alignment Index", quote: release },
    }
    const facts = [quote, release, extra].map((text, factIndex) => ({
      text,
      quote: text,
      kind: (index === 0 ? "source_claim" : "fact") as "source_claim" | "fact",
      eventMentionIndex: index === 2 ? null : factIndex < 2 ? factIndex : null,
    }))
    const decision: ProcessingDecision = {
      schemaVersion: 2,
      fingerprint: `arena-${index}`,
      provider: "codex",
      model: "test",
      generatedAt: "2026-10-09T00:00:00Z",
      durationMs: 1,
      usage: null,
      status: "keep",
      title: quote,
      summary: quote,
      reason: "同公告",
      labels: [],
      sourceRole: "reporting",
      policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
      context: { source_id: "1", contextId: "feed/1" },
      facts,
      reused: false,
      semantic: {
        entryId: body.id,
        title: quote,
        summary: quote,
        disposition: "keep",
        reason: "同公告",
        aggregation: true,
        rewrite: true,
        labels: [],
        facts: [],
        event: mode === "topic" ? { ...primary, kind: "analysis" } : primary,
        eventMentions: [
          {
            identity: mode === "topic" ? { ...primary, kind: "analysis" } : primary,
            role: mode === "topic" ? "analysis_of" : "reports",
            isPrimary: true,
          },
          { identity: secondary, role: "reports", isPrimary: false },
        ],
      },
    }
    store.automation.complete(input, decision)
    if (index < 2) store.saveEntry({ ...body, read: true })
  }
  store.synchronizeEvents()
  const decisions = store.processingState.published()
  // 模型合并共同融资/发布事实，独有事实逐项保留；来源主张只允许保守降级。
  const common = [
    "Arena 完成 2 亿美元 B 轮融资，估值 31 亿美元。",
    "Arena 同时发布 Alignment Index，评估智能体安全行为。",
  ]
  const sentences = common.map((text, factIndex) => ({
    text,
    sources: decisions.map(({ input }) => ({
      inputSeq: input.seq,
      evidenceId: `evidence-${input.seq}-${factIndex}`,
    })),
  }))
  for (const decision of decisions)
    sentences.push({
      text: decision.decision.facts[2]!.text,
      sources: [{ inputSeq: decision.input.seq, evidenceId: `evidence-${decision.input.seq}-2` }],
    })
  const group: StoryModelOutput["groups"][number] = {
    existingStoryId: null,
    title: "Arena 融资及 Alignment Index",
    body: "由引用句段构造",
    retainedSentenceIds: [],
    retainedFactIds: [],
    sentences,
    facts: sentences.map((sentence, index) => ({
      text: sentence.text,
      kind: "source_claim",
      sentenceIndexes: [index],
      dependsOnFactIndexes: [],
      dependsOnRetainedFactIds: [],
    })),
    factCoverage: decisions.flatMap(({ input }, index) =>
      [0, 1, 2].map((factIndex) => ({
        inputSeq: input.seq,
        evidenceId: `evidence-${input.seq}-${factIndex}`,
        factIndexes: [factIndex < 2 ? factIndex : index + 2],
      })),
    ),
  }
  const execute = async <T>(options: CodexJsonOptions<T>) => {
    const output = { groups: [group] }
    if (!options.validate(output)) throw new Error("invalid_fixture")
    return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
  const options = {
    decisions,
    currentEntry: store.entry.bind(store),
    ruleSet: store.automation.release(store.automation.releases()[0]!.version)!,
    stories: store.stories,
    aiConfig: new AIConfigStore(`${directory}/ai.json`),
    runtimeDir: directory,
    signal: new AbortController().signal,
    execute,
    sameEventEligible: (published: (typeof decisions)[number], index?: number) =>
      store.events.confirmedEventIdsForMembers([
        {
          inputSeq: published.input.seq,
          decisionId: published.decisionId,
          eventMentionIndex: index,
        },
      ]).length > 0,
    registeredEventId: (members: Parameters<typeof store.events.confirmedEventIdsForMembers>[0]) =>
      store.events.confirmedEventIdsForMembers(members)[0] ?? null,
  }
  return { store, decisions, group, options }
}

it("同公告三篇只显示一条综述，完整覆盖经营数据、所有原文仍可恢复且读态不变", async () => {
  const f = fixture()
  const result = await runStoryAggregation({
    ...f.options,
    cachedReadInputSeqs: f.decisions.slice(0, 2).map(({ input }) => input.seq),
  })
  expect(result.created).toHaveLength(1)
  const revision = f.store.stories.currentSnapshot(result.created[0]!.storyId)!
  expect(revision.members).toHaveLength(3)
  expect(revision.members.every((member) => member.announcementCoverage?.length === 3)).toBe(true)
  expect(f.store.reading.representedInputSeqs()).toEqual(
    new Set(f.decisions.map(({ input }) => input.seq)),
  )
  const page = f.store.reading.generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" }))
  expect(page.items.map((item) => item.kind)).toEqual(["story"])
  expect(revision.body).toContain("150 多个国家")
  expect(revision.body).toContain("1 亿美元")
  expect(revision.body).toContain("6200 万次投票")
  expect(
    f.decisions.map(({ input }) => f.store.entry(input.sourceKey, input.itemId)?.read),
  ).toEqual([true, true, false])
  f.store.processingState.setOverride(f.decisions[0]!.input.seq, "restore", 0)
  expect(
    f.store.reading.generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" })).items,
  ).toContainEqual(expect.objectContaining({ kind: "entry", id: "arena-0" }))
})

it("正常后台不对已读材料重新付费，显式修复才可复用这些缓存", async () => {
  const f = fixture()
  const result = await runStoryAggregation(f.options)
  expect(result.created).toHaveLength(0)
})

it("主题综述完整覆盖分析全文时只显示综述，读态不变且原文可恢复", async () => {
  const f = fixture("topic")
  const result = await runStoryAggregation({
    ...f.options,
    cachedReadInputSeqs: f.decisions.map(({ input }) => input.seq),
  })
  expect(result.created).toHaveLength(1)
  const revision = f.store.stories.currentSnapshot(result.created[0]!.storyId)!
  expect(revision.eventIdentity).toBeUndefined()
  expect(revision.members.every((member) => member.wholeEntryCoverage?.length === 3)).toBe(true)
  expect(
    f.store.reading
      .generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" }))
      .items.map((item) => item.kind),
  ).toEqual(["story"])
  expect(
    f.decisions.map(({ input }) => f.store.entry(input.sourceKey, input.itemId)?.read),
  ).toEqual([true, true, false])
  const invalid = structuredClone(revision)
  invalid.members[0]!.wholeEntryCoverage!.pop()
  expect(() => f.store.stories.appendRevision(revision.storyId, 1, invalid)).toThrow(
    "invalid_reference",
  )
  const swapped = structuredClone(revision)
  swapped.members[0]!.wholeEntryCoverage![0]!.storyFactIds = [revision.facts.at(-1)!.id]
  expect(() => f.store.stories.appendRevision(revision.storyId, 1, swapped)).toThrow(
    "invalid_reference",
  )
  f.store.processingState.setOverride(f.decisions[0]!.input.seq, "restore", 0)
  expect(
    f.store.reading.generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" })).items,
  ).toContainEqual(expect.objectContaining({ kind: "entry", id: "arena-0" }))
})

it.each(["partial", "media"])("主题综述在 %s 时保留未完全覆盖的分析原文", async (reason) => {
  const f = fixture("topic", reason === "media")
  if (reason === "partial")
    f.group.factCoverage = f.group.factCoverage!.filter(
      (item) => item.inputSeq !== f.decisions[0]!.input.seq || !item.evidenceId.endsWith("-1"),
    )
  const result = await runStoryAggregation({
    ...f.options,
    cachedReadInputSeqs: f.decisions.map(({ input }) => input.seq),
  })
  expect(result.created).toHaveLength(1)
  expect(f.store.reading.representedInputSeqs().has(f.decisions[0]!.input.seq)).toBe(false)
  expect(
    f.store.reading.generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" })).items,
  ).toContainEqual(expect.objectContaining({ kind: "entry", id: "arena-0" }))
})

it("覆盖不完整时保留原文；伪造覆盖及来源主张提升为事实均被持久化边界拒绝", async () => {
  const f = fixture()
  f.group.factCoverage = f.group.factCoverage!.filter(
    (item) => item.inputSeq !== f.decisions[0]!.input.seq || !item.evidenceId.endsWith("-1"),
  )
  const result = await runStoryAggregation({
    ...f.options,
    cachedReadInputSeqs: f.decisions.map(({ input }) => input.seq),
  })
  expect(result.created).toHaveLength(1)
  const revision = f.store.stories.currentSnapshot(result.created[0]!.storyId)!
  expect(f.store.reading.representedInputSeqs().has(f.decisions[0]!.input.seq)).toBe(false)
  expect(
    f.store.reading.generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" })).items,
  ).toContainEqual(expect.objectContaining({ kind: "entry", id: "arena-0" }))
  const tampered = structuredClone(revision)
  tampered.members[0]!.announcementCoverage![0]!.storyFactIds = ["missing"]
  expect(() => f.store.stories.appendRevision(revision.storyId, 1, tampered)).toThrow(
    "invalid_reference",
  )
  const promoted = structuredClone(revision)
  promoted.facts[2]!.kind = "fact"
  expect(() => f.store.stories.appendRevision(revision.storyId, 1, promoted)).toThrow(
    "invalid_reference",
  )
})

it.each(["B+", "C", "B 轮追加"])("不同轮次或追加融资 %s 不进入原公告", (round) => {
  const a = identity("Arena 完成 2 亿美元 B 轮融资，估值 31 亿美元。")
  const b = identity(`Arena 完成 2 亿美元 ${round.replace(" 轮", "")}轮融资，估值 31 亿美元。`)
  const verified = traceableRelatedEvent(a, a.action.quote)!
  expect(compatibleEvents(verified, b)).toBe(false)
})

it("同轮次不同金额、估值、日期或无同时发布证据均不自动归组", () => {
  const quote = "Arena 完成 2 亿美元 B 轮融资，估值 31 亿美元。"
  const a = identity(quote)
  for (const different of [
    quote.replace("2 亿", "3 亿"),
    quote.replace("31 亿", "35 亿"),
    quote.replace("完成", "计划完成"),
  ])
    expect(compatibleEvents(a, identity(different))).toBe(false)
  const secondary = {
    ...identity("Arena 发布 Alignment Index。"),
    action: { value: "product_release" as const, quote: "Arena 发布 Alignment Index。" },
    object: { value: "Alignment Index", quote: "Arena 发布 Alignment Index。" },
  }
  expect(
    isJointAnnouncement(
      {
        eventMentions: [
          { identity: a, role: "reports", isPrimary: true },
          { identity: secondary, role: "reports", isPrimary: false },
        ],
      },
      `${quote}\nArena 发布 Alignment Index。`,
      0,
    ),
  ).toBe(false)
  expect(
    compatibleEvents(
      { ...a, anchor: { value: "2026-10-09", quote, kind: "event_date" } },
      { ...a, anchor: { value: "2026-10-10", quote, kind: "event_date" } },
    ),
  ).toBe(false)
})

it("共同事实由另一篇已确认 fact 引用支撑时可覆盖来源主张，独有主张仍保留类型", async () => {
  const f = fixture()
  f.group.facts[0]!.kind = "fact"
  const result = await runStoryAggregation({
    ...f.options,
    cachedReadInputSeqs: f.decisions.map(({ input }) => input.seq),
  })
  expect(result.created).toHaveLength(1)
  expect(f.store.reading.representedInputSeqs().size).toBe(3)
})
