import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import type { ConditionSet } from "@follow/information-core"
import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { ProcessingInput } from "./automation-store"
import type { SourceEntry } from "./folo"
import type { ProcessingDecision } from "./processing-decision"
import {
  activeDedupeActions,
  prepareSemanticDedupe,
  ProcessingDedupeStore,
  runSemanticDedupe,
  semanticDedupeEvidenceKey,
} from "./processing-dedupe"
import type { ProcessingEntryRole } from "./processing-reading-store"
import type { SemanticDuplicateModelOutput } from "./semantic-dedupe"
import { getSemanticDuplicateCandidates } from "./semantic-dedupe"
import { Store } from "./store"
import { sourceSpanFragmentId } from "./story-store"

const stores: Store[] = []
const tempDirs: string[] = []
const source = {
  key: "feed/f1",
  kind: "feed" as const,
  id: "f1",
  title: "科技媒体",
  view: 0,
  category: "科技",
}

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source])
  store.sourceSync.replaceSources([source], new Date().toISOString())
  const dir = mkdtempSync(join(tmpdir(), "folo-dedupe-"))
  tempDirs.push(dir)
  const configPath = join(dir, "ai.json")
  writeFileSync(
    configPath,
    JSON.stringify({ provider: "qianwen", model: "test-model", apiKey: "test-key" }),
  )
  return { aiConfig: new AIConfigStore(configPath), store }
}

function entry(id: string, title: string, publishedAt: string, content?: string): SourceEntry {
  return {
    content: content ?? `${title}（正文）`,
    description: `${title} 的摘要`,
    id,
    publishedAt,
    read: false,
    sourceKey: source.key,
    title,
    url: `https://example.test/${id}`,
  }
}

function publishRules(store: Store, rules: object[]) {
  const draft = store.automation.draft()
  store.automation.saveDraft({ ...draft.config, rules }, draft.revision)
  store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
}

function dedupeRule(scope: ConditionSet) {
  return {
    actions: [{ scope, type: "ai_dedupe" }],
    enabled: true,
    executionLocation: "processing_service",
    id: "dedupe-rule",
    name: "同事件去重",
    order: 0,
    ownerId: "owner",
    version: 1,
    when: { all: true },
  }
}

function publishDecision(store: Store, input: SourceEntry): ProcessingDecision {
  store.saveEntry(input)
  const target = store.automation.assign(store.automation.inputs().at(-1)!.seq)
  const decision: ProcessingDecision = {
    context: { contextId: source.key, source_id: source.id },
    durationMs: 1,
    facts: [],
    fingerprint: `fingerprint-${target.seq}`,
    generatedAt: "2026-01-01T00:00:00.000Z",
    labels: [],
    model: "test-model",
    policy: { aggregation: "allow", rewrite: "allow", standalone: "auto" },
    provider: "qianwen",
    reason: "测试决定",
    reused: false,
    schemaVersion: 1,
    semantic: null,
    sourceRole: "reporting",
    status: "keep",
    summary: `摘要 ${target.seq}`,
    title: input.title,
    usage: null,
  }
  store.automation.complete(target, decision)
  return decision
}

function rolesOf(store: Store): ProcessingEntryRole[] {
  return store.reading.roles()
}

/** 让假执行器按 pairKey 回复固定判定，避免真实 CLI 调用。 */
function fakeExecute(
  decide: (pairKey: string) => {
    duplicate: boolean
    confidence: number
    keep: string
    hide: string
    factComparison?: SemanticDuplicateModelOutput["results"][number]["factComparison"]
  },
) {
  return vi.fn(async (options: { prompt: string }) => {
    const marker = "候选："
    const parsed = JSON.parse(
      options.prompt.slice(options.prompt.indexOf(marker) + marker.length),
    ) as {
      candidates: Array<{ pairKey: string; keepEntryId: string; testEntryId: string }>
    }
    return {
      durationMs: 3,
      model: "test-model",
      result: {
        results: parsed.candidates.map((candidate) => {
          const decided = decide(candidate.pairKey)
          return {
            confidence: decided.confidence,
            factComparison: decided.factComparison ?? {
              verdict: decided.duplicate ? "equivalent" : "different",
              onlyInFirst: [],
              onlyInSecond: [],
            },
            duplicate: decided.duplicate,
            hideEntryId: decided.duplicate ? decided.hide : null,
            keepEntryId: decided.duplicate ? decided.keep : null,
            pairKey: candidate.pairKey,
            reason: decided.duplicate ? "同一核心事件" : "不同事件",
          }
        }),
      },
      toolCalls: 0,
      usage: null,
    }
  })
}

// 所有新回归均使用假模型，验证持久化、预算和原文保留而不调用外部服务。
const negativeExecute = () =>
  fakeExecute(() => ({ duplicate: false, confidence: 0.99, keep: "", hide: "" }))
function runFixture(store: Store, aiConfig: AIConfigStore, execute = negativeExecute()) {
  return runSemanticDedupe({
    store,
    aiConfig,
    execute: execute as never,
    runtimeDir: "/unused",
    signal: new AbortController().signal,
  })
}
function fingerprintsOf(store: Store) {
  return new Set(
    activeDedupeActions(store.automation.release(store.automation.releases()[0]!.version)).map(
      (action) => action.fingerprint,
    ),
  )
}
function publishPair(store: Store) {
  publishDecision(store, entry("older", "OpenAI 发布 GPT-6 模型", "2026-01-10T00:00:00.000Z"))
  publishDecision(store, entry("newer", "OpenAI 发布 GPT-6 模型", "2026-01-10T06:00:00.000Z"))
}
function duplicateExecute() {
  return fakeExecute(() => ({ duplicate: true, confidence: 0.93, keep: "older", hide: "newer" }))
}

// 用真实 StoryStore 构造可读综述，候选排除必须遵守服务资格而不是只看残留成员关系。
function createStory(store: Store, inputs: ProcessingInput[]) {
  const spans = inputs.map((input) => ({
    id: `span-${input.seq}`,
    inputSeq: input.seq,
    sourceItemId: input.itemId,
    contentVersion: input.contentVersion,
    fragmentId: sourceSpanFragmentId(input.itemId, input.contentVersion, input.body.content!),
    quote: input.body.content!,
    sourceRole: "reporting",
  }))
  const storyId = randomUUID()
  store.stories.create(
    {
      title: "可读事件综述",
      body: "同一事件的来源事实",
      aggregationRuleId: "aggregate",
      aggregationScopeVersion: "scope",
      appliedRuleSetVersion: 1,
      instructionFingerprint: "instruction",
      members: inputs.map((input) => ({
        inputSeq: input.seq,
        decisionId: store.processingState.published().find((item) => item.input.seq === input.seq)!
          .decisionId,
      })),
      sourceSpans: spans,
      citations: spans.map((span) => ({
        id: `cite-${span.inputSeq}`,
        sourceSpanId: span.id,
        sentenceId: `sentence-${span.inputSeq}`,
      })),
      sentences: spans.map((span) => ({
        id: `sentence-${span.inputSeq}`,
        text: `事实 ${span.inputSeq}`,
        citationIds: [`cite-${span.inputSeq}`],
      })),
      facts: [
        {
          id: "fact",
          kind: "fact",
          text: "材料支持的事实",
          citationIds: spans.map((span) => `cite-${span.inputSeq}`),
          dependsOnFactIds: [],
        },
      ],
    },
    storyId,
  )
  return storyId
}

afterEach(() => {
  vi.useRealTimers()
  stores.splice(0).forEach((store) => store.close())
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { force: true, recursive: true }))
})

