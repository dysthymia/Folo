import { describe, expect, it, vi } from "vitest"

import type { CodexJsonOptions } from "./codex"
import type { SemanticDuplicateCandidate, SemanticDuplicateEntry } from "./semantic-dedupe"
import {
  createSemanticDuplicatePrompt,
  dedupeContentEvidence,
  evaluateSemanticDuplicateCandidates,
  getSemanticDuplicateCandidates,
  MAX_DEDUPE_CONTENT_LENGTH,
  MAX_SEMANTIC_DUPLICATE_CANDIDATES,
  normalizeDedupeText,
  semanticDuplicateOutputSchema,
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
    content: `${title} 完整正文`,
    contentComplete: true,
    itemId,
    publishedAt,
    sourceTitle: "来源",
    title,
    urlHost: "example.test",
  }
}

const base = Date.parse("2026-01-10T00:00:00.000Z")
const at = (hours: number) => new Date(base + hours * 60 * 60 * 1000).toISOString()

it("推理强度语义去重沿用私有配置，外部模型仍维持low", async () => {
  const candidates = getSemanticDuplicateCandidates([
    entry("older", "同一事件正式发布", at(0)),
    entry("newer", "同一事件正式发布", at(1)),
  ])
  const efforts: Array<string | undefined> = []
  const execute = async <T>(request: CodexJsonOptions<T>) => {
    efforts.push(request.reasoningEffort)
    const result: unknown = {
      results: candidates.map((candidate) => ({
        pairKey: candidate.pairKey,
        duplicate: false,
        factComparison: { verdict: "different", onlyInFirst: [], onlyInSecond: [] },
        keepEntryId: candidate.keepEntryId,
        hideEntryId: null,
        confidence: 0.9,
        reason: "保留增量",
      })),
    }
    if (!request.validate(result)) throw new Error("invalid_test_result")
    return { result, model: request.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
  for (const aiConfig of [
    { provider: "codex" as const, model: "test", reasoningEffort: "high" as const },
    { provider: "qianwen" as const, model: "test", apiKey: "fake" },
  ])
    await evaluateSemanticDuplicateCandidates({
      candidates,
      aiConfig,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
      execute,
    })
  expect(efforts).toEqual(["high", "low"])
})

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
            factComparison: { verdict: "equivalent", onlyInFirst: [], onlyInSecond: [] },
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
            factComparison: { verdict: "equivalent", onlyInFirst: [], onlyInSecond: [] },
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

  // 比较结论独立于模型的布尔值：未证明单向覆盖或证据矛盾时均不能隐藏。
  it.each([
    { verdict: "different", onlyInFirst: ["通过投票后再执行第二阶段。"], onlyInSecond: [] },
    { verdict: "different", onlyInFirst: [], onlyInSecond: ["只有完成资格审核的用户可申请。"] },
    { verdict: "uncertain", onlyInFirst: [], onlyInSecond: [] },
    { verdict: "equivalent", onlyInFirst: [], onlyInSecond: ["正式执行日改为下周。"] },
    { verdict: "first_contains_second", onlyInFirst: [], onlyInSecond: ["另一侧独有条件。"] },
    { verdict: "second_contains_first", onlyInFirst: ["另一侧独有条件。"], onlyInSecond: [] },
    { verdict: "first_contains_second", onlyInFirst: [], onlyInSecond: [] },
    {
      verdict: "second_contains_first",
      onlyInFirst: ["第一条补充执行时间。"],
      onlyInSecond: ["第二条补充申请条件。"],
    },
  ] as const)("有信息差或不确定时否决正向判重：%j", async (factComparison) => {
    const result = {
      results: [
        {
          pairKey: candidates[0]!.pairKey,
          factComparison,
          duplicate: true,
          confidence: 0.99,
          keepEntryId: "older",
          hideEntryId: "newer",
          reason: "同一事件的更完整报道",
        },
      ],
    }
    const execute = vi.fn(async () => ({ result, durationMs: 1, usage: null, toolCalls: 0 }))
    const run = await evaluateSemanticDuplicateCandidates({
      aiConfig,
      candidates,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
    })
    expect(run.evaluations[0]).toMatchObject({
      duplicate: false,
      hideEntryId: null,
      keepEntryId: null,
    })
    expect(run.evaluations[0]!.reason).toContain("保留原文")
    for (const quote of [...factComparison.onlyInFirst, ...factComparison.onlyInSecond])
      expect(run.evaluations[0]!.reason).toContain(quote)
  })

  it.each([
    {
      verdict: "first_contains_second",
      onlyInFirst: ["通过投票后再执行第二阶段。"],
      onlyInSecond: [],
      keep: "newer",
      hide: "older",
    },
    {
      verdict: "second_contains_first",
      onlyInFirst: [],
      onlyInSecond: ["只有完成资格审核的用户可申请。"],
      keep: "older",
      hide: "newer",
    },
  ] as const)("单向完整包含始终保留完整篇：$verdict", async (comparison) => {
    // 故意让模型选反保留方向，归一化仍必须按事实覆盖关系保留完整篇。
    const result = {
      results: [
        {
          pairKey: candidates[0]!.pairKey,
          factComparison: {
            verdict: comparison.verdict,
            onlyInFirst: comparison.onlyInFirst,
            onlyInSecond: comparison.onlyInSecond,
          },
          duplicate: true,
          confidence: 0.99,
          keepEntryId: comparison.hide,
          hideEntryId: comparison.keep,
          reason: "完整报道覆盖简版全部信息",
        },
      ],
    }
    const execute = vi.fn(async () => ({ result, durationMs: 1, usage: null, toolCalls: 0 }))
    const run = await evaluateSemanticDuplicateCandidates({
      aiConfig,
      candidates,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
    })
    expect(run.evaluations[0]).toMatchObject({
      duplicate: true,
      keepEntryId: comparison.keep,
      hideEntryId: comparison.hide,
    })
    expect(run.evaluations[0]!.reason).toContain("覆盖另一条的全部信息")
  })

  it("结构化输出必须包含逐侧事实比较，不能只提交重复布尔值", () => {
    expect(
      semanticDuplicateOutputSchema.safeParse({
        results: [
          {
            pairKey: candidates[0]!.pairKey,
            duplicate: true,
            confidence: 0.99,
            keepEntryId: "older",
            hideEntryId: "newer",
            reason: "同一事件",
          },
        ],
      }).success,
    ).toBe(false)
  })

  it("缺失或超限正文不能仅凭同标题摘要请求模型或隐藏原文", async () => {
    const execute = vi.fn()
    for (const content of [null, "", "文".repeat(MAX_DEDUPE_CONTENT_LENGTH + 1)]) {
      const unsafe = {
        ...candidates[0]!,
        entries: candidates[0]!.entries.map((entry) => ({
          ...entry,
          ...dedupeContentEvidence(content),
        })) as [SemanticDuplicateEntry, SemanticDuplicateEntry],
      }
      const run = await evaluateSemanticDuplicateCandidates({
        aiConfig,
        candidates: [unsafe],
        execute: execute as never,
        runtimeDir: "/unused",
        signal: new AbortController().signal,
      })
      expect(run).toMatchObject({
        executed: false,
        evaluations: [{ duplicate: false, confidence: 0 }],
      })
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it("完整正文证据保留尾部新进展和独立观点，并约束同事实转载判定", () => {
    const evidence = dedupeContentEvidence("旧报道背景。最后补充：新进展、独立观点和不同结论。")
    const prompt = createSemanticDuplicatePrompt([
      {
        ...candidates[0]!,
        entries: candidates[0]!.entries.map((entry) => ({ ...entry, ...evidence })) as [
          SemanticDuplicateEntry,
          SemanticDuplicateEntry,
        ],
      },
    ])
    expect(evidence.contentComplete).toBe(true)
    expect(prompt).toContain("最后补充：新进展、独立观点和不同结论。")
    expect(prompt).toContain("同一组事实的转载")
    expect(prompt).toContain("独立观点")
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
