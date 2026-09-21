import { describe, expect, it, vi } from "vitest"

import type { SemanticDuplicateCandidate, SemanticDuplicateEntry } from "./semantic-dedupe"
import {
  createSemanticDuplicatePrompt,
  evaluateSemanticDuplicateCandidates,
  getSemanticDuplicateCandidates,
  MAX_SEMANTIC_DUPLICATE_CANDIDATES,
  normalizeDedupeText,
  semanticDuplicatePairKey,
  truncateDedupeDescription,
} from "./semantic-dedupe"

function entry(
  itemId: string,
  title: string,
  publishedAt: string,
  description = "",
): SemanticDuplicateEntry {
  return {
    description,
    itemId,
    publishedAt,
    sourceTitle: "来源",
    title,
    urlHost: "example.test",
  }
}

const base = Date.parse("2026-01-10T00:00:00.000Z")
const at = (hours: number) => new Date(base + hours * 60 * 60 * 1000).toISOString()

describe("语义去重候选预筛", () => {
  it("同一事件的两条互为候选，默认保留较旧的一条", () => {
    // 传入顺序颠倒也不会改变方向：函数内部按发布时间从新到旧排序。
    const candidates = getSemanticDuplicateCandidates([
      entry("older", "OpenAI 发布 GPT-6 模型", at(0)),
      entry("newer", "OpenAI 发布 GPT-6 模型（更新）", at(6)),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ keepEntryId: "older", testEntryId: "newer" })
    expect(candidates[0]!.pairKey).toBe(semanticDuplicatePairKey("older", "newer"))
    expect(candidates[0]!.similarity).toBeGreaterThanOrEqual(0.42)
  })

  it("超出 48 小时窗口不产生候选，无关标题也不产生候选", () => {
    expect(
      getSemanticDuplicateCandidates([
        entry("older", "OpenAI 发布 GPT-6 模型", at(0)),
        entry("newer", "OpenAI 发布 GPT-6 模型", at(49)),
      ]),
    ).toEqual([])
    expect(
      getSemanticDuplicateCandidates([
        entry("left", "英伟达公布季度财报", at(0)),
        entry("right", "某地马拉松赛事报名开始", at(2)),
      ]),
    ).toEqual([])
  })

  it("时间不可解析的条目不参与比较", () => {
    expect(
      getSemanticDuplicateCandidates([
        entry("broken", "OpenAI 发布 GPT-6 模型", "not-a-timestamp"),
        entry("other", "OpenAI 发布 GPT-6 模型", at(1)),
      ]),
    ).toEqual([])
  })

  it("已判定的对与两侧都已扫完的条目不重复预筛", () => {
    const entries = [
      entry("older", "OpenAI 发布 GPT-6 模型", at(0)),
      entry("newer", "OpenAI 发布 GPT-6 模型（更新）", at(6)),
    ]
    expect(
      getSemanticDuplicateCandidates(entries, {
        decidedPairKeys: new Set([semanticDuplicatePairKey("older", "newer")]),
      }),
    ).toEqual([])
    expect(
      getSemanticDuplicateCandidates(entries, { settledItemIds: new Set(["older", "newer"]) }),
    ).toEqual([])
    // 只有一侧扫完时仍要比较：新条目必须能和旧条目对上。
    expect(
      getSemanticDuplicateCandidates(entries, { settledItemIds: new Set(["older"]) }),
    ).toHaveLength(1)
  })

  it("候选数量受上限约束，且同一待判条目只占用一个名额", () => {
    const entries = [
      entry("dup-a", "OpenAI 发布 GPT-6 模型", at(0)),
      entry("dup-b", "OpenAI 发布 GPT-6 模型（更新）", at(1)),
      entry("dup-c", "OpenAI 发布 GPT-6 模型（再版）", at(2)),
      ...Array.from({ length: 20 }, (_, index) =>
        entry(`filler-${index}`, `OpenAI 发布 GPT-6 模型 ${index}`, at(3 + index)),
      ),
    ]
    const candidates = getSemanticDuplicateCandidates(entries)
    expect(candidates.length).toBeLessThanOrEqual(MAX_SEMANTIC_DUPLICATE_CANDIDATES)
    expect(new Set(candidates.map((candidate) => candidate.testEntryId)).size).toBe(
      candidates.length,
    )
  })
})

