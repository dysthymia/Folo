import type { AutomationRule, RuleInput, RuleSet, TagAssessment } from "@follow/information-core"
import { compileInstructions } from "@follow/information-core"
import { describe, expect, it, vi } from "vitest"

import type { EntryModelOutput, ProcessingDecision } from "./processing-decision"
import type { EventIdentity } from "./processing-event"
import { applySemanticTransforms } from "./processing-semantic-transform"

const context: RuleInput = { source_id: "feed/1", contextId: "feed/1" }
const assessment: TagAssessment = {
  tagId: "form:tutorial",
  definitionVersion: 1,
  state: "present",
  confidence: 0.99,
  reason: "原文含完整操作步骤",
  evidenceIds: ["E000001"],
}
const rule: AutomationRule = {
  id: "tutorial-transform",
  ownerId: "owner",
  name: "教程步骤",
  enabled: true,
  order: 1,
  when: {
    anyOf: [
      { allOf: [{ field: "entry_tag", operator: "contains_any", value: ["form:tutorial"] }] },
    ],
  },
  actions: [{ type: "ai_transform", prompt: "将教程总结为明确步骤" }],
  version: 1,
  executionLocation: "processing_service",
}
const config: RuleSet = {
  formatVersion: 5,
  ownerId: "owner",
  global: { version: 1, markdown: "忠于原文" },
  rules: [rule],
}
const output: EntryModelOutput = {
  entryId: "entry-1",
  title: "基础标题",
  summary: "基础摘要",
  disposition: "keep",
  reason: "有完整教程",
  aggregation: false,
  rewrite: true,
  labels: [],
  event: null,
  facts: [],
  tagAssessments: [assessment],
}
const decision: ProcessingDecision = {
  schemaVersion: 2,
  fingerprint: "base-semantic-fingerprint",
  provider: "codex",
  model: "test",
  generatedAt: "2026-10-06T00:00:00Z",
  durationMs: 10,
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
  status: "keep",
  title: output.title,
  summary: output.summary,
  reason: output.reason,
  labels: [],
  policy: { standalone: "auto", aggregation: "deny", rewrite: "allow" },
  sourceRole: "媒体",
  context,
  facts: [],
  semantic: output,
  reused: false,
  semanticProfile: {
    schemaVersion: 2,
    contentVersion: "entry-1-version",
    materialDigest: "material-digest",
    definitionDigest: "definition-digest",
    assessedTagIds: ["form:tutorial"],
    assessments: [assessment],
    evidence: { E000001: "完整教程原文" },
    coverage: "complete",
  },
}

function harness() {
  const cache = new Map<string, ProcessingDecision>()
  const store = {
    processingState: {
      cache: vi.fn((fingerprint: string) => cache.get(fingerprint) ?? null),
      saveCache: vi.fn((value: ProcessingDecision) => {
        cache.set(value.fingerprint, value)
      }),
    },
  }
  const runModel = vi.fn(async (_instructions: ReturnType<typeof compileInstructions>) => ({
    output: {
      ...output,
      title: "教程步骤标题",
      summary: "1. 按原文配置",
      tagAssessments: [{ ...assessment, state: "absent" as const }],
    },
    usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 2 },
    durationMs: 30,
  }))
  return {
    options: {
      store,
      config,
      context,
      assessments: [assessment],
      instructions: compileInstructions(config, context),
      decision,
      runModel,
    },
    cache,
  }
}