describe("事件召回与扫描水位", () => {
  it("同事件最近评测不遮住更早跨语言原件，一轮比较后只折叠转载", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(
      store,
      entry(
        "A",
        "正式公告",
        "2026-01-10T00:00:00Z",
        "OpenAI 发布 GPT 5.2，支持离线运行，价格为十元。",
      ),
    )
    publishDecision(
      store,
      entry(
        "B",
        "评测：存在缺陷",
        "2026-01-10T01:00:00Z",
        "我实测 GPT 5.2，离线运行存在崩溃风险，这是公告中没有的反证。",
      ),
    )
    publishDecision(
      store,
      entry(
        "C",
        "New model launch",
        "2026-01-10T02:00:00Z",
        "OpenAI released GPT 5.2 with offline operation at a price of ten yuan.",
      ),
    )
    Object.assign(store, {
      eventRecall: () => ({
        eventIds: ["evt_11111111-1111-4111-8111-111111111111"],
        identities: [],
      }),
    })
    const plan = prepareSemanticDedupe({
      store,
      targets: [{ sourceKey: source.key, itemId: "C" }],
    })[0]!
    expect(plan.candidates.map((candidate) => candidate.pairKey)).toEqual(["B::C", "A::C"])
    const execute = fakeExecute((pairKey) => ({
      duplicate: pairKey === "A::C",
      confidence: 0.99,
      keep: "A",
      hide: "C",
    }))
    const result = await runSemanticDedupe({
      store,
      aiConfig,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      targets: [{ sourceKey: source.key, itemId: "C" }],
    })
    expect(result).toMatchObject({ candidates: 2, batches: 1, duplicates: 1, pending: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(rolesOf(store).find((role) => role.itemId === "C")?.kind).toBe("merged")
    expect(rolesOf(store).some((role) => role.itemId === "B")).toBe(false)
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store))).toEqual(new Set(["B::C", "A::C"]))
  })
  it("迟到登记使旧无候选扫描失效，已有否定判定仍保留独立材料并且不重复比较", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(
      store,
      entry("zh", "新品来了", "2026-01-10T00:00:00Z", "产品发布报道，支持离线运行。"),
    )
    publishDecision(
      store,
      entry(
        "en",
        "Independent field review",
        "2026-01-10T01:00:00Z",
        "Independent review reports an incompatibility in offline usage.",
      ),
    )
    let confirmed = false
    let eventId = "evt_11111111-1111-4111-8111-111111111111"
    Object.assign(store, {
      eventRecall: () => ({ eventIds: confirmed ? [eventId] : [], identities: [] }),
    })
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ candidates: 0, batches: 0 })
    expect(store.dedupe.settledItemIds(fingerprintsOf(store)).size).toBe(2)
    confirmed = true
    const plan = prepareSemanticDedupe({ store })[0]!
    expect(plan.candidates).toHaveLength(1)
    expect(plan.recallWatermark).not.toBe("text-v1")
    expect(store.dedupe.settledItemIds(fingerprintsOf(store), plan.recallWatermark).size).toBe(0)
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      candidates: 1,
      duplicates: 0,
      batches: 1,
    })
    expect(rolesOf(store)).toEqual([])
    expect(store.processingState.published()).toHaveLength(2)
    eventId = "evt_22222222-2222-4222-8222-222222222222"
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ candidates: 0, batches: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(1)
  })
  it("召回依据更新不改变全文缓存key；人工保留、授权目标与规则范围仍先于召回", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(
      store,
      entry("older", "新品来了", "2026-01-10T00:00:00Z", "产品发布正式公告，价格为十元。"),
    )
    publishDecision(
      store,
      entry(
        "newer",
        "Independent field review",
        "2026-01-10T01:00:00Z",
        "Independent review finds additional limitations and a contrary conclusion.",
      ),
    )
    Object.assign(store, {
      eventRecall: () => ({
        eventIds: ["evt_11111111-1111-4111-8111-111111111111"],
        identities: [],
      }),
    })
    const candidate = prepareSemanticDedupe({ store })[0]!.candidates[0]!
    const evidenceKey = semanticDedupeEvidenceKey(candidate)
    store.dedupe.saveRelation(candidate, {
      model: "test-model",
      provider: "qianwen",
      evaluation: {
        pairKey: candidate.pairKey,
        duplicate: false,
        confidence: 0.99,
        keepEntryId: null,
        hideEntryId: null,
        reason: "新评测与反证独立",
        status: "decided",
        verdict: "different",
      },
    })
    Object.assign(store, {
      eventRecall: () => ({
        eventIds: ["evt_22222222-2222-4222-8222-222222222222"],
        identities: [],
      }),
    })
    expect(semanticDedupeEvidenceKey(prepareSemanticDedupe({ store })[0]!.candidates[0]!)).toBe(
      evidenceKey,
    )
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      candidates: 1,
      relationCacheHits: 1,
      batches: 0,
      duplicates: 0,
    })
    expect(execute).not.toHaveBeenCalled()
    const input = store.automation.inputs().find((item) => item.itemId === "newer")!
    store.processingState.setOverride(input.seq, "restore", 0)
    expect(prepareSemanticDedupe({ store })[0]!.participants).toHaveLength(1)
    expect(
      prepareSemanticDedupe({ store, targets: [{ sourceKey: source.key, itemId: "newer" }] })[0]!
        .candidates,
    ).toEqual([])
    publishRules(store, [
      dedupeRule({
        anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["outside"] }] }],
      }),
    ])
    expect(prepareSemanticDedupe({ store })[0]!.participants).toEqual([])
  })
})

