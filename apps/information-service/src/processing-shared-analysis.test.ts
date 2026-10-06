import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import type { RuleSet } from "@follow/information-core"
import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions, runCodexJson } from "./codex"
import { CodexRunError } from "./codex"
import { runSemanticDedupe } from "./processing-dedupe"
import { runEntryProcessing, settleReadStates } from "./processing-engine"
import { SharedAnalysisSession } from "./processing-shared-analysis"
import { Store } from "./store"
import { runStoryAggregation } from "./story-engine"

const stores: Store[] = []
const dirs: string[] = []
const cutoffAt = "2026-10-05T12:00:00.000Z"
const sourceKeys = ["feed/1"]

function fixture(story = true, quoteOnly = false) {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  const source = {
    key: "feed/1",
    id: "1",
    kind: "feed" as const,
    title: "测试来源",
    view: 0,
    category: "科技",
  }
  store.replaceSources([source])
  store.sourceSync.replaceSources([source], cutoffAt)
  const draft = store.automation.draft()
  const rules: RuleSet["rules"] = [
    {
      id: "dedupe",
      ownerId: "owner",
      name: "去重",
      enabled: true,
      order: 0,
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "ai_dedupe", scope: { all: true } }],
    },
  ]
  if (story)
    rules.push({
      id: "story",
      ownerId: "owner",
      name: "事件综述",
      enabled: true,
      order: 1,
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [
        {
          type: "ai_aggregate",
          mode: "same_event",
          scope: { all: true },
          createPrompt: "忠实综合不同来源的补充事实",
          updatePrompt: "保留已有身份并补充新事实",
        },
      ],
    })
  if (quoteOnly) rules[0]!.actions.push({ type: "presentation", policy: { rewrite: "deny" } })
  store.automation.saveDraft({ ...draft.config, rules }, draft.revision)
  store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
  const dir = mkdtempSync(join(tmpdir(), "folo-shared-analysis-"))
  dirs.push(dir)
  const configPath = join(dir, "ai.json")
  writeFileSync(configPath, JSON.stringify({ provider: "codex", model: "test-model" }))
  const aiConfig = new AIConfigStore(configPath)
  const options = { store, aiConfig, runtimeDir: dir, sourceKeys, cutoffAt }
  return { ...options, sharedAnalysis: new SharedAnalysisSession(options) }
}

function save(
  options: ReturnType<typeof fixture>,
  id: string,
  content: string,
  read = false,
  publishedAt = "2026-10-05T10:00:00.000Z",
) {
  options.store.saveEntry({
    id,
    sourceKey: "feed/1",
    title: "公司发布 Core 1.0",
    content,
    read,
    publishedAt,
    description: "Core 更新",
    url: `https://example.test/${id}`,
  })
  const input = options.store.automation.current("feed/1", id)!
  options.store.processingState.setMaterial(input, "complete")
  return input
}