describe("基础语义之后的条件变换", () => {
  it("专用摘要和缓存中的新身份不覆盖基础事件与多提及", async () => {
    const { options } = harness()
    const quote = "Acme released Widget 2.0."
    const event: EventIdentity = {
      kind: "event",
      subject: { value: "Acme", quote },
      action: { value: "product_release", quote },
      object: { value: "Widget", quote },
      version: { value: "2.0", quote },
      round: null,
      anchor: null,
    }
    const base: ProcessingDecision = {
      ...decision,
      semantic: {
        ...output,
        event,
        eventMentions: [{ identity: event, role: "reports", isPrimary: true }],
      },
    }
    // 次级模型仍可返回自己的呈现结果，但归属必须始终来自不可变基础判断。
    const first = await applySemanticTransforms({ ...options, decision: base })
    const reused = await applySemanticTransforms({ ...options, decision: base })
    for (const result of [first, reused]) {
      expect(result.decision.semantic?.event).toBe(base.semantic!.event)
      expect(result.decision.semantic?.eventMentions).toBe(base.semantic!.eventMentions)
    }
    expect(options.runModel).toHaveBeenCalledOnce()
  })

  it("基础标签命中才执行第二阶段，保留可寻址的原始档案并独立记录阶段成本", async () => {
    const { options, cache } = harness()
    cache.set(decision.fingerprint, decision)
    const result = await applySemanticTransforms(options)
    expect(options.runModel).toHaveBeenCalledOnce()
    expect(options.runModel.mock.calls[0]?.[0]).toMatchObject({
      transformations: [{ prompt: "将教程总结为明确步骤" }],
    })
    expect(result).toMatchObject({
      modelCalled: true,
      usage: { inputTokens: 20 },
      decision: {
        title: "教程步骤标题",
        summary: "1. 按原文配置",
        durationMs: 40,
        usage: { inputTokens: 30, outputTokens: 13, cachedInputTokens: 2 },
      },
    })
    expect(result.decision.semanticProfile).toBe(decision.semanticProfile)
    expect(result.decision.semantic?.tagAssessments).toBe(decision.semantic?.tagAssessments)
    expect(options.store.processingState.saveCache).toHaveBeenCalledOnce()
    expect(result.decision.fingerprint).not.toBe(decision.fingerprint)
    expect(result.decision.analysisFingerprint).toBe(decision.fingerprint)
    const original = cache.get(result.decision.analysisFingerprint!)
    expect(original).toBe(decision)
    expect(original?.summary).toBe("基础摘要")
    expect(cache.get(result.decision.fingerprint)).toMatchObject({
      analysisFingerprint: decision.fingerprint,
      durationMs: 30,
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 2 },
    })
    const reused = await applySemanticTransforms(options)
    expect(reused).toMatchObject({
      modelCalled: false,
      usage: null,
      decision: {
        analysisFingerprint: decision.fingerprint,
        durationMs: 10,
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      },
    })
    expect(options.runModel).toHaveBeenCalledOnce()
  })

  it.each(["absent", "unknown"] as const)("%s 未命中变换时零调用，沿用基础结果", async (state) => {
    const { options } = harness()
    const result = await applySemanticTransforms({
      ...options,
      assessments: [{ ...assessment, state }],
    })
    expect(result).toEqual({ decision, modelCalled: false, usage: null })
    expect(options.runModel).not.toHaveBeenCalled()
    expect(options.store.processingState.cache).not.toHaveBeenCalled()
  })

  it("低置信度、旧定义版本和人工否定都不会执行未命中的变换", async () => {
    const { options } = harness()
    for (const effective of [
      { ...assessment, confidence: 0.1 },
      { ...assessment, definitionVersion: 999 },
      { ...assessment, state: "absent" as const },
    ])
      expect(
        (await applySemanticTransforms({ ...options, assessments: [effective] })).decision,
      ).toBe(decision)
    expect(options.runModel).not.toHaveBeenCalled()
  })

  it("实际变换与基础提示相同时零调用，元信息变更不影响该判断", async () => {
    const { options } = harness()
    const baseInstructions = compileInstructions(config, { ...context, entry_tag: [assessment] })
    const changed: RuleSet = { ...config, rules: [{ ...rule, version: 2, order: 3 }] }
    expect(
      await applySemanticTransforms({
        ...options,
        config: changed,
        instructions: baseInstructions,
      }),
    ).toEqual({ decision, modelCalled: false, usage: null })
    expect(options.runModel).not.toHaveBeenCalled()
  })

  it("阅读策略和摘要长度变更复用变换缓存，并重新绑定当前条目及原始档案", async () => {
    const { options } = harness()
    const first = await applySemanticTransforms(options)
    const next: ProcessingDecision = {
      ...decision,
      context: { ...context, contextId: "feed/2" },
      durationMs: 0,
      usage: null,
      reused: true,
      semantic: { ...output, entryId: "entry-2" },
      semanticProfile: { ...decision.semanticProfile!, contentVersion: "entry-2-version" },
    }
    const changed: RuleSet = {
      ...config,
      rules: [
        {
          ...rule,
          version: 2,
          actions: [
            ...rule.actions,
            { type: "reading_decision", visibility: "hide" },
            { type: "display", summaryMaxGraphemes: 2 },
          ],
        },
      ],
    }
    const second = await applySemanticTransforms({ ...options, config: changed, decision: next })
    expect(options.runModel).toHaveBeenCalledOnce()
    expect(second).toMatchObject({
      modelCalled: false,
      usage: null,
      decision: {
        fingerprint: first.decision.fingerprint,
        title: "教程步骤标题",
        semantic: { entryId: "entry-2" },
        durationMs: 0,
        usage: null,
      },
    })
    expect(second.decision.semanticProfile).toBe(next.semanticProfile)
    expect(second.decision.context).toBe(next.context)
    expect(second.decision.semantic?.tagAssessments).toBe(next.semantic?.tagAssessments)
    // 否定条件后传入基础缓存，之前的步骤摘要不能残留在重算结果里。
    const corrected = await applySemanticTransforms({
      ...options,
      decision: next,
      assessments: [{ ...assessment, state: "absent" }],
    })
    expect(corrected.decision.summary).toBe("基础摘要")
    expect(options.runModel).toHaveBeenCalledOnce()
  })

  it("真实变换提示、有效标签或基础语义改变使缓存失效", async () => {
    const { options } = harness()
    await applySemanticTransforms(options)
    await applySemanticTransforms({
      ...options,
      config: {
        ...config,
        rules: [{ ...rule, actions: [{ type: "ai_transform", prompt: "明确列出教程的先决条件" }] }],
      },
    })
    await applySemanticTransforms({
      ...options,
      assessments: [{ ...assessment, reason: "人工确认全部配置步骤" }],
    })
    await applySemanticTransforms({
      ...options,
      decision: { ...decision, fingerprint: "different-source-or-model" },
    })
    expect(options.runModel).toHaveBeenCalledTimes(4)
  })
})