describe("语义去重的服务端执行与角色落地", () => {
  it("未证明完整覆盖时不写入隐藏关系，并保存否定判定防止重复付费", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const title = "某协会公布年度服务方案"
    publishDecision(
      store,
      entry("older", title, "2026-01-10T00:00:00.000Z", "协会公布年度服务方案。"),
    )
    publishDecision(
      store,
      entry(
        "newer",
        title,
        "2026-01-10T01:00:00.000Z",
        "协会公布年度服务方案。资格审核完成后，须经投票再授权执行。",
      ),
    )
    // 故意让模型的正向布尔值与独有信息矛盾，验证服务端仍保留双方。
    const execute = fakeExecute(() => ({
      duplicate: true,
      confidence: 0.99,
      keep: "newer",
      hide: "older",
      factComparison: {
        verdict: "different",
        onlyInFirst: ["资格审核完成后，须经投票再授权执行。"],
        onlyInSecond: [],
      },
    }))
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      candidates: 1,
      duplicates: 0,
    })
    expect(rolesOf(store)).toEqual([])
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(1)
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ candidates: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("较新报道完整覆盖简版时保留完整报道，角色与阅读列表同步合并", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const title = "某协会公布年度服务方案"
    publishDecision(
      store,
      entry("older", title, "2026-01-10T00:00:00.000Z", "协会公布年度服务方案。"),
    )
    publishDecision(
      store,
      entry(
        "newer",
        title,
        "2026-01-10T01:00:00.000Z",
        "协会公布年度服务方案。资格审核完成后，须经投票再授权执行。",
      ),
    )
    // 完整报道可以覆盖较旧简版，发布时间不能把保留方向倒转。
    const execute = fakeExecute(() => ({
      duplicate: true,
      confidence: 0.99,
      keep: "newer",
      hide: "older",
      factComparison: {
        verdict: "first_contains_second",
        onlyInFirst: ["资格审核完成后，须经投票再授权执行。"],
        onlyInSecond: [],
      },
    }))
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ duplicates: 1, pending: 0 })
    expect(rolesOf(store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "older", kind: "merged", relatedEntryIds: ["newer"] }),
        expect.objectContaining({
          itemId: "newer",
          kind: "keeper",
          relatedEntryIds: ["older"],
          materialCount: 2,
        }),
      ]),
    )
    const snapshot = store.reading.refresh()
    expect(store.reading.counts(snapshot.id)).toMatchObject({ standalone: 1 })
    expect(store.reading.page({ snapshotId: snapshot.id }).items).toEqual([
      expect.objectContaining({ kind: "entry", itemId: "newer" }),
    ])
    expect(store.entry(source.key, "older")?.content).toBe("协会公布年度服务方案。")
  })

  it("判定落成 merged 与 keeper 角色，阅读快照同步不再单独占位", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(store, entry("older", "OpenAI 发布 GPT-6 模型", "2026-01-10T00:00:00.000Z"))
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型（更新）", "2026-01-10T06:00:00.000Z"),
    )
    const execute = fakeExecute(() => ({
      confidence: 0.93,
      duplicate: true,
      hide: "newer",
      keep: "older",
    }))

    const result = await runSemanticDedupe({
      aiConfig,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      store,
    })

    expect(result).toMatchObject({ batches: 1, candidates: 1, duplicates: 1, pending: 0 })
    const roles = rolesOf(store)
    expect(roles).toEqual([
      {
        itemId: "older",
        inputSeq: 1,
        kind: "keeper",
        reason: null,
        relatedEntryIds: ["newer"],
        // 列表预览沿用保存的来源与标题，冷态详情也能立即展示报道。
        relatedEntryPreviews: [
          {
            itemId: "newer",
            title: "OpenAI 发布 GPT-6 模型（更新）",
            sourceTitle: "科技媒体",
            publishedAt: "2026-01-10T06:00:00.000Z",
            url: "https://example.test/newer",
          },
        ],
        storyId: null,
        storyTitle: null,
        // 服务端材料计数包含保留条目本身，不依赖客户端已加载数量。
        materialCount: 2,
      },
      {
        itemId: "newer",
        inputSeq: 2,
        kind: "merged",
        reason: "《OpenAI 发布 GPT-6 模型（更新）》 → 《OpenAI 发布 GPT-6 模型》\n同一核心事件",
        relatedEntryIds: ["older"],
        storyId: null,
        storyTitle: null,
        // 服务端材料计数包含保留条目本身，不依赖客户端已加载数量。
        materialCount: 2,
      },
    ])

    const snapshot = store.reading.refresh()
    expect(store.reading.counts(snapshot.id)).toMatchObject({ standalone: 1 })
    expect(snapshot.maxSeq).toBe(2)
  })

  it("正文换代后旧判定立即失效，不会沿用上一版结论", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(store, entry("older", "OpenAI 发布 GPT-6 模型", "2026-01-10T00:00:00.000Z"))
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型（更新）", "2026-01-10T06:00:00.000Z"),
    )
    await runSemanticDedupe({
      aiConfig,
      execute: fakeExecute(() => ({
        confidence: 0.93,
        duplicate: true,
        hide: "newer",
        keep: "older",
      })) as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      store,
    })
    expect(rolesOf(store)).toHaveLength(2)

    // 修订正文会生成新的内容版本与输入序号，旧判定必须整体失效。
    store.saveEntry({
      ...entry("newer", "OpenAI 发布 GPT-6 模型（更新）", "2026-01-10T06:00:00.000Z"),
      content: "改写后的全新正文",
    })
    expect(rolesOf(store)).toEqual([])
  })

  it("删除去重动作即等于关闭语义去重", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(store, entry("older", "OpenAI 发布 GPT-6 模型", "2026-01-10T00:00:00.000Z"))
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型（更新）", "2026-01-10T06:00:00.000Z"),
    )
    await runSemanticDedupe({
      aiConfig,
      execute: fakeExecute(() => ({
        confidence: 0.93,
        duplicate: true,
        hide: "newer",
        keep: "older",
      })) as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      store,
    })
    expect(rolesOf(store)).toHaveLength(2)

    publishRules(store, [])
    expect(rolesOf(store)).toEqual([])
  })

  it("未命中规则范围的条目不参与判重", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [
      dedupeRule({
        anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["other-feed"] }] }],
      }),
    ])
    publishDecision(store, entry("older", "OpenAI 发布 GPT-6 模型", "2026-01-10T00:00:00.000Z"))
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型（更新）", "2026-01-10T06:00:00.000Z"),
    )
    const execute = fakeExecute(() => ({
      confidence: 0.93,
      duplicate: true,
      hide: "newer",
      keep: "older",
    }))

    const result = await runSemanticDedupe({
      aiConfig,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      store,
    })

    expect(result.candidates).toBe(0)
    expect(execute).not.toHaveBeenCalled()
    expect(rolesOf(store)).toEqual([])
  })

  it("保守判定与已扫完的条目都不会重复请求模型", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(store, entry("older", "OpenAI 发布 GPT-6 模型", "2026-01-10T00:00:00.000Z"))
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型（更新）", "2026-01-10T06:00:00.000Z"),
    )
    const execute = fakeExecute(() => ({
      confidence: 0.99,
      duplicate: false,
      hide: "newer",
      keep: "older",
    }))

    const first = await runSemanticDedupe({
      aiConfig,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      store,
    })
    const second = await runSemanticDedupe({
      aiConfig,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      store,
    })

    expect(first.candidates).toBe(1)
    expect(second.candidates).toBe(0)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(rolesOf(store)).toEqual([])
  })

  it("单轮预算用尽时不登记扫完，剩余候选留待下一轮", async () => {
    const { aiConfig, store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    // 30 条同标题、逐小时发布：全部落在 48 小时窗口内，可预筛出 29 对候选，超过单轮 24 对预算。
    for (let index = 0; index < 30; index += 1) {
      const at = new Date(Date.parse("2026-01-10T00:00:00.000Z") + index * 3_600_000).toISOString()
      publishDecision(store, entry(`item-${index}`, "OpenAI 发布 GPT-6 模型", at))
    }
    const execute = fakeExecute(() => ({
      confidence: 0.99,
      duplicate: false,
      hide: "",
      keep: "",
    }))
    const run = () =>
      runSemanticDedupe({
        aiConfig,
        execute: execute as never,
        runtimeDir: "/unused",
        signal: new AbortController().signal,
        store,
      })

    const first = await run()
    // 预算 24 对；多取的一个用来证明还有剩余，且此时不能把条目登记成"已扫完"。
    expect(first).toMatchObject({ batches: 3, candidates: 25, duplicates: 0 })
    expect(first.pending).toBeGreaterThan(0)
    const release = store.automation.releases()[0]!
    const fingerprints = new Set(
      activeDedupeActions(store.automation.release(release.version)).map(
        (action) => action.fingerprint,
      ),
    )
    // 回归点：预算用尽的轮次若登记扫完，下一轮这些条目两两之间会被永久跳过。
    expect(store.dedupe.settledItemIds(fingerprints).size).toBe(0)

    // 每轮每题只占一个名额，因此下一轮换一批新配对继续消化，而不是重复上一轮。
    let rounds = 1
    let current = first
    while (current.pending > 0 && rounds < 40) {
      current = await run()
      rounds += 1
    }
    expect(rounds).toBeLessThan(40)
    expect(current.pending).toBe(0)
    expect(store.dedupe.settledItemIds(fingerprints).size).toBe(30)

    const exhausted = await run()
    expect(exhausted).toMatchObject({ batches: 0, candidates: 0, pending: 0 })
  })

  it("未配置去重动作时不读取模型配置也不参与判重", async () => {
    const { store } = fixture()
    publishRules(store, [{ ...dedupeRule({ all: true }), enabled: false }])
    const result = await runSemanticDedupe({
      aiConfig: new AIConfigStore("/nonexistent-folo-ai-config.json"),
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      store,
    })
    expect(result).toMatchObject({ batches: 0, candidates: 0, duplicates: 0 })
  })
})

