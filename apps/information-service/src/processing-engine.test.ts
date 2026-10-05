import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import type { RuleSet } from "@follow/information-core"
import { compileInstructions } from "@follow/information-core"
import { join } from "pathe"
import { describe, expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { CodexRunError } from "./codex"
import type { EntryProcessingResult, ProcessingEngineStore } from "./processing-engine"
import {
  resolvedPolicy,
  resolvedStatus,
  runEntryProcessing,
  settleReadStates,
} from "./processing-engine"
import { SOURCE_FIDELITY_REQUIREMENTS } from "./processing-prompt"
import { Store } from "./store"

const entry = {
  id: "entry-1",
  sourceKey: "feed/1",
  title: "文章",
  url: "https://example.test/1",
  publishedAt: "2026-09-12T00:00:00.000Z",
  read: false,
  content: "<p>真实原文事实。</p>",
  description: null,
}
const input = {
  seq: 1,
  sourceKey: entry.sourceKey,
  itemId: entry.id,
  contentVersion: "v1",
  receivedAt: entry.publishedAt,
  releaseVersion: 1,
  generation: 1,
  status: "pending",
  current: true,
  body: entry,
}
const release: RuleSet = {
  formatVersion: 4,
  ownerId: "owner",
  global: { version: 1, markdown: "全局指令" },
  rules: [
    {
      id: "rule",
      ownerId: "owner",
      name: "规则",
      enabled: true,
      order: 0,
      when: { anyOf: [{ allOf: [{ field: "subscription_tag", operator: "in", value: ["tag"] }] }] },
      actions: [
        { type: "presentation", policy: { aggregation: "deny" } },
        { type: "ai_transform", prompt: "提取事实" },
      ],
      version: 1,
      executionLocation: "processing_service",
    },
    // 引擎测试显式配置通用 AI 动作，标签规则只验证策略覆盖。
    {
      id: "ai-base",
      ownerId: "owner",
      name: "AI处理",
      enabled: true,
      order: 1,
      when: { all: true },
      actions: [{ type: "ai_transform", prompt: "提取事实" }],
      version: 1,
      executionLocation: "processing_service",
    },
  ],
}

function storeFixture(
  mode: "restore" | "hide" | "automatic" = "automatic",
  tagIds: string[] = [],
  read = entry.read,
) {
  let cached: unknown = null
  let completed: unknown = null
  let material: "complete" | "missing" | "failed" | null = null
  const failed: string[] = []
  const settled: Array<{ skip: number[]; revive: number[] }> = []
  // `read` 不属于内容身份，夹具按需覆盖，用来验证已读条目不再进入模型调用。
  const currentInput = read === entry.read ? input : { ...input, body: { ...entry, read } }
  const store = {
    automation: {
      inputs: () => [currentInput],
      release: () => release,
      complete: (_target: unknown, decision: unknown) => {
        completed = decision
        return { id: "decision", published: true }
      },
      current: () => null,
    },
    processingState: {
      prepare: (_seq: number, snapshot: unknown) => ({
        input: currentInput,
        snapshot,
      }),
      start: () => true,
      cache: () => cached,
      saveCache: (value: unknown) => {
        cached = value
      },
      fail: (_target: unknown, code: string) => failed.push(code),
      material: () => material,
      setMaterial: (_target: unknown, status: "complete" | "missing" | "failed") => {
        material = status
      },
      overrides: () => [{ inputSeq: input.seq, mode, revision: 1 }],
      // 读态收敛在真实 Store 上一次写库；夹具只记录调用，不改内存里的 status。
      settleRead: (skip: number[], revive: number[]) => {
        settled.push({ skip: [...skip], revive: [...revive] })
        return skip.length + revive.length
      },
    },
    sources: () => [
      { key: "feed/1", kind: "feed", id: "1", title: "媒体订阅", view: 0, category: null },
    ],
    sourceSync: {
      contextFor: () => ({
        sourceId: "feed/1",
        contextId: "feed/1",
        view: null,
        categoryRef: null,
        listMembership: {},
        metadata: { sourceSyncedAt: null, listMembershipVersion: 0 },
      }),
    },
    subscriptionTags: {
      sourceTagBindings: () => ({ revision: 1, bindings: [{ sourceKey: "feed/1", tagIds }] }),
      snapshot: () => ({
        formatVersion: 1,
        revision: 1,
        tags: tagIds.map((id) => ({ id, name: "媒体", createdAt: "", updatedAt: "" })),
      }),
    },
  } as unknown as ProcessingEngineStore
  return {
    store,
    completed: () => completed,
    failed,
    settled,
    setMaterial: (status: "complete" | "missing" | "failed") =>
      store.processingState.setMaterial(input, status),
  }
}

function executeWith(output: unknown, prompts: string[] = []) {
  return async function execute<T>(options: CodexJsonOptions<T>) {
    prompts.push(options.prompt)
    if (!options.validate(output)) throw new Error("invalid_stub_output")
    return {
      result: output,
      model: options.model,
      durationMs: 2,
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 1 },
      toolCalls: 0,
    }
  }
}

function batchSelection(entryId: string, evidenceId: string) {
  return {
    entryId,
    event: null,
    title: `标题 ${entryId}`,
    summary: `摘要 ${entryId}`,
    disposition: "keep" as const,
    reason: "原因",
    aggregation: true,
    rewrite: true,
    labels: [],
    facts: [{ text: "事实", evidenceId, kind: "fact" as const }],
  }
}

const aiConfig = {
  read: async () => ({ provider: "codex" as const, model: "test-model" }),
  execution: async () => undefined,
}

