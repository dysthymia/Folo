import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import type { ConditionSet } from "@follow/information-core"
import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { SourceEntry } from "./folo"
import type { ProcessingDecision } from "./processing-decision"
import { activeDedupeActions, runSemanticDedupe } from "./processing-dedupe"
import type { ProcessingEntryRole } from "./processing-reading-store"
import { Store } from "./store"

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

afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { force: true, recursive: true }))
})

describe("语义去重的服务端执行与角色落地", () => {
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
      },
      {
        itemId: "newer",
        inputSeq: 2,
        kind: "merged",
        reason: "同一核心事件",
        relatedEntryIds: ["older"],
        storyId: null,
        storyTitle: null,
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
    expect(first).toMatchObject({ batches: 3, candidates: 25, duplicates: 0, pending: 1 })
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
