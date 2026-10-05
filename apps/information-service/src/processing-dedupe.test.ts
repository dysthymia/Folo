import { randomUUID } from "node:crypto"
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
  fakeExecute(() => ({ duplicate: false, confidence: 0.4, keep: "", hide: "" }))
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
  stores.splice(0).forEach((store) => store.close())
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { force: true, recursive: true }))
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
        storyId: null,
        storyTitle: null,
        // 服务端材料计数包含保留条目本身，不依赖客户端已加载数量。
        materialCount: 2,
      },
      {
        itemId: "newer",
        inputSeq: 2,
        kind: "merged",
        reason: "同一核心事件",
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
      confidence: 0.4,
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
      confidence: 0.4,
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

  it("不同动作的否定和扫描不互用，所有动作共享三个批次预算", async () => {
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
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 3, pending: 1 })
    expect(execute).toHaveBeenCalledTimes(3)
    const actions = activeDedupeActions(
      store.automation.release(store.automation.releases()[0]!.version),
    )
    expect(
      actions.map((action) => store.dedupe.decidedPairKeys(new Set([action.fingerprint])).size),
    ).toEqual([1, 1, 1, 0])
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 1, pending: 0 })
  })

  it("只修改when会立即撤销旧merged角色，恢复也优先于去重", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishPair(store)
    await runFixture(store, aiConfig, duplicateExecute())
    const fingerprints = fingerprintsOf(store)
    expect(rolesOf(store)).toHaveLength(2)
    store.processingState.setOverride(2, "restore", 0)
    expect(rolesOf(store)).toEqual([])
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
      expect(save(originals[0]!, originals[1]!, true).size).toBe(0)
      expect(store.merges(new Set(["test"]))).toEqual([])
      expect(store.decidedPairKeys(new Set(["test"])).size).toBe(1)
    } finally {
      db.close()
    }
  })

  it("充分长度完整正文相同先本地折叠，来源和原文全部保留，人工恢复保持可见", async () => {
    const { store, aiConfig } = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "转载来源" }
    store.replaceSources([source, otherSource])
    publishRules(store, [dedupeRule({ all: true })])
    const content = "这是逐字相同的转载正文，只有同一组事实，没有独立观点或后续变化。".repeat(5)
    publishDecision(store, entry("older", "原始报道", "2026-01-10T00:00:00.000Z", content))
    publishDecision(store, {
      ...entry("newer", "来源不同的转载标题", "2026-01-10T06:00:00.000Z", content),
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
    expect(rolesOf(store)).toEqual([])
    expect(store.reading.counts(store.reading.refresh().id).standalone).toBe(2)
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

  it("canonical URL一致且短正文完全相同可免模型，正文不同或仅标题相同仍走保守语义", async () => {
    const { store, aiConfig } = fixture()
    publishRules(store, [dedupeRule({ all: true })])
    publishDecision(store, {
      ...entry("older", "同一标题", "2026-01-10T00:00:00.000Z", "严格相同短原文"),
      url: "https://example.test/article?utm_source=a#one",
    })
    publishDecision(store, {
      ...entry("newer", "另一个标题", "2026-01-10T06:00:00.000Z", "严格相同短原文"),
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
    expect(await runFixture(store, aiConfig, execute)).toMatchObject({ batches: 1, duplicates: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
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