function batchStoreFixture(count: number) {
  const inputs = Array.from({ length: count }, (_, index) => {
    const seq = index + 1
    const body = {
      ...entry,
      id: `entry-${seq}`,
      url: `https://example.test/${seq}`,
      content: `<p>第 ${seq} 篇真实事实。</p>`,
    }
    return { ...input, seq, itemId: body.id, body }
  })
  const current = new Map(inputs.map((item) => [item.itemId, item]))
  const cached = new Map<string, unknown>()
  const completed = new Map<string, unknown>()
  const failed: Array<{ inputSeq: number; code: string }> = []
  const batchRelease: RuleSet = {
    ...release,
    rules: [{ ...release.rules[0]!, when: { all: true } }],
  }
  const store = {
    automation: {
      inputs: () => inputs,
      release: () => batchRelease,
      current: (_sourceKey: string, itemId: string) => current.get(itemId) ?? null,
      complete: (target: (typeof inputs)[number], decision: unknown) => {
        const latest = current.get(target.itemId)
        const published =
          latest?.seq === target.seq &&
          latest.generation === target.generation &&
          latest.releaseVersion === target.releaseVersion
        if (published) {
          completed.set(target.itemId, decision)
          current.set(target.itemId, { ...latest, status: "succeeded" })
        }
        return { id: `decision-${target.seq}`, published }
      },
    },
    processingState: {
      prepare: (seq: number, snapshot: unknown) => {
        const original = inputs[seq - 1]!
        return { input: current.get(original.itemId) ?? original, snapshot }
      },
      start: (target: (typeof inputs)[number]) => {
        const latest = current.get(target.itemId)
        if (latest?.status !== "pending" || latest.generation !== target.generation) return false
        current.set(target.itemId, { ...latest, status: "running" })
        return true
      },
      cache: (fingerprint: string) => cached.get(fingerprint) ?? null,
      saveCache: (decision: { fingerprint: string }) => cached.set(decision.fingerprint, decision),
      fail: (target: (typeof inputs)[number], code: string) =>
        failed.push({ inputSeq: target.seq, code }),
      material: () => "complete" as const,
      overrides: () => [],
      settleRead: () => 0,
    },
    sources: () => [
      { key: "feed/1", kind: "feed", id: "1", title: "媒体订阅", view: 0, category: null },
    ],
    sourceSync: {
      contextFor: () => ({
        sourceId: "feed/1",
        contextId: "feed/1",
        view: null,
        categoryRef: null,
        listMembership: {},
        metadata: { sourceSyncedAt: null, listMembershipVersion: 0 },
      }),
    },
    subscriptionTags: {
      sourceTagBindings: () => ({ revision: 1, bindings: [] }),
      snapshot: () => ({ formatVersion: 1, revision: 1, tags: [] }),
    },
  } as unknown as ProcessingEngineStore
  return {
    store,
    completed,
    failed,
    cacheSize: () => cached.size,
    bumpGeneration: (itemId: string) => {
      const previous = current.get(itemId)!
      current.set(itemId, { ...previous, generation: previous.generation + 1 })
    },
  }
}

