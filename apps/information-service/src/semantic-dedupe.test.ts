import { describe, expect, it, vi } from "vitest"

import type { CodexJsonOptions } from "./codex"
import { CodexRunError } from "./codex"
import type { SemanticDuplicateCandidate, SemanticDuplicateEntry } from "./semantic-dedupe"
import {
  createSemanticDuplicatePrompt,
  dedupeContentEvidence,
  evaluateSemanticDuplicateCandidates,
  getSemanticDuplicateCandidates,
  MAX_DEDUPE_CONTENT_LENGTH,
  MAX_SEMANTIC_DUPLICATE_CANDIDATES,
  normalizeDedupeText,
  normalizeSemanticDuplicateOutput,
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

it.each([0.1, 0.84, 0.85, 0.99])("否定结论也需要明确把握，置信度 %s", (confidence) => {
  // 低把握不冒充确定不同；阈值不代表测得的准确率，不触发无限补判。
  const candidates = getSemanticDuplicateCandidates([
    entry("A", "同一事件正式发布", at(0)),
    entry("B", "同一事件正式发布", at(1)),
  ])
  const candidate = candidates[0]!
  expect(
    normalizeSemanticDuplicateOutput(candidates, {
      results: [
        {
          pairKey: candidate.pairKey,
          duplicate: false,
          confidence,
          keepEntryId: null,
          hideEntryId: null,
          reason: "可能不同",
          factComparison: { verdict: "different", onlyInFirst: [], onlyInSecond: [] },
        },
      ],
    })[0],
  ).toMatchObject({ duplicate: false, status: confidence >= 0.85 ? "decided" : "uncertain" })
})

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
  it("倒排与逐条最优选择保持穷举结果，包括同分、重复身份、目标和已判过滤", () => {
    // 独立的穷举基准只用于小样本，防止优化通过漏召回改变结果。
    const grams = (text: string) => {
      const value = (normalizeDedupeText(text) ?? "").replaceAll(/\s+/g, "")
      return new Set(
        value.length <= 1
          ? value
            ? [value]
            : []
          : Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)),
      )
    }
    const dice = (a: string, b: string) => {
      const left = grams(a),
        right = grams(b)
      return left.size && right.size
        ? (2 * [...left].filter((gram) => right.has(gram)).length) / (left.size + right.size)
        : 0
    }
    const titles = [
      "活动第1轮开放报名",
      "活动第2轮开放报名",
      "Annual launch 2026",
      "Annual launch 2027",
      "不同分析观点",
      "",
      "短",
    ]
    const samples = Array.from({ length: 65 }, (_, i) => ({
      ...entry(
        `id-${i % 63}`,
        titles[i % titles.length]!,
        i === 0 ? "bad-time" : at(i % 57),
        i % 3 === 0 ? "活动截止条件及数字相同" : "",
      ),
      originalIdentity: `original-${i % 61}`,
    }))
    const decided = new Set([semanticDuplicatePairKey("id-13", "id-6")])
    const settled = new Set(["id-2", "id-9"])
    for (const targets of [undefined, new Set(["id-6", "id-9", "id-42"]), new Set<string>()]) {
      const ordered = samples
        .map((entry) => ({ entry, at: Date.parse(entry.publishedAt) }))
        .filter((item) => Number.isFinite(item.at))
        .sort((a, b) => b.at - a.at)
      const all: Array<SemanticDuplicateCandidate & { index: number; right: number }> = []
      for (let i = 0; i < ordered.length; i++)
        for (let j = i + 1; j < ordered.length; j++) {
          const left = ordered[i]!,
            right = ordered[j]!
          if (left.at - right.at > 48 * 60 * 60 * 1000) continue
          if (
            left.entry.itemId === right.entry.itemId ||
            left.entry.originalIdentity === right.entry.originalIdentity
          )
            continue
          if (targets && !targets.has(left.entry.itemId) && !targets.has(right.entry.itemId))
            continue
          const pairKey = semanticDuplicatePairKey(left.entry.itemId, right.entry.itemId)
          if (
            decided.has(pairKey) ||
            (settled.has(left.entry.itemId) && settled.has(right.entry.itemId))
          )
            continue
          const title = dice(left.entry.title, right.entry.title)
          const context = dice(
            `${left.entry.title} ${left.entry.description}`.trim(),
            `${right.entry.title} ${right.entry.description}`.trim(),
          )
          if (title < 0.42 && context < 0.32) continue
          all.push({
            index: i,
            right: j,
            pairKey,
            similarity: Math.max(title, context),
            keepEntryId: right.entry.itemId,
            testEntryId: left.entry.itemId,
            entries: [left.entry, right.entry],
          })
        }
      const seen = new Set<string>()
      const expected = all
        .sort((a, b) => a.index - b.index || b.similarity - a.similarity || a.right - b.right)
        .filter((pair) => {
          if (seen.has(pair.testEntryId)) return false
          seen.add(pair.testEntryId)
          return true
        })
        .map(({ index: _index, right: _right, ...pair }) => pair)
      for (const maxCandidates of [0, 1, 5, 25, 100])
        expect(
          getSemanticDuplicateCandidates(samples, {
            maxCandidates,
            targetItemIds: targets,
            decidedPairKeys: decided,
            settledItemIds: settled,
          }),
        ).toEqual(expected.slice(0, maxCandidates))
    }
  })

  it("同一条目和同一原帖跨订阅上下文都不生成自比较", () => {
    // 原文身份与订阅上下文分开；不同内容版本也不能把同一原帖当成两篇新闻。
    expect(
      getSemanticDuplicateCandidates([
        entry("same", "项目活动更新", at(0)),
        entry("same", "项目活动更新", at(1)),
      ]),
    ).toEqual([])
    expect(
      getSemanticDuplicateCandidates([
        { ...entry("feed-copy", "项目活动更新", at(0)), originalIdentity: "x:123" },
        { ...entry("list-copy", "项目活动更新", at(1)), originalIdentity: "x:123" },
      ]),
    ).toEqual([])
  })
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

  it("模型给出的条目不属于这一对时拒绝隐藏并保留异常状态", async () => {
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
      duplicate: false,
      hideEntryId: null,
      keepEntryId: null,
      status: "invalid_result",
    })
  })

  it("模型漏答明确标为缺失结果，不冒充已确认不同", async () => {
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
        status: "missing_result",
      },
    ])
  })

  it("共享与独立执行都拒绝重复回答，只影响异常候选并保留其他有效结论", async () => {
    // 同批的重复、缺失和未知配对不能覆盖另一个已核验的有效答案。
    const other: SemanticDuplicateCandidate = {
      ...candidates[0]!,
      pairKey: "other-new::other-old",
      keepEntryId: "other-old",
      testEntryId: "other-new",
      entries: [entry("other-new", "另一事件", at(1)), entry("other-old", "另一事件", at(0))],
    }
    const missing = { ...other, pairKey: "missing-new::missing-old" }
    const answer = (candidate: SemanticDuplicateCandidate, duplicate: boolean) => ({
      pairKey: candidate.pairKey,
      duplicate,
      confidence: 0.95,
      factComparison: {
        verdict: duplicate ? ("equivalent" as const) : ("different" as const),
        onlyInFirst: [],
        onlyInSecond: [],
      },
      keepEntryId: candidate.keepEntryId,
      hideEntryId: candidate.testEntryId,
      reason: "合成判定",
    })
    const result = {
      results: [
        answer(candidates[0]!, false),
        answer(candidates[0]!, true),
        answer(other, true),
        { ...answer(other, true), pairKey: "unknown-pair" },
      ],
    }
    expect(semanticDuplicateOutputSchema.safeParse(result).success).toBe(true)
    const batch = [...candidates, other, missing]
    const execute = vi.fn(async () => ({
      durationMs: 1,
      model: "test-model",
      result,
      toolCalls: 0,
      usage: null,
    }))
    const run = await evaluateSemanticDuplicateCandidates({
      aiConfig,
      candidates: batch,
      execute: execute as never,
      runtimeDir: "/unused",
      signal: new AbortController().signal,
    })
    expect(run.evaluations).toEqual(normalizeSemanticDuplicateOutput(batch, result))
    expect(run.evaluations).toMatchObject([
      { duplicate: false, status: "invalid_result" },
      { duplicate: true, status: "decided" },
      { duplicate: false, status: "missing_result" },
    ])
  })

  it("模型无法确认或置信不足时保留双方并标为待复核", () => {
    const answer = {
      pairKey: candidates[0]!.pairKey,
      duplicate: false,
      confidence: 0.9,
      factComparison: { verdict: "uncertain" as const, onlyInFirst: [], onlyInSecond: [] },
      keepEntryId: null,
      hideEntryId: null,
      reason: "无法证明覆盖",
    }
    expect(normalizeSemanticDuplicateOutput(candidates, { results: [answer] })[0]).toMatchObject({
      status: "uncertain",
      duplicate: false,
    })
    expect(
      normalizeSemanticDuplicateOutput(candidates, {
        results: [
          {
            ...answer,
            duplicate: true,
            confidence: 0.5,
            factComparison: { ...answer.factComparison, verdict: "equivalent" },
          },
        ],
      })[0],
    ).toMatchObject({ status: "uncertain", duplicate: false })
  })

  it.each(["MISSING_OUTPUT", "INVALID_OUTPUT"] as const)(
    "执行器%s也标为待补判并保留已测用量",
    async (code) => {
      // 格式校验失败不等于文章不同；错误里的原始内容不进入结果或缓存。
      const usage = { inputTokens: 12, outputTokens: 7, cachedInputTokens: 0 }
      const execute = vi.fn(async () => {
        throw new CodexRunError(code, usage)
      })
      const run = await evaluateSemanticDuplicateCandidates({
        aiConfig,
        candidates,
        execute,
        runtimeDir: "/unused",
        signal: new AbortController().signal,
      })
      expect(run).toMatchObject({
        executed: true,
        usage,
        evaluations: [
          {
            duplicate: false,
            status: code === "MISSING_OUTPUT" ? "missing_result" : "invalid_result",
          },
        ],
      })
      expect(execute).toHaveBeenCalledTimes(1)
    },
  )

  it("执行器取消不能被吞成普通去重结果", async () => {
    const error = new CodexRunError("ABORTED")
    const execute = vi.fn(async () => {
      throw error
    })
    await expect(
      evaluateSemanticDuplicateCandidates({
        aiConfig,
        candidates,
        execute,
        runtimeDir: "/unused",
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(error)
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

  it("同批多对共享正文只出现一次，配对身份和内容完整性不变", () => {
    const uniqueBody = "重复传输探针正文包含最后一个关键事实。"
    const anchor = { ...entry("anchor", "共同事件", at(0)), content: uniqueBody }
    const pairs = ["b", "c", "d"].map((id, i) => ({
      pairKey: semanticDuplicatePairKey("anchor", id),
      keepEntryId: "anchor",
      testEntryId: id,
      similarity: 1,
      entries: [entry(id, "共同事件", at(i + 1)), anchor] as [
        SemanticDuplicateEntry,
        SemanticDuplicateEntry,
      ],
    }))
    const prompt = createSemanticDuplicatePrompt(pairs)
    const data = JSON.parse(prompt.slice(prompt.indexOf("候选：") + "候选：".length))
    expect(data.documents).toHaveLength(4)
    expect(data.candidates).toHaveLength(3)
    expect(prompt.split(uniqueBody)).toHaveLength(2)
    expect(
      data.documents.find((document: SemanticDuplicateEntry) => document.itemId === "anchor")
        .content,
    ).toBe(uniqueBody)
    expect(
      data.candidates.every((pair: SemanticDuplicateCandidate) =>
        pair.entries.every((item) => !item.content),
      ),
    ).toBe(true)
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
