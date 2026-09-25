import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import type { RuleSet } from "@follow/information-core"
import { join } from "pathe"
import { describe, expect, it } from "vitest"

import type { CodexJsonOptions } from "./codex"
import type { ProcessingEngineStore } from "./processing-engine"
import { runEntryProcessing, settleReadStates } from "./processing-engine"
import { SOURCE_FIDELITY_REQUIREMENTS } from "./processing-prompt"

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
        if (published) completed.set(target.itemId, decision)
        return { id: `decision-${target.seq}`, published }
      },
    },
    processingState: {
      prepare: (seq: number, snapshot: unknown) => {
        const original = inputs[seq - 1]!
        return { input: current.get(original.itemId) ?? original, snapshot }
      },
      start: () => true,
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
        const isBatch = options.prompt.includes("有界批量单篇阅读处理器")
        const requestedId = options.prompt.match(/entryId=(entry-\d+)/u)?.[1]
        if (isBatch) {
          const schema = JSON.stringify(options.schema)
          expect(schema).toContain('"entryId":{"type":"string","enum":["entry-1"]}')
          expect(schema).toContain('"entryId":{"type":"string","enum":["entry-5"]}')
          expect(schema).toContain('"evidenceId":{"type":"string","enum":["B1E000001"]}')
          expect(schema).toContain('"evidenceId":{"type":"string","enum":["B5E000001"]}')
          expect(schema).toContain(
            '"required":["entryId","title","summary","disposition","reason","aggregation","rewrite","labels","facts"]',
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

  it("多个批次等待期间 generation 换代时不发布旧批结果", async () => {
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
        const items = Array.from({ length: range[1]! - range[0]! + 1 }, (_, offset) => {
          const seq = range[0]! + offset
          return batchSelection(`entry-${seq}`, `B${seq}E000001`)
        })
        expect(options.validate({ items })).toBe(true)
        if (calls === 2) fixture.bumpGeneration("entry-1")
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
    expect(result).toEqual({
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
