import type { PresentationPolicy, RuleInput } from "@follow/information-core"
import { z } from "zod"

import type { ProcessingInput } from "./automation-store"
import type { EvidenceCatalog } from "./processing-evidence"
import { evidenceFactSelectionSchema, evidenceFactsSelectionSchema } from "./processing-evidence"

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
export const entryModelOutputSchema = entryModelBaseSchema
  .extend({
    facts: z
      .array(
        z
          .object({
            text: z.string().min(1).max(2000),
            quote: z.string().min(1).max(4000),
            kind: z.enum(["fact", "source_claim", "inference"]),
          })
          .strict(),
      )
      .max(30),
  })
  .strict()
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
  .extend({ facts: z.array(evidenceFactSelectionSchema).max(30) })
  .strict()
export type EntryModelSelection = z.infer<typeof entryModelSelectionSchema>

// 请求级 schema 同时约束当前条目与当前证据目录；静态 schema 继续负责通用类型和持久化边界。
export function createEntryModelSelectionSchema(entryId: string, catalog: EvidenceCatalog) {
  return entryModelBaseSchema
    .extend({
      entryId: z.enum([entryId]),
      facts: evidenceFactsSelectionSchema(catalog, 30),
    })
    .strict()
}
export type ProcessingDecision = {
  schemaVersion: 1
  fingerprint: string
  provider: "codex" | "qianwen"
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
  sourceRole: string
  context: RuleInput
  facts: EntryModelOutput["facts"]
  semantic: EntryModelOutput | null
  reused: boolean
}
export type PublishedDecision = {
  input: ProcessingInput
  decisionId: string
  decision: ProcessingDecision
}