describe("去重根因回归", () => {
  it.each([
    { title: "银杉第三轮登记明日开始" },
    { description: "新增资格只适用于第三轮" },
    { author: "另一位独立作者" },
    { imageCount: 1, mediaLength: 1, context: { images: "complete" } },
    { attachmentsDuration: 60 },
    {
      linkedMaterials: [
        {
          url: "https://example.test/round3",
          resolvedUrl: null,
          title: "第三轮规则",
          content: "新增资格",
          status: "complete",
          failure: null,
        },
      ],
    },
  ] satisfies Partial<SourceEntry>[])(
    "正文相同但标题、附件或补充信息不同不能精确隐藏：%j",
    async (difference) => {
      // 关键事实可能只出现在标题、摘要、配图或外链，正文哈希不能代表整个条目。
      const { store, aiConfig } = fixture()
      publishRules(store, [dedupeRule({ all: true })])
      const content = "活动安排请查看当期标题与附件，不同轮次的资格、时间和步骤应分别核验。".repeat(
        4,
      )
      publishDecision(
        store,
        entry("older", "银杉第二轮领取今晚结束", "2026-01-10T00:00:00Z", content),
      )
      publishDecision(store, {
        ...entry("newer", "银杉第二轮领取今晚结束", "2026-01-10T01:00:00Z", content),
        ...difference,
      })
      const execute = negativeExecute()
      expect(await runFixture(store, aiConfig, execute)).toMatchObject({
        duplicates: 0,
        exactDuplicates: 0,
      })
      expect(rolesOf(store)).toEqual([])
      expect(store.automation.inputs()).toHaveLength(2)
    },
  )

  it("相隔14天的同标题同正文模板重发不能跨事件精确隐藏", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const content = "当期活动已经开始，资格和领取期限必须以当期公告为准。".repeat(5)
    publishDecision(store, entry("older", "本周活动公告", "2026-01-10T00:00:00Z", content))
    publishDecision(store, entry("newer", "本周活动公告", "2026-01-24T00:00:00Z", content))
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      candidates: 0,
      duplicates: 0,
      exactDuplicates: 0,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(rolesOf(store)).toEqual([])
  })

  it("Feed与List重复上下文保留原输入但只使用一份当前原文参与比较", async () => {
    const { store, aiConfig } = fixture()
    const otherSource = {
      ...source,
      key: "list/l1",
      kind: "list" as const,
      id: "l1",
      title: "科技列表",
    }
    store.replaceSources([source, otherSource])
    publishRules(store, [dedupeRule({ all: true })])
    const original = entry("same", "项目公告正式发布", "2026-01-10T00:00:00Z")
    publishDecision(store, original)
    publishDecision(store, { ...original, sourceKey: otherSource.key })
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      candidates: 0,
      duplicates: 0,
    })
    expect(execute).not.toHaveBeenCalled()
    publishDecision(
      store,
      entry("other", "项目公告正式发布", "2026-01-10T01:00:00Z", "另一条尚未核验的事实"),
    )
    const plan = prepareSemanticDedupe({ store })[0]!
    expect(plan.participants).toHaveLength(2)
    expect(
      plan.participants.find((participant) => participant.input.itemId === "same")?.input.sourceKey,
    ).toBe(otherSource.key)
    expect(
      await runSemanticDedupe({
        store,
        aiConfig,
        execute: execute as never,
        runtimeDir: "/unused",
        signal: new AbortController().signal,
        targets: [{ sourceKey: source.key, itemId: "same" }],
      }),
    ).toMatchObject({
      candidates: 1,
      duplicates: 0,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(store.automation.inputs()).toHaveLength(3)
    expect(rolesOf(store)).toEqual([])
  })

  it("同一原帖跨来源读态不一致时，已读参考不能替代明确未读的目标", async () => {
    // 多订阅的读态分别同步，不能只凭共享 itemId 把两篇已读参考交给模型比较。
    const { store, aiConfig } = fixture()
    const otherSource = {
      ...source,
      key: "list/l1",
      kind: "list" as const,
      id: "l1",
      title: "科技列表",
    }
    store.replaceSources([source, otherSource])
    publishRules(store, [dedupeRule({ all: true })])
    const original = entry("same", "项目公告正式发布", "2026-01-10T00:00:00Z")
    publishDecision(store, original)
    store.saveEntry({ ...original, read: true })
    store.processingState.setMaterial(store.automation.current(source.key, "same")!, "complete")
    publishDecision(store, {
      ...original,
      sourceKey: otherSource.key,
      content: "未读版本补充了新的资格条件。",
    })
    const reference = entry(
      "reference",
      "项目公告正式发布",
      "2026-01-10T01:00:00Z",
      "已读来源保留旧活动事实。",
    )
    publishDecision(store, reference)
    store.saveEntry({ ...reference, read: true })
    store.processingState.setMaterial(
      store.automation.current(source.key, "reference")!,
      "complete",
    )
    const cutoffAt = "2026-01-11T00:00:00Z"
    const targets = [{ sourceKey: otherSource.key, itemId: "same" }]
    const plan = prepareSemanticDedupe({ store, cutoffAt, targets })[0]!
    expect(
      plan.participants.find((participant) => participant.input.itemId === "same"),
    ).toMatchObject({ readReference: false, input: { sourceKey: otherSource.key } })
    expect(plan.candidates).toHaveLength(1)
    const execute = negativeExecute()
    expect(
      await runSemanticDedupe({
        store,
        aiConfig,
        cutoffAt,
        targets,
        execute: execute as never,
        runtimeDir: "/unused",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ candidates: 1, duplicates: 0 })
    expect(execute.mock.calls[0]![0].prompt).toContain("未读版本补充了新的资格条件。")
    expect(store.entry(source.key, "same")?.read).toBe(true)
    expect(store.entry(otherSource.key, "same")?.read).toBe(false)
  })

  it("旧版本判定失去投影资格，原文及旧关系保留且不重算全部历史", async () => {
    const { store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    const plan = prepareSemanticDedupe({ store })[0]!
    const keep = plan.participants.find(
      (participant) => participant.input.itemId === "older",
    )!.input
    const hide = plan.participants.find(
      (participant) => participant.input.itemId === "newer",
    )!.input
    const candidate = plan.candidates[0]!
    const legacyFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 6,
          ruleId: "dedupe-rule",
          scope: { all: true },
          when: { all: true },
        }),
      )
      .digest("hex")
    store.dedupe.saveBatch({
      configFingerprint: legacyFingerprint,
      ruleId: "dedupe-rule",
      model: "exact-content-v1",
      provider: "local",
      decisions: [
        {
          candidate,
          keep,
          hide,
          evaluation: {
            pairKey: candidate.pairKey,
            duplicate: true,
            confidence: 1,
            keepEntryId: keep.itemId,
            hideEntryId: hide.itemId,
            reason: "旧判定",
          },
        },
      ],
    })
    expect(store.dedupe.merges(new Set([legacyFingerprint]))).toHaveLength(1)
    expect(rolesOf(store)).toEqual([])
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(0)
    expect(prepareSemanticDedupe({ store })[0]!.candidates).toHaveLength(1)
    expect(store.automation.inputs()).toHaveLength(2)
  })

  it.each(["missing_result", "invalid_result"] as const)(
    "%s冷却后只补判一次，扫描缓存不阻断补判且正文更新重置次数",
    async (status) => {
      // 用假时钟验证真实数据库与调度入口，不等待实际冷却，也不连接模型。
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime("2026-01-11T00:00:00Z")
      const { store, aiConfig } = fixture()
      publishRules(store, [dedupeRule({ all: true })])
      publishPair(store)
      const execute = negativeExecute()
      const original = execute.getMockImplementation()!
      execute.mockImplementation(async (options) => {
        const response = await original(options)
        return {
          ...response,
          result: {
            results:
              status === "missing_result"
                ? []
                : response.result.results.flatMap((result) => [result, result]),
          },
        }
      })
      expect(await runFixture(store, aiConfig, execute)).toMatchObject({
        batches: 1,
        unresolved: 1,
      })
      const fingerprints = fingerprintsOf(store)
      expect(store.dedupe.decidedPairKeys(fingerprints).size).toBe(0)
      expect(store.dedupe.unresolvedDecisions(fingerprints)[0]).toMatchObject({
        status,
        attempts: 1,
      })
      expect(await runFixture(store, aiConfig, execute)).toMatchObject({
        candidates: 0,
        unresolved: 1,
      })
      vi.setSystemTime("2026-01-11T00:01:01Z")
      expect(await runFixture(store, aiConfig, execute)).toMatchObject({
        candidates: 1,
        unresolved: 1,
      })
      expect(store.dedupe.unresolvedDecisions(fingerprints)[0]).toMatchObject({ attempts: 2 })
      vi.setSystemTime("2026-01-11T00:02:02Z")
      expect(await runFixture(store, aiConfig, execute)).toMatchObject({
        candidates: 0,
        unresolved: 1,
      })
      expect(execute).toHaveBeenCalledTimes(2)
      publishDecision(
        store,
        entry(
          "newer",
          "OpenAI 发布 GPT-6 模型",
          "2026-01-10T06:00:00Z",
          "新版补充了新的执行条件。",
        ),
      )
      expect(await runFixture(store, aiConfig, execute)).toMatchObject({
        candidates: 1,
        unresolved: 1,
      })
      expect(store.dedupe.unresolvedDecisions(fingerprints)[0]).toMatchObject({ attempts: 1 })
      expect(execute).toHaveBeenCalledTimes(3)
    },
  )

  it("uncertain与incomplete单独保留状态，补齐正文后才重新判定", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    const uncertain = fakeExecute(() => ({
      duplicate: false,
      confidence: 0.9,
      keep: "",
      hide: "",
      factComparison: { verdict: "uncertain", onlyInFirst: [], onlyInSecond: [] },
    }))
    expect(await runFixture(store, aiConfig, uncertain)).toMatchObject({ unresolved: 1 })
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(0)
    expect(store.dedupe.unresolvedDecisions(fingerprintsOf(store))[0]?.status).toBe("uncertain")
    expect(await runFixture(store, aiConfig, uncertain)).toMatchObject({
      candidates: 0,
      unresolved: 1,
    })
    expect(uncertain).toHaveBeenCalledTimes(1)
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型", "2026-01-10T06:00:00Z", "字".repeat(4001)),
    )
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 0, unresolved: 1 })
    expect(store.dedupe.unresolvedDecisions(fingerprintsOf(store))[0]?.status).toBe("incomplete")
    expect(execute).not.toHaveBeenCalled()
    publishDecision(
      store,
      entry(
        "newer",
        "OpenAI 发布 GPT-6 模型",
        "2026-01-10T06:00:00Z",
        "完整的新事实，双方各有独有信息。",
      ),
    )
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 1, unresolved: 0 })
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(1)
    expect(rolesOf(store)).toEqual([])
  })

  it("附件或引用未补齐时不执行精确或语义隐藏", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const content = "附件中包含各轮次的资格与截止条件，正文不能替代配图。".repeat(5)
    publishDecision(store, entry("older", "活动公告", "2026-01-10T00:00:00Z", content))
    publishDecision(store, {
      ...entry("newer", "活动公告", "2026-01-10T01:00:00Z", content),
      imageCount: 1,
      mediaLength: 1,
      context: { images: "missing" },
    })
    const execute = duplicateExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 0,
      duplicates: 0,
      unresolved: 1,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(rolesOf(store)).toEqual([])
  })

  it.each([true, null] as const)("成功条目当前读态为 %s 时不进入去重候选", async (read) => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    // 来源读态变化不换代，验证输入保存的旧未读值不会带来额外付费。
    const saved = store.entry(source.key, "newer")!
    store.saveEntry({ ...saved, read })
    const execute = negativeExecute()
    const result = await runFixture(store, aiConfig, execute)
    expect(execute).not.toHaveBeenCalled()
    expect(result.candidates).toBe(0)
    expect(result.exactDuplicates).toBe(0)
    expect(store.processingState.published()).toHaveLength(2)
  })

  it("三篇首轮两对否定后仍需比较第三对，全部三对判完才登记扫描", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    publishDecision(store, entry("third", "OpenAI 发布 GPT-6 模型", "2026-01-10T08:00:00.000Z"))
    const execute = negativeExecute()
    const first = await runFixture(store, aiConfig, execute)
    expect(first).toMatchObject({ candidates: 2, pending: 1 })
    expect(store.dedupe.settledItemIds(fingerprintsOf(store)).size).toBe(0)
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ candidates: 1, pending: 0 })
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(3)
    expect(store.dedupe.settledItemIds(fingerprintsOf(store)).size).toBe(3)
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 0 })
  })

  it("混合完整和超限正文的批次只统计实际发出的独立比较", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(
      store,
      entry("older", "同一核心事件", "2026-01-10T00:00:00Z", "字".repeat(4001)),
    )
    publishDecision(store, entry("newer", "同一核心事件", "2026-01-10T06:00:00Z", "完整版本A。"))
    publishDecision(store, entry("newest", "同一核心事件", "2026-01-10T12:00:00Z", "完整版本B。"))
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 1,
      dedicatedComparisons: 1,
      unknownUsageRequests: 1,
    })
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 0,
      dedicatedComparisons: 0,
      unknownUsageRequests: 0,
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("重叠规则分别保存应用，但同一内容关系只比较一次", async () => {
    const { store, aiConfig } = fixture()
    publishRules(
      store,
      Array.from({ length: 4 }, (_, index) => ({
        ...dedupeRule({ all: true }),
        id: `rule-${index}`,
        order: index,
      })),
    )
    publishPair(store)
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 1,
      pending: 0,
      relationCacheHits: 3,
      dedicatedComparisons: 1,
      unknownUsageRequests: 1,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    const actions = activeDedupeActions(
      store.automation.release(store.automation.releases()[0]!.version),
    )
    expect(
      actions.map((action) => store.dedupe.decidedPairKeys(new Set([action.fingerprint])).size),
    ).toEqual([1, 1, 1, 1])
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 0, pending: 0 })
  })

  it("跨任务改规则复用证据关系，正文变化会重新比较，人工恢复和范围仍优先", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    const execute = duplicateExecute()
    await runFixture(store, aiConfig, execute)
    publishRules(store, [{ ...dedupeRule({ all: true }), id: "new-rule" }])
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 0,
      relationCacheHits: 1,
    })
    expect(rolesOf(store).some((role) => role.kind === "merged")).toBe(true)
    store.processingState.setOverride(2, "restore", 0)
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ candidates: 0, batches: 0 })
    expect(rolesOf(store).some((role) => role.kind === "merged")).toBe(false)
    store.processingState.setOverride(2, "automatic", 1)
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型", "2026-01-10T06:00:00Z", "新版补充不同的申请期限。"),
    )
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 1,
      relationCacheHits: 0,
    })
    // 正文相同但引用上下文换代，也不能复用先前的材料关系。
    publishDecision(store, {
      ...entry(
        "newer",
        "OpenAI 发布 GPT-6 模型",
        "2026-01-10T06:00:00Z",
        "新版补充不同的申请期限。",
      ),
      context: { links: "complete" },
    })
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 1,
      relationCacheHits: 0,
    })
    publishRules(store, [
      {
        ...dedupeRule({ all: true }),
        when: { anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["excluded"] }] }] },
      },
    ])
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ candidates: 0, batches: 0 })
    expect(rolesOf(store)).toEqual([])
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it("本地严格同文在共享预筛前排除，不消耗语义额度", () => {
    const { store } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const content = "完整事实正文。".repeat(20)
    for (let index = 0; index < 30; index++)
      publishDecision(store, entry(`exact-${index}`, "相同标题", "2026-01-10T00:00:00Z", content))
    const plan = prepareSemanticDedupe({ store })[0]!
    expect(plan.exact).toHaveLength(29)
    expect(plan.candidates).toEqual([])
    expect(plan.participants).toHaveLength(30)
  })

  it("只修改when会立即撤销旧merged角色，恢复也优先于去重", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    await runFixture(store, aiConfig, duplicateExecute())
    const fingerprints = fingerprintsOf(store)
    expect(rolesOf(store)).toHaveLength(2)
    store.processingState.setOverride(2, "restore", 0)
    expect(rolesOf(store)).toEqual([expect.objectContaining({ itemId: "newer", kind: "restored" })])
    store.processingState.setOverride(2, "automatic", 1)
    expect(rolesOf(store)).toHaveLength(2)
    publishRules(store, [
      {
        ...dedupeRule({ all: true }),
        when: { anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["excluded"] }] }] },
      },
    ])
    expect(fingerprintsOf(store)).not.toEqual(fingerprints)
    expect(rolesOf(store)).toEqual([])
  })

  it("只更换当前上下文也要读时检查when/scope，不沿用静态指纹", async () => {
    const { store, aiConfig } = fixture()
    const scope: ConditionSet = {
      anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["f1"] }] }],
    }
    publishRules(store, [dedupeRule(scope)])
    publishPair(store)
    await runFixture(store, aiConfig, duplicateExecute())
    const published = store.processingState.published.bind(store.processingState)
    vi.spyOn(store.processingState, "published").mockImplementation(() =>
      published().map((item) => ({
        ...item,
        decision: { ...item.decision, context: { ...item.decision.context, source_id: "outside" } },
      })),
    )
    expect(rolesOf(store)).toEqual([])
    expect(store.reading.counts(store.reading.refresh().id).standalone).toBe(2)
  })

  it("模型执行中正文换代并完成新否定判定，晚到旧肯定不能覆盖新结论", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    const execute = fakeExecute(() => ({
      duplicate: true,
      confidence: 0.93,
      keep: "older",
      hide: "newer",
    }))
    const old = execute.getMockImplementation()!
    execute.mockImplementationOnce(async (options) => {
      publishDecision(
        store,
        entry("newer", "OpenAI 发布 GPT-6 模型", "2026-01-10T06:00:00.000Z", "已经发生的新事实"),
      )
      await runFixture(store, aiConfig)
      return old(options)
    })
    await runFixture(store, aiConfig, execute)
    expect(rolesOf(store)).toEqual([])
    expect(store.dedupe.merges(fingerprintsOf(store))).toEqual([])
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(1)
    expect(await runFixture(store, aiConfig)).toMatchObject({ batches: 0 })
  })

  it("可读Story成员不重复付费，正文换代使Story失效后成员重新参与", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    const storyId = createStory(store, store.automation.inputs())
    publishDecision(store, entry("third", "OpenAI 发布 GPT-6 模型", "2026-01-10T08:00:00.000Z"))
    expect([...store.reading.representedInputSeqs()]).toEqual([1, 2])
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 0, candidates: 0 })
    expect(execute).not.toHaveBeenCalled()
    publishDecision(
      store,
      entry("newer", "OpenAI 发布 GPT-6 模型", "2026-01-10T06:00:00.000Z", "正文换代后的新事实"),
    )
    expect([...store.reading.representedInputSeqs()]).toEqual([])
    expect(store.stories.resolveLink(storyId).kind).toBe("repairing")
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 1,
      candidates: 2,
      pending: 1,
    })
  })

  it("saveBatch和markScanned拒绝同正文的序号、代次、状态换代，旧结果不覆盖新记录", () => {
    const db = new DatabaseSync(":memory:")
    try {
      const inputs: ProcessingInput[] = ["older", "newer"].map((id, index) => ({
        seq: index + 1,
        sourceKey: source.key,
        itemId: id,
        contentVersion: "v1",
        current: true,
        generation: 1,
        status: "succeeded",
        receivedAt: "now",
        releaseVersion: 1,
        body: entry(id, "同一标题", `2026-01-10T0${index}:00:00.000Z`),
      }))
      const store = new ProcessingDedupeStore(db, () => inputs)
      const originals = inputs.map((input) => ({ ...input }))
      const candidate = getSemanticDuplicateCandidates(
        originals.map((input) => ({
          itemId: input.itemId,
          title: input.body.title!,
          description: "",
          sourceTitle: "test",
          publishedAt: input.body.publishedAt,
          urlHost: "example.test",
        })),
      )[0]!
      const save = (keep: ProcessingInput, hide: ProcessingInput, duplicate: boolean) =>
        store.saveBatch({
          configFingerprint: "test",
          ruleId: "rule",
          model: "fake",
          provider: "local",
          decisions: [
            {
              candidate,
              keep,
              hide,
              evaluation: {
                pairKey: candidate.pairKey,
                duplicate,
                confidence: 1,
                reason: "测试",
                keepEntryId: keep.itemId,
                hideEntryId: hide.itemId,
              },
            },
          ],
        })
      for (const changed of [
        { seq: 9 },
        { generation: 2 },
        { status: "pending" },
        { contentVersion: "v2" },
        { current: false },
      ]) {
        inputs[1] = { ...originals[1]!, ...changed }
        expect(save(originals[0]!, originals[1]!, true).size).toBe(0)
        store.markScanned("test", [originals[1]!])
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM processing_dedupe_scans").get()?.count,
        ).toBe(0)
      }
      inputs[1] = { ...originals[1]!, seq: 9, generation: 2 }
      expect(save(inputs[0]!, inputs[1]!, false).size).toBe(1)
      // 持久化入口也拒绝同一输入自配对，防止绕过上游校验写入无效关系。
      expect(save(inputs[0]!, inputs[0]!, true).size).toBe(0)
      expect(save(originals[0]!, originals[1]!, true).size).toBe(0)
      expect(store.merges(new Set(["test"]))).toEqual([])
      expect(store.decidedPairKeys(new Set(["test"])).size).toBe(1)
    } finally {
      db.close()
    }
  })

  it("完整展示内容相同先本地折叠，来源和原文全部保留，人工恢复保持可见", async () => {
    const { store, aiConfig } = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "转载来源" }
    store.replaceSources([source, otherSource])
    publishRules(store, [dedupeRule({ all: true })])
    const content = "这是逐字相同的转载正文，只有同一组事实，没有独立观点或后续变化。".repeat(5)
    publishDecision(store, entry("older", "原始报道", "2026-01-10T00:00:00.000Z", content))
    publishDecision(store, {
      ...entry("newer", "原始报道", "2026-01-10T06:00:00.000Z", content),
      sourceKey: otherSource.key,
    })
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 0,
      duplicates: 1,
      exactDuplicates: 1,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(store.automation.inputs().map((input) => input.body.content)).toEqual([content, content])
    expect(store.automation.inputs().map((input) => input.sourceKey)).toEqual([
      source.key,
      otherSource.key,
    ])
    expect(rolesOf(store).find((role) => role.itemId === "newer")?.kind).toBe("merged")
    store.processingState.setOverride(2, "restore", 0)
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "newer", kind: "restored", inputSeq: 2 }),
    ])
    expect(store.reading.counts(store.reading.refresh().id).standalone).toBe(2)
    // 人工保留可从原位撤销；不改原文读态，也不重新请求模型。
    store.processingState.setOverride(2, "automatic", 1)
    expect(rolesOf(store).find((role) => role.itemId === "newer")?.kind).toBe("merged")
    expect(store.entry(otherSource.key, "newer")?.read).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it("旧同文不阻断新时间组，长文在本地折叠且不跨窗口串联", async () => {
    // 覆盖过旧代表与连续窗口两种边界，不能靠语义模型弥补精确层遗漏。
    for (const hours of [
      [0, 240, 242],
      [0, 47, 94],
    ]) {
      const { store, aiConfig } = fixture()
      publishRules(store, [dedupeRule({ all: true })])
      const content = "活动完整规则包含资格条件和截止时点。".repeat(400)
      const base = Date.parse("2026-01-01T00:00:00.000Z")
      for (const [index, hour] of hours.entries())
        publishDecision(
          store,
          entry(
            String(index),
            "同文公告",
            new Date(base + hour * 3_600_000).toISOString(),
            content,
          ),
        )
      const execute = negativeExecute()
      expect(await runFixture(store, aiConfig, execute)).toMatchObject({
        exactDuplicates: 1,
        batches: 0,
      })
      const expectedHide = hours[1] === 240 ? "2" : "1"
      expect(
        rolesOf(store)
          .filter((role) => role.kind === "merged")
          .map((role) => role.itemId),
      ).toEqual([expectedHide])
      expect(execute).not.toHaveBeenCalled()
    }
  })

  it("低把握否定保持待确认，旧判定与内容缓存也不能伪装确定结论", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    const candidate = prepareSemanticDedupe({ store })[0]!.candidates[0]!
    const execute = fakeExecute(() => ({ duplicate: false, confidence: 0.1, keep: "", hide: "" }))
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ unresolved: 1, batches: 1 })
    const fingerprints = fingerprintsOf(store)
    expect(store.dedupe.decidedPairKeys(fingerprints).size).toBe(0)
    expect(store.dedupe.unresolvedDecisions(fingerprints)[0]?.status).toBe("uncertain")
    // 重现旧版写入的低置信 decided，读时升级语义，不清空全部缓存或重扫历史。
    const db = new DatabaseSync(":memory:")
    try {
      const legacy = new ProcessingDedupeStore(db, () => store.automation.inputs())
      const relation = store.dedupe.relation(candidate)!
      const inputs = store.automation.inputs()
      legacy.saveRelation(candidate, relation)
      legacy.saveBatch({
        configFingerprint: [...fingerprints][0]!,
        ruleId: "dedupe-rule",
        provider: "qianwen",
        model: "test-model",
        decisions: [
          { candidate, evaluation: relation.evaluation, keep: inputs[0]!, hide: inputs[1]! },
        ],
      })
      db.prepare("UPDATE processing_dedupe_decisions SET evaluation_status='decided'").run()
      db.prepare(
        "UPDATE processing_dedupe_relations SET evaluation_json=json_set(evaluation_json,'$.status','decided')",
      ).run()
      expect(legacy.decidedPairKeys(fingerprints).size).toBe(0)
      expect(legacy.unresolvedDecisions(fingerprints)[0]?.status).toBe("uncertain")
      expect(legacy.relation(candidate)?.evaluation.status).toBe("uncertain")
    } finally {
      db.close()
    }
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 0, unresolved: 1 })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("精确判定保存被拒绝时不能提前排除该对的语义候选", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const content = "相同原文事实。".repeat(20)
    publishDecision(store, entry("older", "同一标题", "2026-01-10T00:00:00.000Z", content))
    publishDecision(store, entry("newer", "同一标题", "2026-01-10T06:00:00.000Z", content))
    // 模拟精确层版本校验拒绝写入；没有有效关系时条目仍必须进入后续比较。
    vi.spyOn(store.dedupe, "saveBatch").mockImplementationOnce(() => new Set())
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({
      batches: 1,
      candidates: 1,
      duplicates: 0,
      exactDuplicates: 0,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(rolesOf(store)).toEqual([])
  })

  it("canonical URL及展示内容一致可免模型，原帖不同版本保留且不自比较", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(store, {
      ...entry("older", "同一标题", "2026-01-10T00:00:00.000Z", "严格相同短原文"),
      url: "https://example.test/article?utm_source=a#one",
    })
    publishDecision(store, {
      ...entry("newer", "同一标题", "2026-01-10T06:00:00.000Z", "严格相同短原文"),
      url: "https://example.test/article?utm_source=b#two",
    })
    expect(await runFixture(store, aiConfig)).toMatchObject({
      batches: 0,
      duplicates: 1,
      exactDuplicates: 1,
    })
    publishDecision(store, {
      ...entry("newer", "同一标题", "2026-01-10T06:00:00.000Z", "后来发生的新事实"),
      url: "https://example.test/article",
    })
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 0, duplicates: 0 })
    expect(execute).not.toHaveBeenCalled()
    expect(rolesOf(store)).toEqual([])
  })

  it("正文尾部变化不能因相同摘要或截断正文被精确层误折叠", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const prefix = "相同的旧事件背景，摘要不能替代完整正文。".repeat(50)
    publishDecision(
      store,
      entry("older", "同一标题", "2026-01-10T00:00:00.000Z", `${prefix} 原结论`),
    )
    publishDecision(
      store,
      entry("newer", "同一标题", "2026-01-10T06:00:00.000Z", `${prefix} 新进展与独立观点`),
    )
    const execute = negativeExecute()
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 1, duplicates: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(rolesOf(store)).toEqual([])
  })
})

