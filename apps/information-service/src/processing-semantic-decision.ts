import { createHash } from "node:crypto"

import type { RuleInput, RuleSet, TagAssessment } from "@follow/information-core"
import {
  compileInstructions,
  SEMANTIC_ENTITY_VERSION,
  semanticEntitiesSchema,
  semanticTagDefinition,
} from "@follow/information-core"

import type {
  EntryModelOutput,
  EntrySemanticProfile,
  ProcessingDecision,
} from "./processing-decision"
import { applyEntryDisplay } from "./processing-decision"
import { entitiesHaveEvidence } from "./processing-semantic-entities"
import {
  protectWholeContentAssessments,
  semanticDefinitionsForIds,
} from "./processing-semantic-prompt"

export function semanticDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

// 模型只消费真正影响内容理解的指令，展示长度和隐藏动作由发布时重新求值。
export function semanticAnalysisInstructions(instructions: ReturnType<typeof compileInstructions>) {
  // 关注对象和注意力等级属于阅读投影，永远不进入模型指令与客观分析身份。
  const objective = {
    ...instructions,
    global: { version: 1, markdown: instructions.global.markdown },
  }
  if (!instructions.semanticTagIds.length) return objective
  return {
    ...objective,
    display: instructions.display.language ? { language: instructions.display.language } : {},
    policy: {},
    blocksFinalPresentation: false,
    pendingPolicyFields: [],
  }
}

export function createSemanticProfile(input: {
  contentVersion: string
  text: string
  output: EntryModelOutput
  evidence: Record<string, string>
  coverage?: "complete" | "partial"
}): EntrySemanticProfile | undefined {
  if (!input.output.tagAssessments?.length) return undefined
  const assessments = input.output.tagAssessments
  const entities =
    input.output.entities === undefined
      ? undefined
      : semanticEntitiesSchema.parse(input.output.entities)
  if (entities && !entitiesHaveEvidence(entities, (id) => input.evidence[id] ?? null))
    throw new Error("invalid_semantic_entity_evidence")
  if (input.output.substantiveContribution?.evidenceIds.some((id) => !input.evidence[id]))
    throw new Error("invalid_contribution_evidence")
  // 请求级校验已绑定定义/证据；不可变档案保存原文片段，后续缓存和纠错仍可追溯。
  return {
    schemaVersion: 2,
    contentVersion: input.contentVersion,
    materialDigest: semanticDigest(input.text),
    definitionDigest: semanticDigest(
      semanticDefinitionsForIds(assessments.map((item) => item.tagId)),
    ),
    assessedTagIds: assessments.map((item) => item.tagId),
    assessments,
    ...(entities === undefined ? {} : { entityVersion: SEMANTIC_ENTITY_VERSION, entities }),
    evidence: input.evidence,
    materialCoverage: input.coverage ?? input.output.materialCoverage ?? "complete",
    semanticAssessmentCoverage: assessments.some((item) => item.state === "unknown")
      ? "partial"
      : "complete",
    substantiveContribution: input.output.substantiveContribution,
    coverage:
      (input.coverage ?? input.output.materialCoverage) === "partial" ||
      assessments.some((item) => item.state === "unknown")
        ? "partial"
        : "complete",
  }
}

