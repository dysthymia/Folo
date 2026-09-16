import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import type { RuleSet } from "@follow/information-core"
import { compileInstructions } from "@follow/information-core"
import { join } from "pathe"
import { describe, expect, it } from "vitest"

import type { CodexJsonOptions } from "./codex"
import { processLongEntry, splitEntryText } from "./processing-chunks"
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
        instructions,
        sourceRole: "媒体",
        historySince: "2026-09-01T00:00:00.000Z",
        runtimeDir,
        signal: new AbortController().signal,
        execute: async (options) => {
          prompts.push(options.prompt)
          const output = outputFor(options, ["甲", "乙", "丙"][chunks]!, ++chunks)
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
      ).rejects.toThrow("invalid_model_reference")
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
      ).rejects.toThrow("invalid_model_reference")
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
