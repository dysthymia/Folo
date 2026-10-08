import { z } from "zod"

// 关注清单完全来自用户配置，别名也必须显式输入；空清单不会推测用户持仓。
export const attentionSettingsSchema = z
  .object({
    enabled: z.boolean(),
    watchlist: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            name: z.string().trim().min(1).max(100),
            aliases: z.array(z.string().trim().min(1).max(100)).max(20),
          })
          .strict(),
      )
      .max(100)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
        message: "duplicate_watch_id",
      }),
    nearDeadlineHours: z.number().int().min(1).max(168).optional(),
  })
  .strict()
export type AttentionSettings = z.infer<typeof attentionSettingsSchema>
export const attentionDeadlineSchema = z
  .object({
    status: z.enum(["known", "unknown"]),
    at: z.iso.datetime({ offset: true }).nullable(),
    text: z.string(),
    evidenceId: z.string(),
    reason: z.string(),
  })
  .strict()
export const entryAttentionSchema = z
  .object({
    level: z.enum(["none", "important", "urgent"]),
    reasons: z.array(z.string()),
    matchedWatchIds: z.array(z.string()),
    deadlines: z.array(attentionDeadlineSchema),
  })
  .strict()
export type EntryAttention = z.infer<typeof entryAttentionSchema>
// 各覆盖范围独立保留，旧记录的混合coverage不能反向猜成缺少材料。
export const contributionAssessmentSchema = z
  .object({
    state: z.enum(["present", "absent", "unknown"]),
    confidence: z.number().min(0).max(1).nullable(),
    reason: z.string(),
    evidenceIds: z.array(z.string()),
  })
  .strict()

export const entryProcessingSignalsSchema = z.object({
  attention: entryAttentionSchema.optional(),
  pendingPolicyFields: z.array(z.enum(["standalone", "aggregation", "rewrite"])).optional(),
  materialCoverage: z.enum(["complete", "partial"]).optional(),
  semanticAssessmentCoverage: z.enum(["complete", "partial"]).optional(),
  contribution: contributionAssessmentSchema.optional(),
})
export type EntryProcessingSignals = z.infer<typeof entryProcessingSignalsSchema>