// 保存原始模型判断，人工语义覆盖单独存储；最终阅读决定可无模型重新生成。
export function projectSemanticDecision(
  decision: ProcessingDecision,
  config: RuleSet,
  context: RuleInput,
  assessments = decision.semanticProfile?.assessments ?? decision.semantic?.tagAssessments,
): ProcessingDecision {
  if (!decision.semantic || !assessments?.length) return decision
  const protectedAssessments = protectWholeContentAssessments(
    assessments,
    decision.semanticProfile?.substantiveContribution ?? decision.semantic.substantiveContribution,
  )
  const effectiveContext = { ...context, entry_tag: protectedAssessments }
  const instructions = compileInstructions(config, effectiveContext)
  const output = decision.semantic
  const pending = new Set(instructions.pendingPolicyFields)
  // 语义分类只产生客观标签；隐藏必须来自显式阅读规则或专用去重比较，全局语言指令不能授予隐藏权。
  const policy = {
    standalone: pending.has("standalone")
      ? ("always" as const)
      : (instructions.policy.standalone ?? ("auto" as const)),
    aggregation:
      pending.has("aggregation") || output.disposition === "needs_context"
        ? ("deny" as const)
        : (instructions.policy.aggregation ??
          (output.aggregation ? ("allow" as const) : ("deny" as const))),
    rewrite:
      pending.has("rewrite") ||
      output.disposition === "needs_context" ||
      (context.entry_content?.length ?? 0) > 60_000
        ? ("deny" as const)
        : (instructions.policy.rewrite ??
          (output.rewrite ? ("allow" as const) : ("deny" as const))),
  }
  const status =
    output.disposition === "needs_context"
      ? ("needs_context" as const)
      : policy.standalone === "always"
        ? ("keep" as const)
        : policy.standalone === "never"
          ? ("hide" as const)
          : ("keep" as const)
  const winnerId = instructions.resolvedBy.standalone
  const winner = config.rules.find((rule) => rule.id === winnerId)
  const reasons = assessments.filter((item) => item.state === "present").map((item) => item.reason)
  const display = applyEntryDisplay(output, instructions.display)
  return {
    ...decision,
    schemaVersion: 2,
    context: effectiveContext,
    status,
    policy,
    pendingPolicyFields: [...pending],
    summary: display.summary,
    reason: pending.size
      ? `阅读策略待定（${[...pending].join("、")}），原文保持可读：${
          protectedAssessments
            .filter((item) => item.state === "unknown" || (item.confidence ?? 0) < 0.8)
            .map((item) => item.reason)
            .join("；") || "标签置信度不足或条件尚未确认。"
        }`
      : winner
        ? `命中规则「${winner.name}」${reasons.length ? `：${reasons.join("；")}` : ""}`
        : output.reason,
    labels: [
      ...new Set([
        ...output.labels,
        ...assessments
          .filter((item) => item.state === "present")
          .map((item) => semanticTagDefinition(item.tagId)?.name ?? item.tagId),
      ]),
    ],
  }
}

export function effectiveSemanticAssessments(
  original: readonly TagAssessment[],
  changes: readonly { tagId: string; state: "present" | "absent" }[],
  contribution?: EntryModelOutput["substantiveContribution"],
): TagAssessment[] {
  // 定义变更后旧判断保留在原始档案中，但不能继续参与现行筛选或展示。
  const result = new Map(
    original.map((item) => {
      const definition = semanticTagDefinition(item.tagId)
      return [
        item.tagId,
        definition?.definitionVersion === item.definitionVersion
          ? item
          : {
              ...item,
              state: "unknown" as const,
              confidence: null,
              reason: "标签定义已变更，等待按当前定义重新评估。",
            },
      ]
    }),
  )
  for (const change of changes) {
    const definition = semanticTagDefinition(change.tagId)
    if (!definition) continue
    result.set(definition.id, {
      tagId: definition.id,
      definitionVersion: definition.definitionVersion,
      state: change.state,
      confidence: 1,
      reason: "用户明确纠正当前文章的标签判断。",
      evidenceIds: [],
    })
  }
  // 有效展示/索引与阅读策略共用冲突保护，原始模型档案仍保持不可变。
  return protectWholeContentAssessments([...result.values()], contribution)
}

// 仅新加载且获准处理的未读条目补齐缺失字段；空实体数组也是已完成提取。
export function semanticProfileNeedsAnalysis(
  profile: EntrySemanticProfile | null,
  tagIds: readonly string[],
) {
  return (
    tagIds.length > 0 &&
    (!profile ||
      profile.entityVersion !== SEMANTIC_ENTITY_VERSION ||
      !profile.entities ||
      tagIds.some((id) => {
        const assessment = profile.assessments.find((item) => item.tagId === id)
        return (
          !assessment ||
          assessment.definitionVersion !== semanticTagDefinition(id)?.definitionVersion
        )
      }))
  )
}
