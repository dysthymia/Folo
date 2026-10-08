import { createHash } from "node:crypto"

import type { RuleInput, RuleSet, TagAssessment } from "@follow/information-core"
import { compileInstructions } from "@follow/information-core"

import type { CodexUsage } from "./codex"
import type { EntryModelOutput, ProcessingDecision } from "./processing-decision"
import { entryModelOutputSchema } from "./processing-decision"
import type { Store } from "./store"

type Instructions = ReturnType<typeof compileInstructions>
export type SemanticTransformOptions = {
  store: { processingState: Pick<Store["processingState"], "cache" | "saveCache"> }
  config: RuleSet
  context: RuleInput
  assessments: readonly TagAssessment[]
  instructions: Instructions
  // 始终传入基础语义缓存的决定，人工纠错后的重算不叠加之前的变换结果。
  decision: ProcessingDecision
  runModel: (instructions: Instructions) => Promise<{
    output: EntryModelOutput
    usage: CodexUsage | null
    durationMs: number
  }>
}
export type SemanticTransformResult = {
  decision: ProcessingDecision
  usage: CodexUsage | null
  modelCalled: boolean
}

// 只比较实际有序提示，规则版本和展示动作的变化不能制造新的模型调用。
function actualTransformations(instructions: Instructions) {
  return instructions.transformations.map((item) => item.prompt)
}

// 基础标签完成后才匹配语义条件；未知标签不会被编译成命中的变换。
export async function applySemanticTransforms(
  options: SemanticTransformOptions,
): Promise<SemanticTransformResult> {
  const { decision } = options
  const instructions = compileInstructions(options.config, {
    ...options.context,
    entry_tag: [...options.assessments],
  })
  const prompts = actualTransformations(instructions)
  if (
    !decision.semantic ||
    !prompts.length ||
    JSON.stringify(prompts) === JSON.stringify(actualTransformations(options.instructions))
  )
    return { decision, usage: null, modelCalled: false }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: "semantic-transform-v1",
        // 基础指纹绑定原文、模型和真实分析指令；阅读策略、展示长度不进入次级身份。
        baseFingerprint: decision.analysisFingerprint ?? decision.fingerprint,
        global: instructions.global,
        prompts,
        assessments: options.assessments,
        definitionDigest: decision.semanticProfile?.definitionDigest,
      }),
    )
    .digest("hex")
  const cached = options.store.processingState.cache(fingerprint)
  const parsed =
    cached?.fingerprint === fingerprint ? entryModelOutputSchema.safeParse(cached.semantic) : null
  if (parsed?.success) {
    return {
      decision: transformedDecision(decision, parsed.data, fingerprint, 0, null, true),
      usage: null,
      modelCalled: false,
    }
  }

  const response = await options.runModel(instructions)
  const output = entryModelOutputSchema.parse(response.output)
  if (output.entryId !== decision.semantic.entryId) throw new Error("invalid_model_reference")
  const transformed = transformedDecision(
    decision,
    output,
    fingerprint,
    response.durationMs,
    response.usage,
    false,
  )
  // 次级缓存只记本阶段调用成本，复用时基础阶段的成本由当前基础决定独立携带。
  options.store.processingState.saveCache({
    ...transformed,
    durationMs: response.durationMs,
    usage: response.usage,
  })
  return { decision: transformed, usage: response.usage, modelCalled: true }
}

// 只接收第二阶段的呈现与事实；标签、原始语义档案和条目版本绑定始终来自基础结果。
function transformedDecision(
  base: ProcessingDecision,
  output: EntryModelOutput,
  fingerprint: string,
  durationMs: number,
  usage: CodexUsage | null,
  reused: boolean,
): ProcessingDecision {
  if (!base.semantic) throw new Error("missing_base_semantics")
  const semantic = {
    ...output,
    entryId: base.semantic.entryId,
    tagAssessments: base.semantic.tagAssessments,
    // 专用摘要提示不改变基础事件归属；两种表示保持同一不可变身份和提及。
    event: base.semantic.event,
    eventMentions: base.semantic.eventMentions,
  }
  return {
    ...base,
    fingerprint,
    analysisFingerprint: base.analysisFingerprint ?? base.fingerprint,
    generatedAt: reused ? base.generatedAt : new Date().toISOString(),
    durationMs: base.durationMs + durationMs,
    usage: combineUsage(base.usage, usage),
    title: semantic.title,
    summary: semantic.summary,
    reason: semantic.reason,
    labels: semantic.labels,
    facts: semantic.facts,
    semantic,
    semanticProfile: base.semanticProfile,
    reused,
  }
}

function combineUsage(base: CodexUsage | null, extra: CodexUsage | null): CodexUsage | null {
  if (!base && !extra) return null
  return {
    inputTokens: (base?.inputTokens ?? 0) + (extra?.inputTokens ?? 0),
    outputTokens: (base?.outputTokens ?? 0) + (extra?.outputTokens ?? 0),
    cachedInputTokens: (base?.cachedInputTokens ?? 0) + (extra?.cachedInputTokens ?? 0),
  }
}