describe("单篇处理 engine", () => {
  it("未知规则保留待补状态，不允许语义或显式规则提前隐藏与综合", () => {
    const instructions = compileInstructions(release, {
      source_id: "feed/1",
      contextId: "feed/1",
      subscription_tag: null,
    })
    expect(instructions.blocksFinalPresentation).toBe(true)
    const output = {
      ...batchSelection("entry-1", "E000001"),
      facts: [],
      disposition: "hide" as const,
    }
    expect(resolvedStatus(instructions, output)).toBe("needs_context")
    expect(resolvedPolicy(instructions, output)).toEqual({
      standalone: "always",
      aggregation: "deny",
      rewrite: "deny",
    })
  })

  it.each(["领取公告，截止 10/04", "协议遭攻击，请立即撤销授权"])(
    "紧迫公告先发布，不因位于大批末尾等待整轮：%s",
    async (title) => {
      const fixture = batchStoreFixture(10)
      fixture.store.automation.inputs()[9]!.body.title = title
      let calls = 0
      const result = await runEntryProcessing({
        store: fixture.store,
        aiConfig: aiConfig as never,
        runtimeDir: "/tmp",
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
        execute: async <T>(request: CodexJsonOptions<T>) => {
          calls++
          const materials = JSON.parse(
            request.prompt.split("批内条目与独立证据目录：\n")[1]!,
          ) as Array<{
            entryId: string
            evidenceCatalog: Array<{ evidenceId: string; text: string }>
          }>
          if (calls === 1) {
            expect(materials[0]?.entryId).toBe("entry-10")
            // 紧迫公告先处理，最早普通项在同批第2位获得机会。
            expect(materials[1]?.entryId).toBe("entry-1")
          } else expect(fixture.completed.has("entry-10")).toBe(true)
          const items = materials.map((item) =>
            batchSelection(item.entryId, item.evidenceCatalog[0]!.evidenceId),
          )
          expect(request.validate({ items })).toBe(true)
          return {
            result: { items } as T,
            model: request.model,
            durationMs: 2,
            usage: null,
            toolCalls: 0,
          }
        },
      })
      expect(result).toMatchObject({
        completed: 10,
        metrics: { modelCalls: 2, publishedBatches: 2 },
      })
    },
  )

  it("紧迫长文分块和发布先于普通短文批次", async () => {
    const fixture = batchStoreFixture(4)
    const urgent = fixture.store.automation.inputs()[3]!
    urgent.body.title = "资格领取截止今晚"
    urgent.body.content = ["甲", "乙", "丙", "丁"]
      .map((text) => `<p>${text.repeat(20_000)}</p>`)
      .join("")
    const runtimeDir = await mkdtemp(join(tmpdir(), "urgent-long-entry-"))
    const sequence: string[] = []
    let chunkIndex = 0
    try {
      const result = await runEntryProcessing({
        store: fixture.store,
        aiConfig: aiConfig as never,
        runtimeDir,
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
        execute: async <T>(request: CodexJsonOptions<T>) => {
          let output: unknown
          if (request.prompt.includes("长文分块阅读器")) {
            sequence.push("urgent-chunk")
            expect(fixture.completed.size).toBe(0)
            output = {
              chunkId: `entry-4:${chunkIndex + 1}/4`,
              summary: "完整分块",
              facts: [{ text: "事实", evidenceId: `C${++chunkIndex}E000001`, kind: "fact" }],
            }
          } else if (request.prompt.includes("批内条目与独立证据目录：")) {
            sequence.push("ordinary-batch")
            expect(fixture.completed.has("entry-4")).toBe(true)
            const materials = JSON.parse(
              request.prompt.split("批内条目与独立证据目录：\n")[1]!,
            ) as Array<{ entryId: string; evidenceCatalog: Array<{ evidenceId: string }> }>
            expect(materials.map((item) => item.entryId)).toEqual(["entry-1", "entry-2", "entry-3"])
            output = {
              items: materials.map((item) =>
                batchSelection(item.entryId, item.evidenceCatalog[0]!.evidenceId),
              ),
            }
          } else {
            sequence.push("urgent-final")
            expect(fixture.completed.size).toBe(0)
            output = {
              ...batchSelection("entry-4", "FE000001"),
              facts: [1, 2, 3, 4].map((index) => ({
                text: "事实",
                evidenceId: `FE${String(index).padStart(6, "0")}`,
                kind: "fact",
              })),
            }
          }
          expect(request.validate(output)).toBe(true)
          return {
            result: output as T,
            model: request.model,
            durationMs: 2,
            usage: null,
            toolCalls: 0,
          }
        },
      })
      expect(sequence).toEqual([
        "urgent-chunk",
        "urgent-chunk",
        "urgent-chunk",
        "urgent-chunk",
        "urgent-final",
        "ordinary-batch",
      ])
      expect(result).toMatchObject({
        completed: 4,
        metrics: { publishedBatches: 2, modelCalls: 6 },
      })
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it.each([false, true])("普通保底项不被后续紧迫长文越过：普通为长文=%s", async (ordinaryLong) => {
    const fixture = batchStoreFixture(10)
    const inputs = fixture.store.automation.inputs()
    for (const candidate of inputs.slice(1)) {
      candidate.body.title = "协议遭攻击，请立即撤销授权"
      candidate.body.content = `<p>${"紧迫原文事实。".repeat(10_000)}</p>`
    }
    // 两种交错：紧迫长文→普通短文，以及紧迫短文→普通长文；其余全是紧迫长文。
    if (ordinaryLong) {
      inputs[0]!.body.content = `<p>${"普通原文事实。".repeat(10_000)}</p>`
      inputs[1]!.body.content = "真实紧迫公告"
    }
    const controller = new AbortController()
    const attempts: string[] = []
    const runtimeDir = await mkdtemp(join(tmpdir(), "fair-long-entry-"))
    try {
      const result = await runEntryProcessing({
        store: fixture.store,
        aiConfig: aiConfig as never,
        runtimeDir,
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: controller.signal,
        onProgress: (progress) => {
          if (!ordinaryLong && progress.completed === 1) controller.abort()
        },
        execute: async <T>(request: CodexJsonOptions<T>) => {
          if (request.prompt.includes("长文分块阅读器")) {
            const entryId = /chunkId=(entry-\d+):/u.exec(request.prompt)![1]!
            attempts.push(entryId)
            if (ordinaryLong) controller.abort()
            // 无外部调用；模拟该长文首块失败，验证失败不会剥夺第2项或造成无限抢占。
            throw new Error("fixture_chunk_failure")
          }
          const entryId = /必须返回 entryId=(entry-\d+)/u.exec(request.prompt)![1]!
          const catalog = JSON.parse(request.prompt.split("编号原文证据目录：\n")[1]!) as Array<{
            evidenceId: string
          }>
          attempts.push(entryId)
          const output = batchSelection(entryId, catalog[0]!.evidenceId)
          expect(request.validate(output)).toBe(true)
          return {
            result: output as T,
            model: request.model,
            durationMs: 2,
            usage: null,
            toolCalls: 0,
          }
        },
      })
      expect(attempts).toEqual(["entry-2", "entry-1"])
      expect(result).toMatchObject({ completed: 1, metrics: { modelCalls: 2 } })
      expect(result.failures.map((failure) => failure.inputSeq)).toEqual([ordinaryLong ? 1 : 2])
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it("同一原帖的不同条目 ID 不重复进模型，后续等效上下文复用首批缓存", async () => {
    const fixture = batchStoreFixture(3)
    const inputs = fixture.store.automation.inputs()
    inputs[0]!.body.url = "https://x.com/example/status/123"
    inputs[1]!.body.url = "https://twitter.com/example/status/123"
    inputs[1]!.body.content = inputs[0]!.body.content
    let calls = 0
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: async <T>(request: CodexJsonOptions<T>) => {
        calls++
        const materials = JSON.parse(
          request.prompt.split("批内条目与独立证据目录：\n")[1]!,
        ) as Array<{ entryId: string; evidenceCatalog: Array<{ evidenceId: string }> }>
        expect(materials.map((item) => item.entryId)).toEqual(["entry-1", "entry-3"])
        const output = {
          items: materials.map((item) =>
            batchSelection(item.entryId, item.evidenceCatalog[0]!.evidenceId),
          ),
        }
        expect(request.validate(output)).toBe(true)
        return {
          result: output as T,
          model: request.model,
          durationMs: 2,
          usage: null,
          toolCalls: 0,
        }
      },
    })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ completed: 3, metrics: { cacheHits: 1, modelCalls: 1 } })
    expect(fixture.completed.get("entry-2")).toMatchObject({
      reused: true,
      semantic: { entryId: "entry-2" },
    })
  })

  it("水合小批只处理明确 inputSeqs，空批不调用模型或扫描其他输入", async () => {
    const fixture = batchStoreFixture(3)
    let calls = 0
    const process = (inputSeqs: readonly number[]) =>
      runEntryProcessing({
        store: fixture.store,
        aiConfig: aiConfig as never,
        runtimeDir: "/tmp",
        sourceKeys: ["feed/1"],
        inputSeqs,
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
        execute: async <T>(request: CodexJsonOptions<T>) => {
          calls++
          expect(request.prompt).toContain("entryId=entry-2")
          const output = batchSelection("entry-2", "E000001")
          expect(request.validate(output)).toBe(true)
          return {
            result: output as T,
            model: request.model,
            durationMs: 2,
            usage: null,
            toolCalls: 0,
          }
        },
      })
    expect(await process([2])).toMatchObject({ completed: 1, metrics: { modelCalls: 1 } })
    expect([...fixture.completed.keys()]).toEqual(["entry-2"])
    expect(await process([])).toMatchObject({ completed: 0, metrics: { modelCalls: 0 } })
    expect(calls).toBe(1)
  })

  it.each([true, false])("模型隐藏与综合独立：aggregation=%s", async (aggregation) => {
    const fixture = storeFixture()
    fixture.setMaterial("complete")
    // 即使命中安全事件调度线索，也不能强迫模型保留或允许综合。
    fixture.store.automation.inputs()[0]!.body.title = "协议遭攻击，请立即撤销授权"
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: executeWith({
        ...batchSelection("entry-1", "E000001"),
        disposition: "hide",
        event: {
          kind: "event",
          subject: { value: "OpenAI", evidenceId: "E000001" },
          action: { value: "product_release", evidenceId: "E000001" },
          object: { value: "GPT", evidenceId: "E000001" },
          version: { value: "5.2", evidenceId: "E000001" },
          round: null,
          anchor: null,
        },
        aggregation,
      }),
    })
    // 同样隐藏：有效重复可参与综合，纯噪声不可；二者均不能改写成替代正文。
    expect(fixture.completed()).toMatchObject({
      status: "hide",
      policy: { standalone: "never", aggregation: aggregation ? "allow" : "deny", rewrite: "deny" },
    })
    expect(result.metrics).toMatchObject({ modelCalls: 1, cacheHits: 0, modelFailures: 0 })
  })

  it("拟折叠综合但身份无法确认时保留独立入口，纯噪声仍隐藏", async () => {
    const fixture = storeFixture()
    fixture.setMaterial("complete")
    await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00Z",
      signal: new AbortController().signal,
      execute: executeWith({
        ...batchSelection("entry-1", "E000001"),
        disposition: "hide",
        aggregation: true,
        event: null,
      }),
    })
    expect(fixture.completed()).toMatchObject({ status: "keep", policy: { standalone: "always" } })
  })

  it("批结果落库后立即可读，取消与重启保留成功材料并拒绝隐式重付费", async () => {
    const directory = await mkdtemp(join(tmpdir(), "processing-publication-"))
    const path = join(directory, "state.db")
    let store = new Store(path)
    const controller = new AbortController()
    const progress: EntryProcessingResult[] = []
    try {
      store.bindOwner("owner")
      store.automation.saveDraft({ ...release, rules: [release.rules[1]!] }, 0)
      store.automation.publish(1, { mode: "future" }, randomUUID())
      for (let seq = 1; seq <= 10; seq++)
        store.saveEntry({
          ...entry,
          id: `entry-${seq}`,
          url: `https://example.test/${seq}`,
          content: `第 ${seq} 篇事实。`,
        })
      for (const candidate of store.automation.inputs())
        store.processingState.setMaterial(candidate, "complete")
      let calls = 0
      const result = await runEntryProcessing({
        store,
        aiConfig: aiConfig as never,
        runtimeDir: directory,
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: controller.signal,
        onProgress: (snapshot) => progress.push(snapshot),
        execute: async <T>(options: CodexJsonOptions<T>) => {
          calls++
          if (calls === 2) {
            // 第二次付费请求开始前，第一批已正式发布，读端无需等待整轮或 Story。
            expect(store.processingState.published()).toHaveLength(8)
            expect(progress[0]?.completed).toBe(8)
            expect(
              store.automation.inputs().filter((item) => item.status === "running"),
            ).toHaveLength(2)
            controller.abort()
          }
          const first = calls === 1 ? 1 : 9
          const last = calls === 1 ? 8 : 10
          const items = Array.from({ length: last - first + 1 }, (_, index) => {
            const seq = first + index
            return batchSelection(`entry-${seq}`, `B${seq}E000001`)
          })
          expect(options.validate({ items })).toBe(true)
          return {
            result: { items } as T,
            model: options.model,
            durationMs: 2,
            usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 2 },
            toolCalls: 0,
          }
        },
      })
      expect(result).toMatchObject({
        completed: 8,
        pending: 2,
        metrics: { modelCalls: 2, publishedBatches: 1 },
      })
      store.close()
      store = new Store(path)
      store.processingState.recover()
      expect(store.processingState.published()).toHaveLength(8)
      expect(store.automation.inputs().filter((item) => item.status === "failed")).toHaveLength(2)
      // 日常已读收敛保留成功决定，其引用资格不会被 read 改动追溯撤销。
      const successful = store.automation.inputs().find((item) => item.status === "succeeded")!
      store.saveEntry({ ...successful.body, read: true })
      settleReadStates(store)
      const next = await runEntryProcessing({
        store,
        aiConfig: aiConfig as never,
        runtimeDir: directory,
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
        execute: async () => {
          throw new Error("unexpected_model_call")
        },
      })
      expect(next.metrics?.modelCalls).toBe(0)
      expect(store.processingState.published()).toHaveLength(8)
      expect(progress[0]?.completed).toBe(8)
      expect(progress[0]?.metrics?.modelCalls).toBe(1)
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("已缓存成功材料重新判定时零模型调用，最新人工纠偏在发布时间生效", async () => {
    const store = new Store(":memory:")
    try {
      store.bindOwner("owner")
      store.automation.saveDraft({ ...release, rules: [release.rules[1]!] }, 0)
      store.automation.publish(1, { mode: "future" }, randomUUID())
      store.saveEntry(entry)
      const candidate = store.automation.inputs()[0]!
      store.processingState.setMaterial(candidate, "complete")
      const options = {
        store,
        aiConfig: aiConfig as never,
        runtimeDir: "/tmp",
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
      }
      await runEntryProcessing({
        ...options,
        execute: async <T>(request: CodexJsonOptions<T>) => {
          const output = batchSelection("entry-1", "E000001")
          expect(request.validate(output)).toBe(true)
          // 模型运行期间人工隐藏不能被进入本轮前的覆盖快照忽略。
          store.processingState.setOverride(candidate.seq, "hide", 0)
          return {
            result: output as T,
            model: request.model,
            durationMs: 2,
            usage: null,
            toolCalls: 0,
          }
        },
      })
      expect(store.processingState.published()[0]?.decision).toMatchObject({
        status: "hide",
        policy: { aggregation: "deny" },
      })
      store.automation.invalidateSources(["feed/1"])
      const result = await runEntryProcessing({
        ...options,
        execute: async () => {
          throw new Error("unexpected_model_call")
        },
      })
      expect(result).toMatchObject({ completed: 1, metrics: { modelCalls: 0, cacheHits: 1 } })
      expect(store.processingState.published()[0]?.decision).toMatchObject({
        reused: true,
        status: "hide",
      })
    } finally {
      store.close()
    }
  })

  it("批量响应逐项隔离证据，并只补做缺失、重复或跨项引用的条目", async () => {
    const fixture = batchStoreFixture(5)
    const calls: string[] = []
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: async <T>(options: CodexJsonOptions<T>) => {
        calls.push(options.prompt)
        // 成功项必须先可读；补做不能把已通过证据校验的结果压在内存里。
        if (calls.length > 1) expect(fixture.completed.has("entry-1")).toBe(true)
        const isBatch = options.prompt.includes("有界批量单篇阅读处理器")
        const requestedId = options.prompt.match(/entryId=(entry-\d+)/u)?.[1]
        if (isBatch) {
          const schema = JSON.stringify(options.schema)
          expect(schema).toContain('"entryId":{"type":"string","enum":["entry-1"]}')
          expect(schema).toContain('"entryId":{"type":"string","enum":["entry-5"]}')
          expect(schema).toContain('"evidenceId":{"type":"string","enum":["B1E000001"]}')
          expect(schema).toContain('"evidenceId":{"type":"string","enum":["B5E000001"]}')
          expect(schema).toContain(
            '"required":["entryId","title","summary","disposition","reason","aggregation","rewrite","labels","event","facts"]',
          )
        }
        const output = isBatch
          ? {
              items: [
                batchSelection("entry-1", "B1E000001"),
                batchSelection("entry-3", "B3E000001"),
                batchSelection("entry-3", "B3E000001"),
                // entry-4 故意引用 entry-1 的命名空间，必须单独补做。
                batchSelection("entry-4", "B1E000001"),
                { ...batchSelection("entry-5", "B5E000001"), title: 42 },
              ],
            }
          : batchSelection(requestedId!, "E000001")
        expect(options.validate(output)).toBe(true)
        return {
          result: output as T,
          model: options.model,
          durationMs: 2,
          usage: isBatch
            ? { inputTokens: 100, outputTokens: 40, cachedInputTokens: 10 }
            : { inputTokens: 10, outputTokens: 5, cachedInputTokens: 1 },
          toolCalls: 0,
        }
      },
    })

    expect(result).toMatchObject({ completed: 5, pending: 0, failures: [] })
    expect(result.usage).toEqual({ inputTokens: 140, outputTokens: 60, cachedInputTokens: 14 })
    expect(calls).toHaveLength(5)
    expect(calls.filter((prompt) => prompt.includes("entryId=entry-1"))).toHaveLength(0)
    expect(calls[0]).toContain("B1E000001")
    expect(calls[0]).toContain("B4E000001")
    expect(calls[0]).toContain("B5E000001")
    expect(fixture.completed.get("entry-1")).toMatchObject({ usage: null, reused: false })
    expect(fixture.completed.get("entry-2")).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 1 },
      reused: false,
    })
  })

  it("第一批立即发布，当前调用中 generation 换代时不发布旧结果", async () => {
    const fixture = batchStoreFixture(10)
    let calls = 0
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: async <T>(options: CodexJsonOptions<T>) => {
        calls++
        const range = calls === 1 ? [1, 8] : [9, 10]
        // 证据目录属于当前公平批次，不依赖全队列中的序号或目录前缀。
        const materials = JSON.parse(
          options.prompt.split("批内条目与独立证据目录：\n")[1]!,
        ) as Array<{ entryId: string; evidenceCatalog: Array<{ evidenceId: string }> }>
        expect(materials.map((item) => item.entryId)).toEqual(
          Array.from(
            { length: range[1]! - range[0]! + 1 },
            (_, offset) => `entry-${range[0]! + offset}`,
          ),
        )
        const items = materials.map((item) =>
          batchSelection(item.entryId, item.evidenceCatalog[0]!.evidenceId),
        )
        expect(options.validate({ items })).toBe(true)
        if (calls === 1) fixture.bumpGeneration("entry-1")
        if (calls === 2) expect(fixture.completed.size).toBe(7)
        return {
          result: { items } as T,
          model: options.model,
          durationMs: 2,
          usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 2 },
          toolCalls: 0,
        }
      },
    })

    expect(calls).toBe(2)
    expect(result).toMatchObject({ completed: 9, pending: 1, failures: [] })
    expect(fixture.completed.has("entry-1")).toBe(false)
  })

  it("批次进程故障不盲目逐篇重试放大相同失败和费用", async () => {
    const fixture = batchStoreFixture(5)
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: async () => {
        throw new CodexRunError("PROCESS_FAILED", {
          inputTokens: 20,
          outputTokens: 8,
          cachedInputTokens: 2,
        })
      },
    })
    expect(result.metrics).toMatchObject({ modelCalls: 1, modelFailures: 1, publishedBatches: 0 })
    expect(result.failures).toHaveLength(5)
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8, cachedInputTokens: 2 })
    expect(fixture.completed.size).toBe(0)
  })

  it("批调用取消后的晚返回只计实际 usage，不写缓存或发布结果", async () => {
    const fixture = batchStoreFixture(2)
    const controller = new AbortController()
    let calls = 0
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: controller.signal,
      execute: async <T>(options: CodexJsonOptions<T>) => {
        calls++
        const output = {
          items: [batchSelection("entry-1", "B1E000001"), batchSelection("entry-2", "B2E000001")],
        }
        expect(options.validate(output)).toBe(true)
        controller.abort()
        return {
          result: output as T,
          model: options.model,
          durationMs: 2,
          usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 2 },
          toolCalls: 0,
        }
      },
    })

    expect(calls).toBe(1)
    expect(result).toMatchObject({
      completed: 0,
      pending: 2,
      failures: [],
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 2 },
    })
    expect(fixture.completed.size).toBe(0)
    expect(fixture.cacheSize()).toBe(0)
  })

  it.each([
    { standalone: "always" as const, aggregation: "allow" as const, status: "keep" },
    { standalone: "never" as const, aggregation: "allow" as const, status: "hide" },
    { standalone: "always" as const, aggregation: "deny" as const, status: "keep" },
  ])(
    "显式展示 $standalone 与综合 $aggregation 分别覆盖语义隐藏",
    async ({ standalone, aggregation, status }) => {
      const fixture = storeFixture()
      fixture.setMaterial("complete")
      fixture.store.automation.release = () => ({
        ...release,
        rules: [
          {
            ...release.rules[0]!,
            when: { all: true },
            actions: [
              { type: "presentation", policy: { standalone, aggregation, rewrite: "deny" } },
              { type: "ai_transform", prompt: "提取事实" },
            ],
          },
        ],
      })
      await runEntryProcessing({
        store: fixture.store,
        aiConfig: aiConfig as never,
        runtimeDir: "/tmp",
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
        execute: executeWith({
          entryId: "entry-1",
          event: null,
          title: "标题",
          summary: "摘要",
          disposition: "hide",
          reason: "语义建议隐藏",
          aggregation: false,
          rewrite: true,
          labels: [],
          facts: [],
        }),
      })
      expect(fixture.completed()).toMatchObject({
        status,
        policy: { standalone, aggregation, rewrite: "deny" },
      })
    },
  )
  it.each(["disabled", "unmatched", "local"] as const)(
    "%s 规则不调用单篇或批量模型",
    async (mode) => {
      const fixture = storeFixture()
      fixture.setMaterial("complete")
      fixture.store.automation.release = () => ({
        ...release,
        rules: [
          {
            ...release.rules[0]!,
            enabled: mode !== "disabled",
            when:
              mode === "unmatched"
                ? {
                    anyOf: [
                      {
                        allOf: [{ field: "entry_title", operator: "contains", value: "不会匹配" }],
                      },
                    ],
                  }
                : { all: true },
            actions:
              mode === "local"
                ? [{ type: "local_filter", mode: "block" }]
                : [{ type: "ai_transform", prompt: "测试" }],
          },
        ],
      })
      let called = false
      const result = await runEntryProcessing({
        store: fixture.store,
        aiConfig: {
          ...aiConfig,
          read: async () => {
            throw new Error("should_not_read_ai_credentials")
          },
        } as never,
        runtimeDir: "/tmp",
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
        execute: async () => {
          called = true
          throw new Error("unexpected_model")
        },
      })
      expect(called).toBe(false)
      expect(result.completed).toBe(0)
      expect(result.failures).toEqual([])
    },
  )

  it("正文材料尚未确认完整时保持 pending，且不调用模型", async () => {
    const fixture = storeFixture()
    const prompts: string[] = []
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: executeWith(
        {
          entryId: "entry-1",
          event: null,
          title: "标题",
          summary: "摘要",
          disposition: "keep",
          reason: "原因",
          aggregation: false,
          rewrite: false,
          labels: [],
          facts: [],
        },
        prompts,
      ),
    })

    expect(result).toMatchObject({ completed: 0, pending: 1, failures: [] })
    expect(prompts).toEqual([])
  })

  it.each([null, true] as const)("当前读态为 %s 时不回退旧未读输入调用模型", async (read) => {
    const fixture = storeFixture()
    fixture.setMaterial("complete")
    // 当前来源读态优先于输入快照；空值表示上游尚未确认。
    fixture.store.entry = () => ({ ...entry, read })
    let calls = 0
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: async () => {
        calls++
        throw new Error("unexpected_model")
      },
    })
    expect(calls).toBe(0)
    expect(result.completed).toBe(0)
    expect(result.pending).toBe(read === null ? 1 : 0)
    expect(result.failures).toEqual([])
  })

  it("已读条目不再请求模型，并在收敛时落为跳过态", async () => {
    const fixture = storeFixture("automatic", [], true)
    fixture.setMaterial("complete")
    // 收敛由 worker 在抓正文之前调用；这里单独验证映射与幂等，不依赖 worker。
    expect(settleReadStates(fixture.store)).toEqual({ skip: [1], revive: [] })
    const prompts: string[] = []
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: executeWith(
        {
          entryId: "entry-1",
          event: null,
          title: "标题",
          summary: "摘要",
          disposition: "keep",
          reason: "原因",
          aggregation: false,
          rewrite: false,
          labels: [],
          facts: [],
        },
        prompts,
      ),
    })

    // 既不请求模型，也不计入 pending：已读条目必须退出队列而不是每轮重新排队。
    expect(result).toMatchObject({ completed: 0, pending: 0, failures: [] })
    expect(prompts).toEqual([])
    expect(fixture.settled).toEqual([{ skip: [1], revive: [] }])
  })

  it("来源侧又变回未读时把跳过态放回队列", async () => {
    const fixture = storeFixture()
    fixture.setMaterial("complete")
    expect(settleReadStates(fixture.store)).toEqual({ skip: [], revive: [1] })
    const prompts: string[] = []
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: executeWith(
        {
          entryId: "entry-1",
          event: null,
          title: "标题",
          summary: "摘要",
          disposition: "keep",
          reason: "原因",
          aggregation: false,
          rewrite: false,
          labels: [],
          facts: [],
        },
        prompts,
      ),
    })

    expect(result).toMatchObject({ completed: 1, pending: 0, failures: [] })
    expect(prompts).toHaveLength(1)
    expect(fixture.settled).toEqual([{ skip: [], revive: [1] }])
  })

  it("按 historySince 与 cutoffAt 过滤候选，不将窗口外文章交给模型", async () => {
    const fixture = storeFixture()
    fixture.setMaterial("complete")
    const prompts: string[] = []
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      cutoffAt: "2026-09-11T23:59:59.000Z",
      signal: new AbortController().signal,
      execute: executeWith(
        {
          entryId: "entry-1",
          event: null,
          title: "标题",
          summary: "摘要",
          disposition: "keep",
          reason: "原因",
          aggregation: false,
          rewrite: false,
          labels: [],
          facts: [],
        },
        prompts,
      ),
    })

    expect(result).toMatchObject({ completed: 0, pending: 0, failures: [] })
    expect(prompts).toEqual([])
  })

  it("使用严格 Codex 输出，并让 needs_context 强制保留展示和禁止综合", async () => {
    const fixture = storeFixture()
    fixture.setMaterial("complete")
    const prompts: string[] = []
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: executeWith(
        {
          entryId: "entry-1",
          event: null,
          title: "标题",
          summary: "摘要",
          disposition: "needs_context",
          reason: "原因",
          aggregation: true,
          rewrite: true,
          labels: [],
          facts: [{ text: "事实", evidenceId: "E000001", kind: "fact" }],
        },
        prompts,
      ),
    })

    expect(result).toMatchObject({ completed: 1, failures: [] })
    expect(fixture.completed()).toMatchObject({
      status: "needs_context",
      policy: { standalone: "always", aggregation: "deny", rewrite: "deny" },
      facts: [{ text: "事实", quote: "真实原文事实。", kind: "fact" }],
    })
    expect(prompts[0]).toContain("只能返回一个目录中的 evidenceId")
    expect(prompts[0]).toContain('"evidenceId":"E000001","text":"真实原文事实。"')
    expect(prompts[0]).toContain(SOURCE_FIDELITY_REQUIREMENTS)
    // 编号引用只允许单段直接支持整条事实，不能借用相邻证据或混淆报道日期。
    expect(prompts[0]).toContain("不能借用相邻片段补足该事实")
    expect(prompts[0]).toContain("报道日期、发布日期与事件发生日期必须区分")
    expect(prompts[0]).toContain("数组上限不是数量目标")
    expect(prompts[0]!.match(/真实原文事实。/gu)).toHaveLength(1)
  })

  it("拒绝未知 evidenceId，记录失败且不发布决策", async () => {
    const fixture = storeFixture()
    fixture.setMaterial("complete")
    const output = {
      entryId: "entry-1",
      title: "标题",
      summary: "摘要",
      disposition: "keep" as const,
      reason: "原因",
      aggregation: true,
      rewrite: true,
      labels: [],
      facts: [{ text: "事实", evidenceId: "E999999", kind: "fact" as const }],
    }
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: async (options) => {
        // 真实执行器会先拒绝越界输出；这里绕过一次以证明服务端原有严格校验仍然有效。
        expect(options.validate(output)).toBe(false)
        expect(options.validate({ ...output, entryId: "other-entry", facts: [] })).toBe(false)
        expect(JSON.stringify(options.schema)).toContain(
          '"entryId":{"type":"string","enum":["entry-1"]}',
        )
        expect(JSON.stringify(options.schema)).toContain(
          '"evidenceId":{"type":"string","enum":["E000001"]}',
        )
        return {
          result: output as never,
          model: options.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      },
    })

    expect(result.failures).toEqual([{ inputSeq: 1, code: "invalid_model_reference" }])
    expect(fixture.completed()).toBeNull()
  })

  it("人工恢复强制展示并禁止重新聚合或改写", async () => {
    const fixture = storeFixture("restore")
    fixture.setMaterial("complete")
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: executeWith({
        entryId: "entry-1",
        event: null,
        title: "标题",
        summary: "摘要",
        disposition: "hide",
        reason: "原因",
        aggregation: true,
        rewrite: true,
        labels: [],
        facts: [{ text: "事实", evidenceId: "E000001", kind: "fact" }],
      }),
    })

    expect(result.completed).toBe(1)
    expect(fixture.completed()).toMatchObject({
      status: "keep",
      policy: { standalone: "always", aggregation: "deny", rewrite: "deny" },
    })
  })

  it("显式规则优先于语义聚合，未指定字段采用语义并传入标签角色", async () => {
    const fixture = storeFixture("automatic", ["tag"])
    fixture.setMaterial("complete")
    const prompts: string[] = []
    const result = await runEntryProcessing({
      store: fixture.store,
      aiConfig: aiConfig as never,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00.000Z",
      signal: new AbortController().signal,
      execute: executeWith(
        {
          entryId: "entry-1",
          event: null,
          title: "标题",
          summary: "摘要",
          disposition: "keep",
          reason: "原因",
          aggregation: true,
          rewrite: false,
          labels: [],
          facts: [{ text: "事实", evidenceId: "E000001", kind: "fact" }],
        },
        prompts,
      ),
    })

    expect(result.completed).toBe(1)
    expect(fixture.completed()).toMatchObject({
      sourceRole: "媒体",
      status: "keep",
      policy: { standalone: "auto", aggregation: "deny", rewrite: "deny" },
    })
    expect(prompts[0]).toContain("来源角色元数据：媒体")
  })

  it(">60k 正文逐块处理全部材料后再综合", async () => {
    const original = input.body.content
    input.body.content = ["甲", "乙", "丙", "丁"]
      .map((value) => `<p>${value.repeat(20_000)}</p>`)
      .join("")
    const runtimeDir = await mkdtemp(join(tmpdir(), "processing-engine-"))
    try {
      const fixture = storeFixture()
      fixture.setMaterial("complete")
      const chunks = ["甲", "乙", "丙", "丁"]
      let chunkIndex = 0
      const prompts: string[] = []
      const result = await runEntryProcessing({
        store: fixture.store,
        aiConfig: aiConfig as never,
        runtimeDir,
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        signal: new AbortController().signal,
        execute: async (options) => {
          prompts.push(options.prompt)
          const output = options.prompt.includes("长文分块阅读器")
            ? {
                chunkId: `entry-1:${chunkIndex + 1}/4`,
                summary: `分块 ${chunkIndex + 1}`,
                facts: [
                  {
                    text: "事实",
                    evidenceId: `C${++chunkIndex}E000001`,
                    kind: "fact",
                  },
                ],
              }
            : {
                entryId: "entry-1",
                event: null,
                title: "标题",
                summary: "综合摘要",
                disposition: "keep",
                reason: "原因",
                aggregation: true,
                rewrite: true,
                labels: [],
                facts: chunks.map((_, index) => ({
                  text: "事实",
                  evidenceId: `FE${String(index + 1).padStart(6, "0")}`,
                  kind: "fact" as const,
                })),
              }
          if (!options.validate(output)) throw new Error("invalid_stub_output")
          return {
            result: output,
            model: options.model,
            durationMs: 2,
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
            toolCalls: 0,
          }
        },
      })

      expect(result).toMatchObject({ completed: 1, pending: 0, failures: [] })
      expect(prompts).toHaveLength(5)
      expect(prompts.every((prompt) => prompt.includes(SOURCE_FIDELITY_REQUIREMENTS))).toBe(true)
      expect(prompts.every((prompt) => prompt.includes("不得为了接近或填满上限而凑数"))).toBe(true)
      expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 25, cachedInputTokens: 0 })
      expect(fixture.completed()).toMatchObject({ policy: { rewrite: "deny" } })
    } finally {
      input.body.content = original
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })
})