// 假执行器遵守真实动态证据目录；检查整条管线的调用次数，而非只断言 helper 返回值。
function executor(
  options: ReturnType<typeof fixture>,
  containment = false,
  malformedSide = false,
  dedupeProblem?: "missing_result" | "invalid_result",
) {
  return vi.fn(async <T>(request: CodexJsonOptions<T>) => {
    expect(request.purpose).toBe("entry")
    const inspectSchema = (node: unknown) => {
      if (typeof node !== "object" || node === null) return
      if (Array.isArray(node)) {
        for (const child of node) inspectSchema(child)
        return
      }
      const schema = node as Record<string, unknown>
      if (
        schema.type === "object" &&
        typeof schema.properties === "object" &&
        schema.properties !== null
      )
        expect([...(schema.required as string[])].sort()).toEqual(
          Object.keys(schema.properties).sort(),
        )
      for (const child of Object.values(schema)) inspectSchema(child)
    }
    inspectSchema(request.schema)
    expect(request.prompt).toContain("同时执行以下已命中的规则")
    const marker = "批内条目与独立证据目录：\n"
    const batch = request.prompt.includes(marker)
      ? (JSON.parse(request.prompt.split(marker)[1]!.split("\n\n同时")[0]!) as Array<{
          entryId: string
          evidenceCatalog: Array<{ evidenceId: string; text: string }>
        }>)
      : [
          {
            entryId: options.store.automation.inputs().find((input) => input.body.read === false)!
              .itemId,
            evidenceCatalog: [{ evidenceId: "E000001", text: "公司发布 Core 1.0，支持离线部署。" }],
          },
        ]
    const items = batch.map((item) => ({
      entryId: item.entryId,
      title: "Core 1.0 发布",
      summary: item.evidenceCatalog[0]!.text,
      disposition: "keep",
      reason: "保留事实",
      aggregation: true,
      rewrite: true,
      labels: [],
      event: {
        kind: "event",
        subject: { value: "公司", evidenceId: item.evidenceCatalog[0]!.evidenceId },
        action: { value: "product_release", evidenceId: item.evidenceCatalog[0]!.evidenceId },
        object: { value: "Core", evidenceId: item.evidenceCatalog[0]!.evidenceId },
        version: { value: "1.0", evidenceId: item.evidenceCatalog[0]!.evidenceId },
        round: null,
        anchor: null,
      },
      facts: item.evidenceCatalog.map((fragment) => ({
        text: fragment.text,
        evidenceId: fragment.evidenceId,
        kind: "fact",
      })),
    }))
    const pairs = JSON.parse(
      request.prompt
        .split("去重候选（entries 的完整正文通过 itemId 查上面的证据目录或下面的只读参考）：\n")[1]!
        .split("\n只读参考")[0]!,
    ) as Array<{
      pairKey: string
      keepEntryId: string
      testEntryId: string
      entries: Array<{ itemId: string }>
    }>
    const sentences = batch.map((item) => ({
      text: item.evidenceCatalog[0]!.text,
      sources: [
        {
          inputSeq: options.store.automation.current("feed/1", item.entryId)!.seq,
          evidenceId: item.evidenceCatalog[0]!.evidenceId,
        },
      ],
    }))
    const stories =
      !containment && batch.length >= 2
        ? [
            {
              ruleId: "story",
              output: {
                groups: [
                  {
                    existingStoryId: null,
                    title: "Core 1.0 发布",
                    body: sentences.map((item) => item.text).join("\n\n"),
                    retainedSentenceIds: [],
                    retainedFactIds: [],
                    sentences,
                    facts: sentences.map((item, index) => ({
                      text: item.text,
                      kind: "fact",
                      sentenceIndexes: [index],
                      dependsOnFactIndexes: [],
                      dependsOnRetainedFactIds: [],
                    })),
                  },
                ],
              },
            },
          ]
        : [{ ruleId: "story", output: { groups: [] } }]
    const output = {
      entry: request.prompt.includes(marker) ? { items } : items[0],
      dedupe: malformedSide
        ? { invalid: true }
        : {
            results: (dedupeProblem === "missing_result" ? [] : pairs).flatMap((pair) => {
              const result = {
                pairKey: pair.pairKey,
                duplicate: containment,
                confidence: 0.99,
                keepEntryId: pair.keepEntryId,
                hideEntryId: pair.testEntryId,
                reason: "逐项核对事实",
                factComparison: containment
                  ? { verdict: "equivalent", onlyInFirst: [], onlyInSecond: [] }
                  : {
                      verdict: "different",
                      onlyInFirst: ["支持离线部署"],
                      onlyInSecond: ["升级无需停机"],
                    },
              }
              return dedupeProblem === "invalid_result" ? [result, result] : [result]
            }),
          },
      stories,
    }
    expect(request.validate(output)).toBe(true)
    // 原文在联合请求里只出现一次，候选区不能再复制完整正文。
    for (const item of batch)
      expect(request.prompt.split(item.evidenceCatalog[0]!.text).length - 1).toBe(1)
    return {
      result: output as T,
      model: request.model,
      durationMs: 1,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
      toolCalls: 0,
    }
  })
}

async function process(options: ReturnType<typeof fixture>, execute: ReturnType<typeof executor>) {
  return runEntryProcessing({
    ...options,
    historySince: "2026-10-04T00:00:00.000Z",
    signal: new AbortController().signal,
    execute: execute as typeof runCodexJson,
  })
}

afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("共享材料与规则分析", () => {
  it.each(["missing_result", "invalid_result"] as const)(
    "共享%s也计入补判次数，不复用异常产物或立即重复付费",
    async (status) => {
      // 验证真实共享请求、派生结果保存和跨任务缓存，异常不影响有效单篇发布。
      const options = fixture(false)
      save(options, "first", "公司发布 Core 1.0，支持离线部署。")
      save(options, "second", "公司发布 Core 1.0，升级无需停机。")
      const execute = executor(options, false, false, status)
      expect(await process(options, execute)).toMatchObject({
        completed: 2,
        failures: [],
        metrics: { modelCalls: 1 },
      })
      expect(options.sharedAnalysis.dedupeCosts).toMatchObject({
        requests: 1,
        pairs: 1,
        unknownUsageRequests: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      })
      expect(options.sharedAnalysis.dedupeEvaluations).toMatchObject([
        { evaluation: { duplicate: false, status } },
      ])
      const noExtraCall = vi.fn(async () => {
        throw new Error("unexpected_extra_model_call")
      })
      const run = () =>
        runSemanticDedupe({
          ...options,
          signal: new AbortController().signal,
          preparedEvaluations: options.sharedAnalysis.dedupeEvaluations,
          execute: noExtraCall,
        })
      expect(await run()).toMatchObject({ batches: 0, unresolved: 1 })
      expect(await run()).toMatchObject({ candidates: 0, unresolved: 1 })
      expect(noExtraCall).not.toHaveBeenCalled()
      const restored = new SharedAnalysisSession(options)
      await restored.restore(options.store.automation.inputs())
      expect(restored.dedupeEvaluations).toEqual([])
      // 重建共享会话后只补缺失关系；推进时钟验证真实新执行对应第二次尝试。
      const fingerprints = new Set(
        options.sharedAnalysis.dedupeEvaluations.map((item) => item.configFingerprint),
      )
      const firstAttempt = options.store.dedupe.unresolvedDecisions(fingerprints)[0]!
      const supplement = vi.fn(async <T>(request: CodexJsonOptions<T>) => ({
        result: { results: [] } as T,
        model: request.model,
        durationMs: 1,
        usage: null,
        toolCalls: 0,
      }))
      const retry = () =>
        runSemanticDedupe({
          ...options,
          signal: new AbortController().signal,
          preparedEvaluations: restored.dedupeEvaluations,
          execute: supplement as typeof runCodexJson,
        })
      await retry()
      expect(supplement).not.toHaveBeenCalled()
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(Date.parse(firstAttempt.createdAt) + 61_000)
      await retry()
      expect(supplement).toHaveBeenCalledTimes(1)
      expect(options.store.dedupe.unresolvedDecisions(fingerprints)[0]?.attempts).toBe(2)
      vi.setSystemTime(Date.parse(firstAttempt.createdAt) + 122_000)
      await retry()
      expect(supplement).toHaveBeenCalledTimes(1)
    },
  )
  it("共享请求失败仍报告真实用量，未知用量单独计数", async () => {
    for (const usage of [null, { inputTokens: 80, outputTokens: 20, cachedInputTokens: 0 }]) {
      const options = fixture(false)
      save(options, "first", "公司发布 Core 1.0，支持离线部署。")
      save(options, "second", "公司发布 Core 1.0，升级无需停机。")
      const execute = executor(options)
      execute.mockRejectedValueOnce(new CodexRunError("INVALID_OUTPUT", usage))
      await process(options, execute)
      expect(options.sharedAnalysis.dedupeCosts).toMatchObject({
        requests: 1,
        pairs: 1,
        unknownUsageRequests: usage ? 0 : 1,
        usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 },
      })
    }
  })

  it("单篇、语义去重和新事件综述共用一次模型调用，并保留可核查引用", async () => {
    const options = fixture()
    save(options, "first", "公司发布 Core 1.0，支持离线部署。")
    save(options, "second", "公司发布 Core 1.0，升级无需停机。")
    const execute = executor(options)
    expect(await process(options, execute)).toMatchObject({
      completed: 2,
      failures: [],
      metrics: { modelCalls: 1 },
    })
    const noExtraCall = vi.fn(async () => {
      throw new Error("unexpected_extra_model_call")
    })
    const dedupe = await runSemanticDedupe({
      ...options,
      signal: new AbortController().signal,
      preparedEvaluations: options.sharedAnalysis.dedupeEvaluations,
      execute: noExtraCall,
    })
    expect(dedupe).toMatchObject({ batches: 0, duplicates: 0, pending: 0 })
    const result = await runStoryAggregation({
      ...options,
      decisions: options.store.processingState.published(),
      currentEntry: options.store.entry.bind(options.store),
      ruleSet: options.store.automation.effective().config!,
      stories: options.store.stories,
      sharedGroups: options.sharedAnalysis.storyGroups,
      signal: new AbortController().signal,
      execute: noExtraCall,
    })
    expect(result.failures).toEqual([])
    expect(result.created).toHaveLength(1)
    expect(noExtraCall).not.toHaveBeenCalled()
    const revision = options.store.stories.currentSnapshot(result.created[0]!.storyId)!
    expect(revision.citations).toHaveLength(2)
    expect(revision.members).toHaveLength(2)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("已读完整缓存作为参考，未读等价报道在同一次单篇调用中判重", async () => {
    const options = fixture(false)
    const reference = save(options, "already-read", "公司发布Core 1.0，支持离线部署。", true)
    save(options, "unread", "公司发布 Core 1.0，支持离线部署。")
    settleReadStates(options.store)
    const execute = executor(options, true)
    expect(await process(options, execute)).toMatchObject({
      completed: 1,
      metrics: { modelCalls: 1 },
    })
    const noExtraCall = vi.fn(async () => {
      throw new Error("unexpected_extra_model_call")
    })
    const dedupe = await runSemanticDedupe({
      ...options,
      signal: new AbortController().signal,
      preparedEvaluations: options.sharedAnalysis.dedupeEvaluations,
      execute: noExtraCall,
    })
    expect(dedupe).toMatchObject({ duplicates: 1, batches: 0, pending: 0 })
    expect(options.store.reading.roles().find((role) => role.itemId === "unread")).toMatchObject({
      kind: "merged",
      relatedEntryIds: ["already-read"],
    })
    expect(options.store.automation.current(reference.sourceKey, reference.itemId)?.status).toBe(
      "skipped",
    )
    expect(options.store.entry("feed/1", "already-read")?.read).toBe(true)
    expect(noExtraCall).not.toHaveBeenCalled()
  })

  it("显式禁止改写资格传入联合分析，综述按原证据逐字引用", async () => {
    const options = fixture(true, true)
    save(options, "first", "公司发布 Core 1.0，支持离线部署。")
    save(options, "second", "公司发布 Core 1.0，升级无需停机。")
    const execute = executor(options)
    await process(options, execute)
    expect(execute.mock.calls[0]![0].prompt).toContain('"policy":{"rewrite":"deny"}')
    const result = await runStoryAggregation({
      ...options,
      decisions: options.store.processingState.published(),
      currentEntry: options.store.entry.bind(options.store),
      ruleSet: options.store.automation.effective().config!,
      stories: options.store.stories,
      sharedGroups: options.sharedAnalysis.storyGroups,
      signal: new AbortController().signal,
      execute: async () => {
        throw new Error("unexpected_extra_call")
      },
    })
    expect(result.created).toHaveLength(1)
    expect(result.failures).toEqual([])
    expect(
      options.store.processingState
        .published()
        .every((item) => item.decision.policy.rewrite === "deny"),
    ).toBe(true)
  })

  it("联合产物跨任务复用，损坏缓存或正文换代时退出复用", async () => {
    const options = fixture()
    save(options, "first", "公司发布 Core 1.0，支持离线部署。")
    save(options, "second", "公司发布 Core 1.0，升级无需停机。")
    await process(options, executor(options))
    const restored = new SharedAnalysisSession(options)
    await restored.restore(options.store.automation.inputs())
    expect(restored.dedupeEvaluations).toHaveLength(1)
    expect(restored.storyGroups).toHaveLength(1)
    const cacheDir = join(options.runtimeDir, "shared-analysis")
    const originals = readdirSync(cacheDir).map((file) => ({
      file,
      body: readFileSync(join(cacheDir, file), "utf8"),
    }))
    // 模拟旧版联合缓存把低把握否定写成 decided，重启后仍须归为不确定。
    for (const original of originals) {
      const cached = JSON.parse(original.body) as {
        dedupe: Array<{ evaluation: { status: string; confidence: number; duplicate: boolean } }>
      }
      for (const item of cached.dedupe)
        Object.assign(item.evaluation, { status: "decided", confidence: 0.1, duplicate: false })
      writeFileSync(join(cacheDir, original.file), JSON.stringify(cached))
    }
    const lowConfidence = new SharedAnalysisSession(options)
    await lowConfidence.restore(options.store.automation.inputs())
    expect(lowConfidence.dedupeEvaluations[0]?.evaluation.status).toBe("uncertain")
    for (const file of readdirSync(cacheDir))
      writeFileSync(
        join(cacheDir, file),
        JSON.stringify({
          version: 1,
          dedupe: [],
          stories: [{ inputs: restored.storyGroups[0]!.inputs, output: { groups: [] } }],
        }),
      )
    const damaged = new SharedAnalysisSession(options)
    await damaged.restore(options.store.automation.inputs())
    expect(damaged.storyGroups).toEqual([])
    for (const original of originals) writeFileSync(join(cacheDir, original.file), original.body)
    // 新正文不沿用旧事实、证据目录或关系，即使条目身份相同。
    save(options, "second", "公司发布 Core 2.0，升级需要停机。")
    const stale = new SharedAnalysisSession(options)
    await stale.restore(options.store.automation.inputs())
    expect(stale.dedupeEvaluations).toEqual([])
    expect(stale.storyGroups).toEqual([])
  })

  it("去重输出损坏时仍发布有效单篇，原始未读不会被联合失败吞掉", async () => {
    const options = fixture(false)
    save(options, "first", "公司发布 Core 1.0，支持离线部署。")
    save(options, "second", "公司发布 Core 1.0，升级无需停机。")
    expect(await process(options, executor(options, false, true))).toMatchObject({
      completed: 2,
      failures: [],
    })
    expect(options.sharedAnalysis.dedupeEvaluations).toMatchObject([
      { evaluation: { duplicate: false, status: "invalid_result" } },
    ])
    expect(options.store.processingState.published()).toHaveLength(2)
  })
})
