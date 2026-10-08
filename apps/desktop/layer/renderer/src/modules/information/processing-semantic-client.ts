import {
  semanticEntitySchema,
  semanticTagDefinitionSchema,
  semanticTagIdSchema,
  tagAssessmentSchema,
} from "@follow/information-core"
import { z } from "zod"

import { readingRequest } from "./processing-reader-client"

export const semanticTagCatalogSchema = z.object({
  definitions: z.array(semanticTagDefinitionSchema),
})

// 读取本机服务的生效定义，避免界面内置副本与模型判断口径发生偏差。
export const loadSemanticTagCatalog = (signal: AbortSignal) =>
  readingRequest("processing/semantic-tags", semanticTagCatalogSchema, signal)

export const entrySemanticProfileSchema = z.object({
  schemaVersion: z.literal(2),
  contentVersion: z.string().min(1),
  materialDigest: z.string().min(1),
  definitionDigest: z.string().min(1),
  assessedTagIds: z.array(semanticTagIdSchema),
  assessments: z.array(tagAssessmentSchema),
  evidence: z.record(z.string(), z.string()),
  coverage: z.enum(["complete", "partial"]),
  // 旧画像没有实体字段，保留读取兼容，不把缺失字段解释为新识别结果。
  entityVersion: z.number().int().positive().optional(),
  entities: z.array(semanticEntitySchema).optional(),
})
export type EntrySemanticProfile = z.infer<typeof entrySemanticProfileSchema>

export const entrySemanticResponseSchema = z.object({
  profile: entrySemanticProfileSchema.nullable(),
  assessments: z.array(tagAssessmentSchema),
  overrideRevision: z.number().int().nonnegative(),
  decisionId: z.string().nullable(),
})
export type EntrySemanticResponse = z.infer<typeof entrySemanticResponseSchema>
export type SemanticOverrideState = "present" | "absent" | "automatic"

export const loadEntrySemantics = (inputSeq: number, signal: AbortSignal) =>
  readingRequest(`processing/entries/${inputSeq}/semantics`, entrySemanticResponseSchema, signal)

export const saveEntrySemanticOverride = (
  inputSeq: number,
  contentVersion: string,
  expectedRevision: number,
  tagId: z.infer<typeof semanticTagIdSchema>,
  state: SemanticOverrideState,
  signal: AbortSignal,
) =>
  // 纠错只写当前内容版本，并用修订号防止覆盖其他窗口的新判断。
  readingRequest(
    `processing/entries/${inputSeq}/semantic-overrides`,
    entrySemanticResponseSchema,
    signal,
    {
      expectedRevision,
      expectedContentVersion: contentVersion,
      requestId: crypto.randomUUID(),
      changes: [{ tagId, state }],
    },
  )
