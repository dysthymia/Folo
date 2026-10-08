import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import type { RuleSet, SemanticTagId } from "@follow/information-core"
import { compileInstructions } from "@follow/information-core"
import { join } from "pathe"
import { describe, expect, it } from "vitest"

import { aiEndpointFingerprint } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { processLongEntry, splitEntryText } from "./processing-chunks"
import type { EventSelection } from "./processing-event"
import { traceableRelatedEvent } from "./processing-event"
import { ENTRY_PROMPT_VERSION, SOURCE_FIDELITY_REQUIREMENTS } from "./processing-prompt"

const instructions = compileInstructions(
  {
    formatVersion: 4,
    ownerId: "owner",
    global: { version: 1, markdown: "全局规则" },
    rules: [
      {
        id: "transform",
        ownerId: "owner",
        name: "提取",
        enabled: true,
        order: 0,
        when: { all: true },
        actions: [{ type: "ai_transform", prompt: "保留事实" }],
        version: 1,
        executionLocation: "processing_service",
      },
    ],
  } satisfies RuleSet,
  { source_id: "feed/1", contextId: "feed/1" },
)

const text = ["甲", "乙", "丙"].map((value) => `${value.repeat(20_000)}\n\n`).join("")

function outputFor(options: CodexJsonOptions<unknown>, chunk: string, index: number) {
  if (options.prompt.includes("长文分块阅读器")) {
    return {
      chunkId: `entry-1:${index}/3`,
      summary: `第 ${index} 块`,
      facts: [{ text: "事实", evidenceId: `C${index}E000001`, kind: "fact" }],
    }
  }
  return {
    entryId: "entry-1",
    event: null,
    title: "综合标题",
    summary: "综合摘要",
    disposition: "keep",
    reason: "原因",
    aggregation: true,
    rewrite: false,
    labels: [],
    facts: [1, 2, 3].map((index) => ({
      text: "事实",
      evidenceId: `FE${String(index).padStart(6, "0")}`,
      kind: "fact" as const,
    })),
  }
}

