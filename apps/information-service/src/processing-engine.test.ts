import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import type { RuleSet } from "@follow/information-core"
import { join } from "pathe"
import { describe, expect, it } from "vitest"

import type { CodexJsonOptions } from "./codex"
import type { ProcessingEngineStore } from "./processing-engine"
import { runEntryProcessing } from "./processing-engine"
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

function storeFixture(mode: "restore" | "hide" | "automatic" = "automatic", tagIds: string[] = []) {
  let cached: unknown = null
  let completed: unknown = null
  let material: "complete" | "missing" | "failed" | null = null
  const failed: string[] = []
  const store = {
    automation: {
      inputs: () => [input],
      release: () => release,
      complete: (_target: unknown, decision: unknown) => {
        completed = decision
        return { id: "decision", published: true }
      },
      current: () => null,
    },
    processingState: {
      prepare: (_seq: number, snapshot: unknown) => ({
        input,
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

const aiConfig = {
  read: async () => ({ provider: "codex" as const, model: "test-model" }),
  execution: async () => undefined,
}

describe("单篇处理 engine", () => {
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
        disposition: "keep",
        reason: "原因",
        aggregation: true,
        rewrite: true,
        labels: [],
        facts: [{ text: "事实", evidenceId: "E999999", kind: "fact" }],
      }),
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