describe("语义去重判定归一化", () => {
  const candidates: SemanticDuplicateCandidate[] = [
    {
      entries: [
        entry("newer", "OpenAI 发布 GPT-6 模型（更新）", at(6)),
        entry("older", "OpenAI 发布 GPT-6 模型", at(0)),
      ],
      keepEntryId: "older",
      pairKey: semanticDuplicatePairKey("older", "newer"),
      similarity: 0.9,
      testEntryId: "newer",
    },
  ]
  const aiConfig = { model: "test-model", provider: "qianwen" as const, apiKey: "key" }

  it("模型在同一对上同时要求保留和隐藏同一条时按未去重处理", async () => {
    const execute = vi.fn(async () => ({
      durationMs: 5,
      model: "test-model",
      result: {
        results: [
          {
            confidence: 0.91,
            duplicate: true,
            hideEntryId: "older",
            keepEntryId: "older",
            pairKey: candidates[0]!.pairKey,
            reason: "同一事件",
          },
        ],
      },
      toolCalls: 0,
      usage: null,
    }))
    const run = await evaluateSemanticDuplicateCandidates({
      aiConfig,
      candidates,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
    })
    expect(run.evaluations).toHaveLength(1)
    expect(run.evaluations[0]).toMatchObject({ duplicate: false, hideEntryId: null })
  })

  it("模型给出的条目不属于这一对时回落到候选默认方向", async () => {
    const execute = vi.fn(async () => ({
      durationMs: 5,
      model: "test-model",
      result: {
        results: [
          {
            confidence: 0.9,
            duplicate: true,
            hideEntryId: "陌生条目",
            keepEntryId: "陌生条目",
            pairKey: candidates[0]!.pairKey,
            reason: "同一事件",
          },
        ],
      },
      toolCalls: 0,
      usage: null,
    }))
    const run = await evaluateSemanticDuplicateCandidates({
      aiConfig,
      candidates,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
    })
    expect(run.evaluations[0]).toMatchObject({
      duplicate: true,
      hideEntryId: "newer",
      keepEntryId: "older",
    })
  })

  it("模型漏答的候选写入否定判定，避免下一轮重复付费", async () => {
    const execute = vi.fn(async () => ({
      durationMs: 5,
      model: "test-model",
      result: { results: [] },
      toolCalls: 0,
      usage: null,
    }))
    const run = await evaluateSemanticDuplicateCandidates({
      aiConfig,
      candidates,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
    })
    expect(run.evaluations).toEqual([
      {
        confidence: 0,
        duplicate: false,
        hideEntryId: null,
        keepEntryId: null,
        pairKey: candidates[0]!.pairKey,
        reason: "模型未返回该候选的判定。",
      },
    ])
  })

  it("提示词包含候选并要求保守判定", () => {
    const prompt = createSemanticDuplicatePrompt(candidates)
    expect(prompt).toContain(candidates[0]!.pairKey)
    expect(prompt).toContain("OpenAI 发布 GPT-6 模型")
    expect(prompt).toContain("保守优先")
  })
})

describe("摘要与文本归一化", () => {
  it("描述截断到 400 字并折叠空白", () => {
    const description = `  第一行\n\n${"字".repeat(500)}  `
    const truncated = truncateDedupeDescription(description)
    expect(truncated.startsWith("第一行 字")).toBe(true)
    expect(truncated.length).toBe(400)
  })

  it("标题归一化与客户端一致：去标点、折叠空白、转小写", () => {
    expect(normalizeDedupeText("OpenAI，发布 GPT-6！")).toBe("openai 发布 gpt 6")
    expect(normalizeDedupeText("   ")).toBeNull()
  })
})