// 精确重复也必须受事件目标约束，不能顺便合并完全未加载的材料。
describe("列表目标限定去重", () => {
  it("仅保存至少一侧为目标的精确转载关系，扫描记录不触碰旁观材料", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    const content = "已经完整验证的同一条原始报道，事实相同，没有新增信息。".repeat(5)
    for (const id of ["older", "target", "unloaded"])
      publishDecision(store, entry(id, "同一报道", "2026-01-10T00:00:00Z", content))
    const execute = negativeExecute()
    const result = await runSemanticDedupe({
      store,
      aiConfig,
      runtimeDir: "/unused",
      execute: execute as never,
      signal: new AbortController().signal,
      targets: [{ sourceKey: source.key, itemId: "target" }],
    })
    expect(result.exactDuplicates).toBe(1)
    expect(execute).not.toHaveBeenCalled()
    expect(rolesOf(store).find((role) => role.itemId === "target")?.kind).toBe("merged")
    expect(rolesOf(store).find((role) => role.itemId === "unloaded")).toBeUndefined()
    expect(store.dedupe.settledItemIds(fingerprintsOf(store)).has("unloaded")).toBe(false)
    expect(store.dedupe.settledItemIds(fingerprintsOf(store)).has("older")).toBe(false)
  })
  it("语义预筛在限额前排除两侧都不是列表目标的相似候选", () => {
    const entries = ["old1", "old2", "target"].map((itemId, index) => ({
      itemId,
      title: "同一事件相关报道",
      sourceTitle: "来源",
      description: "同一事件事实",
      publishedAt: `2026-01-10T0${index}:00:00Z`,
      urlHost: "example.test",
    }))
    const candidates = getSemanticDuplicateCandidates(entries, {
      maxCandidates: 1,
      targetItemIds: new Set(["target"]),
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.entries.some((entry) => entry.itemId === "target")).toBe(true)
  })
})