it("同模型换自定义端点不会复用另一网关决定缓存，同端点重算仍可复用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-entry-endpoint-"))
  const store = new Store(":memory:")
  const config = new AIConfigStore(join(directory, "ai.json"))
  let calls = 0
  const endpoints: Array<string | undefined> = []
  try {
    store.bindOwner("owner")
    store.automation.saveDraft({ ...release, rules: [release.rules[1]!] }, 0)
    store.automation.publish(1, { mode: "future" }, randomUUID())
    store.saveEntry(entry)
    store.processingState.setMaterial(store.automation.inputs()[0]!, "complete")
    const execute = async <T>(request: CodexJsonOptions<T>) => {
      calls++
      endpoints.push(request.qianwen?.baseUrl)
      const output = batchSelection("entry-1", "E000001")
      expect(request.validate(output)).toBe(true)
      return { result: output as T, model: request.model, durationMs: 1, usage: null, toolCalls: 0 }
    }
    const options = {
      store,
      aiConfig: config,
      runtimeDir: directory,
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00Z",
      signal: new AbortController().signal,
      execute,
    }
    await config.save({
      provider: "openai-compatible",
      model: "same-model",
      baseUrl: "https://first.test/v1",
      apiKey: "first-key",
    })
    expect((await runEntryProcessing(options)).completed).toBe(1)
    store.automation.invalidateSources(["feed/1"])
    await config.save({
      provider: "openai-compatible",
      model: "same-model",
      baseUrl: "https://second.test/v1",
      apiKey: "second-key",
    })
    expect((await runEntryProcessing(options)).completed).toBe(1)
    expect(calls).toBe(2)
    expect(endpoints).toEqual(["https://first.test/v1", "https://second.test/v1"])
    store.automation.invalidateSources(["feed/1"])
    expect(await runEntryProcessing(options)).toMatchObject({
      completed: 1,
      metrics: { modelCalls: 0, cacheHits: 1 },
    })
    expect(calls).toBe(2)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it("推理强度冻结并隔离单篇缓存，同强度重算仍可复用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-entry-endpoint-"))
  const store = new Store(":memory:")
  const config = new AIConfigStore(join(directory, "ai.json"))
  let calls = 0
  const efforts: Array<string | undefined> = []
  try {
    store.bindOwner("owner")
    store.automation.saveDraft({ ...release, rules: [release.rules[1]!] }, 0)
    store.automation.publish(1, { mode: "future" }, randomUUID())
    store.saveEntry(entry)
    store.processingState.setMaterial(store.automation.inputs()[0]!, "complete")
    const execute = async <T>(request: CodexJsonOptions<T>) => {
      calls++
      efforts.push(request.reasoningEffort)
      if (calls === 2) throw new CodexRunError("TIMEOUT")
      const output = batchSelection("entry-1", "E000001")
      expect(request.validate(output)).toBe(true)
      return { result: output as T, model: request.model, durationMs: 1, usage: null, toolCalls: 0 }
    }
    const options = {
      store,
      aiConfig: config,
      runtimeDir: directory,
      sourceKeys: ["feed/1"],
      historySince: "2026-09-01T00:00:00Z",
      signal: new AbortController().signal,
      execute,
    }
    // 私有读取使用假快照，不访问正式目录或实际模型。
    config.read = async () => ({ provider: "codex", model: "same-model", reasoningEffort: "low" })
    expect((await runEntryProcessing(options)).completed).toBe(1)
    store.automation.invalidateSources(["feed/1"])
    config.read = async () => ({ provider: "codex", model: "same-model", reasoningEffort: "high" })
    expect((await runEntryProcessing(options)).failures).toHaveLength(1)
    config.read = async () => ({ provider: "codex", model: "same-model", reasoningEffort: "low" })
    store.processingState.retry(store.automation.inputs()[0]!.seq)
    expect((await runEntryProcessing(options)).completed).toBe(1)
    expect(calls).toBe(3)
    expect(efforts).toEqual(["low", "high", "high"])
    config.read = async () => ({ provider: "codex", model: "same-model", reasoningEffort: "high" })
    store.automation.invalidateSources(["feed/1"])
    expect(await runEntryProcessing(options)).toMatchObject({
      completed: 1,
      metrics: { modelCalls: 0, cacheHits: 1 },
    })
    expect(calls).toBe(3)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
