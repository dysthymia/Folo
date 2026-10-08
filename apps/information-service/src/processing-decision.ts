import type {
  PresentationPolicy,
  RuleInput,
  SemanticEntity,
  TagAssessment,
} from "@follow/information-core"
import { semanticEntitiesSchema, tagAssessmentSchema } from "@follow/information-core"
import { z } from "zod"

import type { AIProvider } from "./ai-config"
import type { ProcessingInput } from "./automation-store"
import {
  eventIdentitySchema,
  eventSelectionForCatalog,
  eventSelectionSchema,
} from "./processing-event"
import {
  eventMentionsSchema,
  eventMentionsSelectionForCatalog,
  eventMentionsSelectionSchema,
  validateEventMentionRelationship,
  validateFactEventAssignments,
} from "./processing-event-mentions"
import type { EvidenceCatalog } from "./processing-evidence"
import { evidenceFactSelectionSchema, evidenceFactsSelectionSchema } from "./processing-evidence"
import { semanticEntitiesForCatalog } from "./processing-semantic-entities"
import {
  createTagAssessmentsSelectionSchema,
  substantiveContributionForCatalog,
  substantiveContributionSchema,
} from "./processing-semantic-prompt"

// 模型只能建议语义结论，最终展示/综合/改写资格仍由显式规则和缺失材料保护决定。
const entryModelBaseSchema = z.object({
  entryId: z.string().min(1),
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(12000),
  disposition: z.enum(["keep", "hide", "needs_context"]),
  reason: z.string().min(1).max(2000),
  aggregation: z.boolean(),
  rewrite: z.boolean(),
  labels: z.array(z.string().min(1).max(80)).max(20),
})
// 旧结果保持兼容；正式语义请求在动态 schema 中要求完整、受限的标签判断。
const persistedTagAssessments = z.array(tagAssessmentSchema).max(100).optional()
export const entryModelOutputSchema = entryModelBaseSchema
  .extend({
    tagAssessments: persistedTagAssessments,
    substantiveContribution: substantiveContributionSchema.optional(),
    materialCoverage: z.enum(["complete", "partial"]).optional(),
    entities: semanticEntitiesSchema.optional(),
    eventMentions: eventMentionsSchema.optional(),
    event: eventIdentitySchema.nullable().optional(),
    facts: z
      .array(
        z
          .object({
            text: z.string().min(1).max(2000),
            quote: z.string().min(1).max(4000),
            kind: z.enum(["fact", "source_claim", "inference"]),
            eventMentionIndex: z.number().int().min(0).max(3).nullable().optional(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict()
  .refine(validateEventMentionRelationship, { message: "inconsistent_primary_event" })
  .refine((value) => validateFactEventAssignments(value), {
    message: "invalid_fact_event_assignment",
  })
export type EntryModelOutput = z.infer<typeof entryModelOutputSchema>

export function applyEntryDisplay(
  output: EntryModelOutput,
  display: { summaryMaxGraphemes?: number },
): EntryModelOutput {
  if (!display.summaryMaxGraphemes) return output
  // 展示长度由程序执行，按 grapheme 截断不切开 emoji；事实和原文引用不受影响。
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(output.summary),
  ]
  if (segments.length <= display.summaryMaxGraphemes) return output
  return {
    ...output,
    summary: segments
      .slice(0, display.summaryMaxGraphemes)
      .map((item) => item.segment)
      .join(""),
  }
}
// 模型只选择证据编号；持久化前由服务端还原为上面的既有 quote 结构。
export const entryModelSelectionSchema = entryModelBaseSchema
  .extend({
    tagAssessments: persistedTagAssessments,
    substantiveContribution: substantiveContributionSchema.optional(),
    materialCoverage: z.enum(["complete", "partial"]).optional(),
    entities: semanticEntitiesSchema.optional(),
    eventMentions: eventMentionsSelectionSchema.optional(),
    event: eventSelectionSchema.nullable(),
    facts: z.array(evidenceFactSelectionSchema).max(30),
  })
  .strict()
  .refine(validateEventMentionRelationship, { message: "inconsistent_primary_event" })
export type EntryModelSelection = z.infer<typeof entryModelSelectionSchema>

// 请求级 schema 同时约束当前条目与当前证据目录；静态 schema 继续负责通用类型和持久化边界。
export function createEntryModelSelectionSchema(
  entryId: string,
  catalog: EvidenceCatalog,
  requiredTagIds: readonly string[] = [],
) {
  const base = entryModelBaseSchema
    .extend({
      entryId: z.enum([entryId]),
      event: eventSelectionForCatalog(catalog),
      facts: evidenceFactsSelectionSchema(catalog, 30, requiredTagIds.length > 0),
    })
    .strict()
  return requiredTagIds.length
    ? base
        .extend({
          tagAssessments: createTagAssessmentsSelectionSchema(catalog, requiredTagIds),
          substantiveContribution: substantiveContributionForCatalog(catalog),
          materialCoverage: z.enum(["complete", "partial"]),
          entities: semanticEntitiesForCatalog(catalog),
          eventMentions: eventMentionsSelectionForCatalog(catalog),
        })
        .refine(validateEventMentionRelationship, { message: "inconsistent_primary_event" })
        .refine((value) => validateFactEventAssignments(value, catalog), {
          message: "invalid_fact_event_assignment",
        })
    : base
}
export type EntrySemanticProfile = {
  schemaVersion: 2
  contentVersion: string
  materialDigest: string
  definitionDigest: string
  assessedTagIds: string[]
  assessments: TagAssessment[]
  // 旧档案未提取实体；只有真实完成提取的结果才标记协议版本。
  entityVersion?: number
  entities?: SemanticEntity[]
  evidence: Record<string, string>
  // coverage 保留旧合并含义；新字段区分原文缺失与标签结论待定。
  coverage: "complete" | "partial"
  materialCoverage?: "complete" | "partial"
  semanticAssessmentCoverage?: "complete" | "partial"
  substantiveContribution?: EntryModelOutput["substantiveContribution"]
}
export type ProcessingDecision = {
  schemaVersion: 1 | 2
  fingerprint: string
  // 专用变换保留基础语义缓存地址，人工纠错可从原始结果重新投影。
  analysisFingerprint?: string
  // 定向修复保留原决定与原因，便于追踪异常候选的恢复来源。
  repair?: { sourceDecisionId: string; reason: string }
  provider: AIProvider
  model: string
  generatedAt: string
  durationMs: number
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null
  status: "keep" | "hide" | "needs_context"
  title: string
  summary: string
  reason: string
  labels: string[]
  policy: Required<PresentationPolicy>
  // 规则待定不意味着材料缺失；原文保持可读，并独立说明尚未决定的策略字段。
  pendingPolicyFields?: Array<keyof PresentationPolicy>
  sourceRole: string
  context: RuleInput
  facts: EntryModelOutput["facts"]
  semantic: EntryModelOutput | null
  semanticProfile?: EntrySemanticProfile
  reused: boolean
}
export type PublishedDecision = {
  input: ProcessingInput
  decisionId: string
  decision: ProcessingDecision
}