// 已读仅提供最近 24 小时的缓存参考，所有模型回归继续使用本地假执行器。
describe("最近 24 小时已读参考", () => {
  const cutoffAt = "2026-01-11T00:00:00Z"
  function addRead(
    store: Store,
    publishedAt = "2026-01-10T00:00:00Z",
    content = "已读来源的完整事实。",
    id = "read",
  ) {
    store.saveEntry({ ...entry(id, "同一事件报道", publishedAt, content), read: true })
    const input = store.automation.inputs().at(-1)!
    store.processingState.setMaterial(input, "complete")
    return input
  }
  function run(
    store: Store,
    aiConfig: AIConfigStore,
    execute = negativeExecute(),
    extra: Partial<Parameters<typeof runSemanticDedupe>[0]> = {},
  ) {
    return runSemanticDedupe({
      store,
      aiConfig,
      cutoffAt,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      execute: execute as never,
      ...extra,
    })
  }
  function setup() {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(
      store,
      entry("unread", "同一事件报道", "2026-01-10T12:00:00Z", "未读来源的完整事实。"),
    )
    return { store, aiConfig }
  }

  it("未发布决定的完整已读缓存参与等价比较，保留已读且不处理参考", async () => {
    const { store, aiConfig } = setup()
    const read = addRead(store)
    const execute = fakeExecute(() => ({
      duplicate: true,
      confidence: 0.99,
      keep: "unread",
      hide: "read",
    }))
    expect(await run(store, aiConfig, execute)).toMatchObject({ duplicates: 1, candidates: 1 })
    expect(store.dedupe.merges(fingerprintsOf(store))).toEqual([
      expect.objectContaining({
        keepReference: true,
        keep: expect.objectContaining({ itemId: "read" }),
        hide: expect.objectContaining({ itemId: "unread" }),
      }),
    ])
    expect(store.automation.inputs().find((input) => input.seq === read.seq)).toMatchObject({
      status: "pending",
      generation: read.generation,
      releaseVersion: read.releaseVersion,
    })
    expect(store.processingState.published()).toHaveLength(1)
    expect(store.dedupe.settledItemIds(fingerprintsOf(store)).has("read")).toBe(false)
  })

  it("已读完整报道覆盖未读简版时隐藏未读", async () => {
    const { store, aiConfig } = setup()
    addRead(store)
    const execute = fakeExecute(() => ({
      duplicate: true,
      confidence: 0.99,
      keep: "unread",
      hide: "read",
      factComparison: {
        verdict: "second_contains_first",
        onlyInFirst: [],
        onlyInSecond: ["已读有完整的额外事实"],
      },
    }))
    expect(await run(store, aiConfig, execute)).toMatchObject({ duplicates: 1 })
    expect(store.dedupe.merges(fingerprintsOf(store))[0]?.hide.itemId).toBe("unread")
  })

  it("未读包含额外事实时保留双方且永不隐藏已读", async () => {
    const { store, aiConfig } = setup()
    addRead(store)
    const execute = fakeExecute(() => ({
      duplicate: true,
      confidence: 0.99,
      keep: "read",
      hide: "unread",
      factComparison: {
        verdict: "first_contains_second",
        onlyInFirst: ["未读有新的实施计划"],
        onlyInSecond: [],
      },
    }))
    expect(await run(store, aiConfig, execute)).toMatchObject({ duplicates: 0, pending: 0 })
    expect(store.dedupe.merges(fingerprintsOf(store))).toEqual([])
    expect(store.dedupe.decidedPairKeys(fingerprintsOf(store)).size).toBe(1)
  })

  it.each(["2026-01-09T23:59:59Z", "2026-01-11T00:00:01Z", "invalid"])(
    "已读时间 %s 不进入语义或精确层",
    async (publishedAt) => {
      const { store, aiConfig } = setup()
      addRead(store, publishedAt, store.entry(source.key, "unread")!.content!)
      const execute = negativeExecute()
      expect(await run(store, aiConfig, execute)).toMatchObject({
        candidates: 0,
        exactDuplicates: 0,
      })
      expect(execute).not.toHaveBeenCalled()
    },
  )

  it("精确转载即使已读较新也优先保留参考，后续年龄增长不移除已保存关系", async () => {
    const { store, aiConfig } = setup()
    const content = "同一组事实的完整原始报道，正文逐字相同。".repeat(8)
    publishDecision(store, entry("unread", "同一事件报道", "2026-01-10T12:00:00Z", content))
    addRead(store, "2026-01-10T23:00:00Z", content)
    const execute = negativeExecute()
    expect(await run(store, aiConfig, execute)).toMatchObject({ exactDuplicates: 1, batches: 0 })
    expect(execute).not.toHaveBeenCalled()
    expect(await run(store, aiConfig, execute, { cutoffAt: "2026-01-13T00:00:00Z" })).toMatchObject(
      { duplicates: 0 },
    )
    expect(store.dedupe.merges(fingerprintsOf(store))[0]?.keep.itemId).toBe("read")
  })

  it("缺失完整正文、未知读态、越界来源和人工恢复均排除参考", () => {
    const { store } = setup()
    const read = addRead(store)
    store.processingState.setMaterial(read, "missing")
    expect(
      prepareSemanticDedupe({ store, cutoffAt })[0]?.participants.map((item) => item.input.itemId),
    ).toEqual(["unread"])
    store.processingState.setMaterial(read, "complete")
    store.saveEntry({ ...store.entry(source.key, "read")!, read: null })
    expect(prepareSemanticDedupe({ store, cutoffAt })[0]?.participants).toHaveLength(1)
    store.saveEntry({ ...store.entry(source.key, "read")!, read: true })
    expect(
      prepareSemanticDedupe({ store, cutoffAt, sourceKeys: [] })[0]?.participants,
    ).toHaveLength(0)
    store.processingState.setOverride(read.seq, "restore", 0)
    expect(prepareSemanticDedupe({ store, cutoffAt })[0]?.participants).toHaveLength(1)
  })

  it("双方已读不比较、不付费、不登记扫描；已读目标也不能触发比较", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    addRead(store)
    addRead(store, "2026-01-10T03:00:00Z", "另一条完整缓存正文。", "read2")
    const execute = negativeExecute()
    expect(await run(store, aiConfig, execute)).toMatchObject({ candidates: 0, batches: 0 })
    expect(store.dedupe.settledItemIds(fingerprintsOf(store)).size).toBe(0)
    publishDecision(store, entry("unread", "同一事件报道", "2026-01-10T12:00:00Z"))
    expect(
      await run(store, aiConfig, execute, { targets: [{ sourceKey: source.key, itemId: "read" }] }),
    ).toMatchObject({ candidates: 0 })
    expect(execute).not.toHaveBeenCalled()
  })

  it("准备中的未读与只读参考使用相同候选，既有扫描记录不阻断新参考", () => {
    const { store } = setup()
    const unread = store.automation.inputs()[0]!
    store.dedupe.markScanned([...fingerprintsOf(store)][0]!, [unread])
    const read = addRead(store)
    store.dedupe.markScanned([...fingerprintsOf(store)][0]!, [{ ...read, status: "succeeded" }])
    expect(prepareSemanticDedupe({ store, cutoffAt })[0]?.candidates).toHaveLength(1)
    store.saveEntry(entry("pending", "同一事件报道", "2026-01-10T13:00:00Z"))
    const pending = store.automation.inputs().at(-1)!
    store.processingState.setMaterial(pending, "complete")
    expect(
      prepareSemanticDedupe({
        store,
        cutoffAt,
        pendingInputs: [pending],
        targets: [{ sourceKey: source.key, itemId: "pending" }],
      })[0]?.candidates.some((candidate) =>
        candidate.entries.some((entry) => entry.itemId === "pending"),
      ),
    ).toBe(true)
  })

  it("模型调用期间未读变为已读时拒绝晚到隐藏", async () => {
    const { store, aiConfig } = setup()
    addRead(store)
    const execute = fakeExecute(() => {
      store.saveEntry({ ...store.entry(source.key, "unread")!, read: true })
      return { duplicate: true, confidence: 0.99, keep: "read", hide: "unread" }
    })
    expect(await run(store, aiConfig, execute)).toMatchObject({ duplicates: 0 })
    expect(store.dedupe.merges(fingerprintsOf(store))).toEqual([])
  })

  it("统一批次有效结果不重复付费，部分缺失仅请求余下候选，过期结果不能发布", async () => {
    const { store, aiConfig } = setup()
    addRead(store)
    publishDecision(
      store,
      entry("third", "同一事件报道", "2026-01-10T13:00:00Z", "第三篇完整正文。"),
    )
    const plan = prepareSemanticDedupe({ store, cutoffAt })[0]!
    const candidate = plan.candidates[0]!
    const prepared = {
      configFingerprint: plan.action.fingerprint,
      pairKey: candidate.pairKey,
      model: "batch-model",
      provider: "qianwen",
      inputs: plan.participants
        .filter((participant) =>
          candidate.entries.some((entry) => entry.itemId === participant.entry.itemId),
        )
        .map((participant) => participant.input),
      evaluation: {
        pairKey: candidate.pairKey,
        duplicate: false,
        confidence: 0.2,
        reason: "独立报道",
        keepEntryId: null,
        hideEntryId: null,
      },
    }
    const execute = negativeExecute()
    expect(
      await run(store, aiConfig, execute, { preparedEvaluations: [prepared], preparedOnly: true }),
    ).toMatchObject({ batches: 0 })
    expect(execute).not.toHaveBeenCalled()
    expect(await run(store, aiConfig, execute, { preparedEvaluations: [prepared] })).toMatchObject({
      batches: 1,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]![0].prompt).not.toContain(candidate.pairKey)
    const before = store.dedupe.merges(fingerprintsOf(store)).length
    expect(
      await run(store, aiConfig, execute, {
        preparedEvaluations: [
          {
            ...prepared,
            inputs: prepared.inputs.map((input) => ({
              ...input,
              generation: input.generation + 1,
            })),
            evaluation: {
              ...prepared.evaluation,
              duplicate: true,
              confidence: 1,
              keepEntryId: "read",
              hideEntryId: "unread",
            },
          },
        ],
        preparedOnly: true,
      }),
    ).toMatchObject({ duplicates: 0 })
    expect(store.dedupe.merges(fingerprintsOf(store))).toHaveLength(before)
  })
})