describe("长文分块", () => {
  it("按段落分块且超长段落不切断 grapheme", () => {
    const original = `甲👨‍👩‍👧‍👦${"乙".repeat(10)}\n\n丙丁`
    const chunks = splitEntryText(original, 5)
    expect(chunks.join("")).toBe(original)
    expect(chunks.join("")).toContain("👨‍👩‍👧‍👦")
  })

  it("处理全部 >60k 分块，并让最终事实跨块引用", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "processing-chunks-"))
    try {
      let chunks = 0
      const prompts: string[] = []
      const result = await processLongEntry({
        entryId: "entry-1",
        text,
        provider: "codex",
        model: "test-model",
        instructions: { ...instructions, display: { language: "en", summaryMaxGraphemes: 2 } },
        sourceRole: "媒体",
        historySince: "2026-09-01T00:00:00.000Z",
        runtimeDir,
        signal: new AbortController().signal,
        execute: async (options) => {
          prompts.push(options.prompt)
          const output = outputFor(options, ["甲", "乙", "丙"][chunks]!, ++chunks)
          if (options.prompt.includes("长文分块阅读器")) {
            expect(options.validate({ ...output, chunkId: "other-chunk" })).toBe(false)
          } else {
            expect(options.validate({ ...output, entryId: "other-entry" })).toBe(false)
          }
          if (!options.validate(output)) throw new Error("invalid_stub_output")
          return {
            result: output,
            model: options.model,
            durationMs: 1,
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
            toolCalls: 0,
          }
        },
      })
      expect(result).toMatchObject({
        status: "complete",
      })
      if (result.status !== "complete") throw new Error("unexpected_pending")
      expect(result.output.summary).toBe("综合")
      expect(prompts.at(-1)).toContain("标题与摘要使用语言：en")
      expect(result.output.facts.map((fact) => fact.quote[0])).toEqual(["甲", "乙", "丙"])
      expect(result.output.facts.every((fact) => fact.quote.length === 4_000)).toBe(true)
      expect(chunks).toBe(4)
      expect(prompts.every((prompt) => prompt.includes(SOURCE_FIDELITY_REQUIREMENTS))).toBe(true)
      // 分块与最终合成遵守同一个证据支持约束。
      expect(prompts.every((prompt) => prompt.includes("不能借用相邻片段补足该事实"))).toBe(true)
      expect(prompts.every((prompt) => prompt.includes("只保留不重复的关键事实"))).toBe(true)
      expect(prompts.every((prompt) => !prompt.includes('"quote"'))).toBe(true)
      const final = prompts.at(-1)!
      expect(final.split("甲".repeat(4_000))).toHaveLength(2)
      const cacheFiles = await readdir(join(runtimeDir, "entry-chunk-cache"))
      const cached = JSON.parse(
        await readFile(join(runtimeDir, "entry-chunk-cache", cacheFiles[0]!), "utf8"),
      ) as { version: number }
      expect(cached.version).toBe(ENTRY_PROMPT_VERSION)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it("拒绝分块选择目录外证据，且 wire 不接受自由 quote", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "processing-chunks-"))
    try {
      await expect(
        processLongEntry({
          entryId: "entry-1",
          text: "唯一连续原文。",
          provider: "codex",
          model: "test-model",
          instructions,
          sourceRole: "媒体",
          historySince: "2026-09-01T00:00:00.000Z",
          runtimeDir,
          signal: new AbortController().signal,
          execute: async (options) => {
            const withQuote = {
              chunkId: "entry-1:1/1",
              summary: "分块摘要",
              facts: [
                { text: "事实", evidenceId: "C1E999999", quote: "唯一连续原文。", kind: "fact" },
              ],
            }
            expect(options.validate(withQuote)).toBe(false)
            const output = {
              chunkId: "entry-1:1/1",
              summary: "分块摘要",
              facts: [{ text: "事实", evidenceId: "C1E999999", kind: "fact" }],
            }
            expect(options.validate(output)).toBe(false)
            throw new Error("invalid_stub_output")
          },
        }),
      ).rejects.toThrow("invalid_stub_output")
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it("拒绝综合器选择未经过分块验证的证据", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "processing-chunks-"))
    try {
      await expect(
        processLongEntry({
          entryId: "entry-1",
          text: "唯一连续原文。",
          provider: "codex",
          model: "test-model",
          instructions,
          sourceRole: "媒体",
          historySince: "2026-09-01T00:00:00.000Z",
          runtimeDir,
          signal: new AbortController().signal,
          execute: async (options) => {
            const output = options.prompt.includes("长文分块阅读器")
              ? {
                  chunkId: "entry-1:1/1",
                  summary: "分块摘要",
                  facts: [{ text: "事实", evidenceId: "C1E000001", kind: "fact" }],
                }
              : {
                  entryId: "entry-1",
                  title: "综合标题",
                  summary: "综合摘要",
                  disposition: "keep",
                  reason: "原因",
                  aggregation: false,
                  rewrite: false,
                  labels: [],
                  facts: [{ text: "事实", evidenceId: "FE999999", kind: "fact" }],
                }
            if (!options.validate(output)) {
              expect(options.prompt).not.toContain("长文分块阅读器")
              throw new Error("invalid_stub_output")
            }
            return {
              result: output,
              model: options.model,
              durationMs: 1,
              usage: null,
              toolCalls: 0,
            }
          },
        }),
      ).rejects.toThrow("invalid_stub_output")
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it("中断后复用已落盘的分块，不重复调用第一个分块", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "processing-chunks-"))
    try {
      let firstRun = 0
      await expect(
        processLongEntry({
          entryId: "entry-1",
          text,
          provider: "codex",
          model: "test-model",
          instructions,
          sourceRole: "媒体",
          historySince: "2026-09-01T00:00:00.000Z",
          runtimeDir,
          signal: new AbortController().signal,
          execute: async (options) => {
            firstRun++
            if (firstRun === 2) throw new Error("simulated_failure")
            const output = outputFor(options, "甲", 1)
            if (!options.validate(output)) throw new Error("invalid_stub_output")
            return {
              result: output,
              model: options.model,
              durationMs: 1,
              usage: null,
              toolCalls: 0,
            }
          },
        }),
      ).rejects.toThrow("simulated_failure")

      let resumedCalls = 0
      let nextChunkIndex = 2
      const result = await processLongEntry({
        entryId: "entry-1",
        text,
        provider: "codex",
        model: "test-model",
        instructions,
        sourceRole: "媒体",
        historySince: "2026-09-01T00:00:00.000Z",
        runtimeDir,
        signal: new AbortController().signal,
        execute: async (options) => {
          resumedCalls++
          const index = nextChunkIndex
          if (options.prompt.includes("长文分块阅读器")) nextChunkIndex++
          const output = outputFor(options, ["甲", "乙", "丙"][index - 1] ?? "甲", index)
          if (!options.validate(output)) throw new Error("invalid_stub_output")
          return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
        },
      })
      expect(result.status).toBe("complete")
      expect(resumedCalls).toBe(3)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })
})

