import { z } from "zod"

import { readingRequest } from "./processing-reader-client"
import { researchPackResponseSchema } from "./research-client"

export const researchSelectionEntrySchema = z
  .object({
    sourceKey: z.string().min(1),
    entryId: z.string().min(1),
    inputSeq: z.number().int().positive().optional(),
  })
  .strict()
export type ResearchSelectionEntry = z.infer<typeof researchSelectionEntrySchema>
export type ResearchSelectionRequest = {
  target: { kind: "selection"; entries: ResearchSelectionEntry[] }
  question: string
  goal: string
  knownQuestions: string[]
}

export const researchSelectionPreviewSchema = z
  .object({
    preview: z
      .object({
        selectionCount: z.number().int().nonnegative(),
        totalCharacters: z.number().int().nonnegative(),
        missingContext: z.array(
          z
            .object({ sourceKey: z.string(), entryId: z.string(), reasons: z.array(z.string()) })
            .strict(),
        ),
        estimatedModelCalls: z.number().int().min(0).max(2),
        canExecute: z.boolean(),
        materials: z.array(
          z
            .object({
              sourceKey: z.string(),
              entryId: z.string(),
              materialId: z.string().min(1),
              inputSeq: z.number().int().positive().optional(),
              title: z.string(),
              characters: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        selectionToken: z.string().min(1),
      })
      .strict(),
  })
  .strict()
export type ResearchSelectionPreview = z.infer<typeof researchSelectionPreviewSchema>["preview"]

// 只有用户显式执行才调用模型；预览不改变正式处理队列和原文读态。
export const previewResearchSelection = (input: ResearchSelectionRequest, signal: AbortSignal) =>
  readingRequest("research-selections/preview", researchSelectionPreviewSchema, signal, input)

export const runResearchSelection = (
  input: ResearchSelectionRequest & { selectionToken: string; idempotencyKey: string },
  signal: AbortSignal,
) => readingRequest("research-selections/run", researchPackResponseSchema, signal, input)

export const loadResearchSelection = (id: string, signal: AbortSignal) =>
  readingRequest(`research-packs/${encodeURIComponent(id)}`, researchPackResponseSchema, signal)