it("自定义端点身份隔离长文分块缓存，同端点仍复用已验证分块", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "folo-chunk-endpoint-"))
  let chunkCalls = 0
  try {
    const execute = async <T>(options: CodexJsonOptions<T>) => {
      const chunk = options.prompt.includes("长文分块阅读器")
      if (chunk) chunkCalls++
      const output = chunk
        ? {
            chunkId: "entry-1:1/1",
            summary: "分块",
            facts: [{ text: "事实", evidenceId: "C1E000001", kind: "fact" }],
          }
        : {
            entryId: "entry-1",
            event: null,
            title: "标题",
            summary: "摘要",
            disposition: "keep",
            reason: "原因",
            aggregation: true,
            rewrite: false,
            labels: [],
            facts: [{ text: "事实", evidenceId: "FE000001", kind: "fact" }],
          }
      if (!options.validate(output)) throw new Error("invalid_stub_output")
      return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
    }
    const options = {
      entryId: "entry-1",
      text: "唯一完整原文事实。",
      provider: "openai-compatible" as const,
      model: "same-model",
      instructions,
      sourceRole: "媒体",
      historySince: "2026-09-01T00:00:00Z",
      runtimeDir,
      signal: new AbortController().signal,
      execute,
    }
    await processLongEntry({
      ...options,
      endpointFingerprint: aiEndpointFingerprint({
        provider: "openai-compatible",
        baseUrl: "https://first.test/v1",
      }),
    })
    await processLongEntry({
      ...options,
      endpointFingerprint: aiEndpointFingerprint({
        provider: "openai-compatible",
        baseUrl: "https://second.test/v1",
      }),
    })
    await processLongEntry({
      ...options,
      endpointFingerprint: aiEndpointFingerprint({
        provider: "openai-compatible",
        baseUrl: "https://second.test/v1",
      }),
    })
    expect(chunkCalls).toBe(2)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

it("推理强度隔离分块缓存，分块与综合同强度执行", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "folo-chunk-endpoint-"))
  let chunkCalls = 0
  const efforts: Array<string | undefined> = []
  try {
    const execute = async <T>(options: CodexJsonOptions<T>) => {
      efforts.push(options.reasoningEffort)
      const chunk = options.prompt.includes("长文分块阅读器")
      if (chunk) chunkCalls++
      const output = chunk
        ? {
            chunkId: "entry-1:1/1",
            summary: "分块",
            facts: [{ text: "事实", evidenceId: "C1E000001", kind: "fact" }],
          }
        : {
            entryId: "entry-1",
            event: null,
            title: "标题",
            summary: "摘要",
            disposition: "keep",
            reason: "原因",
            aggregation: true,
            rewrite: false,
            labels: [],
            facts: [{ text: "事实", evidenceId: "FE000001", kind: "fact" }],
          }
      if (!options.validate(output)) throw new Error("invalid_stub_output")
      return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
    }
    const options = {
      entryId: "entry-1",
      text: "唯一完整原文事实。",
      provider: "codex" as const,
      model: "same-model",
      instructions,
      sourceRole: "媒体",
      historySince: "2026-09-01T00:00:00Z",
      runtimeDir,
      signal: new AbortController().signal,
      execute,
    }
    await processLongEntry({ ...options, reasoningEffort: "low" })
    await processLongEntry({ ...options, reasoningEffort: "high" })
    await processLongEntry({ ...options, reasoningEffort: "high" })
    expect(efforts).toEqual(["low", "low", "high", "high", "high"])
    expect(chunkCalls).toBe(2)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

it("语义长文保留 facts 外的后文贡献，拒绝不完整评估且策略改动复用缓存", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "folo-semantic-chunks-"))
  const semanticIds: SemanticTagId[] = ["signal:pure_promotion", "form:tutorial"]
  let chunkCalls = 0
  const finalPrompts: string[] = []
  const assessments = (
    pure: "present" | "absent",
    tutorial: "present" | "absent",
    evidenceId: string,
  ) => [
    {
      tagId: "signal:pure_promotion",
      definitionVersion: 1,
      state: pure,
      confidence: 0.99,
      reason: "本分块判断",
      evidenceIds: [evidenceId],
    },
    {
      tagId: "form:tutorial",
      definitionVersion: 1,
      state: tutorial,
      confidence: 0.99,
      reason: "本分块判断",
      evidenceIds: [evidenceId],
    },
  ]
  try {
    const execute = async <T>(options: CodexJsonOptions<T>) => {
      const isChunk = options.prompt.includes("长文分块阅读器")
      let output: unknown
      if (isChunk) {
        chunkCalls++
        const useful = options.prompt.includes("具体教程")
        const index = useful ? 2 : 1
        output = {
          chunkId: `entry-1:${index}/2`,
          summary: useful ? "教程后文" : "推广开头",
          facts: [],
          semantic: {
            coverage: "complete",
            eventMentions: [],
            entities: [],
            tagAssessments: assessments(
              useful ? "absent" : "present",
              useful ? "present" : "absent",
              `C${index}E000001`,
            ),
            substantiveContribution: {
              state: useful ? "present" : "absent",
              evidenceIds: useful ? [`C${index}E000001`] : [],
            },
          },
        }
        const chunk = output as {
          semantic: { tagAssessments: unknown[]; substantiveContribution: unknown }
        }
        expect(
          options.validate({ ...chunk, semantic: { ...chunk.semantic, tagAssessments: [] } }),
        ).toBe(false)
        expect(
          options.validate({
            ...chunk,
            semantic: {
              ...chunk.semantic,
              substantiveContribution: { state: "present", evidenceIds: ["C999E000001"] },
            },
          }),
        ).toBe(false)
      } else {
        finalPrompts.push(options.prompt)
        expect(options.prompt).toContain("具体教程")
        expect(options.prompt).toContain('"facts":[]')
        expect(options.prompt).not.toContain("最终摘要最多")
        output = {
          entryId: "entry-1",
          event: null,
          title: "完整长文",
          summary: "推广开头之后仍有完整有用教程",
          disposition: "keep",
          reason: "保留有用内容",
          aggregation: false,
          rewrite: false,
          labels: [],
          facts: [],
          eventMentions: [],
          entities: [],
          // 故意让综合器误判纯推广，确定性覆盖归并必须修正这个结论。
          tagAssessments: assessments("present", "absent", "FE000001"),
        }
        expect(
          options.validate({
            ...(output as object),
            tagAssessments: assessments("present", "absent", "FE999999"),
          }),
        ).toBe(false)
      }
      if (!options.validate(output)) throw new Error("invalid_semantic_stub_output")
      return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
    }
    const options = {
      entryId: "entry-1",
      text: `${"加入推广群。".repeat(3_000)}\n\n${"具体教程配置方法。".repeat(2_000)}`,
      provider: "codex" as const,
      model: "same-model",
      instructions: {
        ...instructions,
        semanticTagIds: semanticIds,
        display: { summaryMaxGraphemes: 2 },
      },
      sourceRole: "媒体",
      historySince: "2026-09-01T00:00:00Z",
      runtimeDir,
      signal: new AbortController().signal,
      execute,
    }
    const first = await processLongEntry(options)
    expect(first.status).toBe("complete")
    if (first.status !== "complete") throw new Error("unexpected_pending")
    expect(first.output.summary).toBe("推广开头之后仍有完整有用教程")
    expect(first.output.tagAssessments?.map((item) => item.state)).toEqual(["absent", "present"])
    const tagEvidence = first.output.tagAssessments?.flatMap((item) => item.evidenceIds) ?? []
    expect(tagEvidence.every((id) => typeof first.semanticEvidence?.[id] === "string")).toBe(true)
    expect(first.output.facts).toEqual([])
    const second = await processLongEntry({
      ...options,
      instructions: {
        ...options.instructions,
        policy: { ...options.instructions.policy, standalone: "never" },
        display: { summaryMaxGraphemes: 100, language: "ja" },
      },
    })
    expect(second.status).toBe("complete")
    expect(chunkCalls).toBe(2)
    expect(finalPrompts).toHaveLength(2)
    const files = await readdir(join(runtimeDir, "entry-chunk-cache"))
    expect(files).toHaveLength(2)
    expect(
      JSON.parse(await readFile(join(runtimeDir, "entry-chunk-cache", files[0]!), "utf8")),
    ).toMatchObject({ version: "semantic-chunks-v3" })
    // 当前定义版本与证据映射须在读取缓存时再次核实，损坏缓存只重跑对应分块。
    const cachedPath = join(runtimeDir, "entry-chunk-cache", files[0]!)
    const cached = JSON.parse(await readFile(cachedPath, "utf8")) as {
      output: { semantic: { tagAssessments: Array<{ definitionVersion: number }> } }
    }
    cached.output.semantic.tagAssessments[0]!.definitionVersion = 999
    await writeFile(cachedPath, JSON.stringify(cached))
    await processLongEntry(options)
    expect(chunkCalls).toBe(3)
    await processLongEntry({
      ...options,
      instructions: {
        ...options.instructions,
        global: { ...options.instructions.global, markdown: "增加明确分析指令" },
      },
    })
    expect(chunkCalls).toBe(5)
    expect(await readdir(join(runtimeDir, "entry-chunk-cache"))).toHaveLength(4)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

it("长文多事件身份独立于有限facts保留原文证据，未读关联材料保持候选覆盖", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "folo-multiple-event-chunks-"))
  const first = "OpenAI 发布 GPT 5.2，官方公告 https://openai.com/notice/52 。"
  const second = "Anthropic 正在准备 Claude，发生日期未知，引用图片未读取。"
  const text = `${first}\n${"甲".repeat(16_000)}\n\n${second}\n${"乙".repeat(16_000)}`
  const identity = (evidenceId: string, index: number): EventSelection => ({
    kind: "event",
    subject: { value: index === 1 ? "OpenAI" : "Anthropic", evidenceId },
    action: { value: "product_release", evidenceId },
    object: { value: index === 1 ? "GPT" : "Claude", evidenceId },
    version: index === 1 ? { value: "5.2", evidenceId } : null,
    round: null,
    anchor: null,
  })
  const tags = (evidenceId: string) => [
    {
      tagId: "topic:ai",
      definitionVersion: 1,
      state: "present",
      confidence: 0.99,
      reason: "模型发布信息",
      evidenceIds: [evidenceId],
    },
  ]
  let calls = 0
  try {
    const result = await processLongEntry({
      entryId: "entry-1",
      text,
      provider: "codex",
      model: "test-model",
      instructions: { ...instructions, semanticTagIds: ["topic:ai"] },
      sourceRole: "媒体",
      historySince: "2026-09-01T00:00:00Z",
      runtimeDir,
      signal: new AbortController().signal,
      execute: async (options) => {
        calls++
        const chunk = options.prompt.includes("长文分块阅读器")
        let output: unknown
        if (chunk) {
          const index = options.prompt.includes("OpenAI") ? 1 : 2
          const id = `C${index}E000001`
          output = {
            chunkId: `entry-1:${index}/2`,
            summary: index === 1 ? "发布报道" : "附带候选",
            facts: [],
            semantic: {
              coverage: index === 1 ? "complete" : "partial",
              tagAssessments: tags(id),
              entities: [
                {
                  kind: "organization",
                  name: index === 1 ? "OpenAI" : "Anthropic",
                  parentName: null,
                  aliases: [],
                  confidence: 0.99,
                  evidenceIds: [id],
                },
              ],
              eventMentions: [
                { identity: identity(id, index), role: "reports", isPrimary: index === 1 },
              ],
              substantiveContribution: { state: "present", evidenceIds: [id] },
            },
          }
        } else {
          expect(options.prompt).toContain(first)
          expect(options.prompt).toContain(second)
          expect(options.prompt).toContain('"facts":[]')
          expect(options.prompt).toContain('"coverage":"partial"')
          output = {
            entryId: "entry-1",
            title: "两项模型信息",
            summary: "主报道与次要候选",
            disposition: "keep",
            reason: "保留原文",
            aggregation: true,
            rewrite: false,
            labels: [],
            facts: [],
            tagAssessments: tags("FE000001"),
            entities: [
              {
                kind: "organization",
                name: "Anthropic",
                parentName: null,
                aliases: [],
                confidence: 0.99,
                evidenceIds: ["FE000002"],
              },
            ],
            event: identity("FE000001", 1),
            eventMentions: [
              { identity: identity("FE000001", 1), role: "reports", isPrimary: true },
              { identity: identity("FE000002", 2), role: "mentions", isPrimary: false },
            ],
          }
          expect(
            options.validate({
              ...(output as object),
              eventMentions: [
                { identity: identity("C2E000001", 2), role: "mentions", isPrimary: false },
              ],
            }),
          ).toBe(false)
        }
        if (!options.validate(output)) throw new Error("invalid_mentions_stub")
        return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
      },
    })
    expect(result.status).toBe("complete")
    if (result.status !== "complete") throw new Error("unexpected_pending")
    expect(result.semanticCoverage).toBe("partial")
    // facts为空仍保留后半篇实体，编号已切换到最终目录。
    expect(result.output.entities).toMatchObject([{ name: "Anthropic", evidenceIds: ["FE000002"] }])
    expect(result.output.eventMentions).toHaveLength(2)
    expect(result.output.facts).toEqual([])
    expect(result.output.eventMentions?.[0]?.identity.subject.quote).toBe(`${first}\n`)
    expect(result.output.eventMentions?.[1]?.identity.subject.quote).toBe(`${second}\n`)
    expect(result.semanticEvidence?.FE000002).toBe(`${second}\n`)
    expect(traceableRelatedEvent(result.output.eventMentions?.[0]?.identity, text)).not.toBeNull()
    expect(traceableRelatedEvent(result.output.eventMentions?.[1]?.identity, text)).toBeNull()
    expect(result.output.tagAssessments?.[0]?.state).toBe("present")
    expect(calls).toBe(3)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})
