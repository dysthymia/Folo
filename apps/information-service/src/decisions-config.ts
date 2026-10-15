import type { AutomationRule, RuleInput, RuleSet } from "@follow/information-core"
import { matchConditions, ruleRequiresSemantics } from "@follow/information-core"
import { z } from "zod"

export const DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
export const DECISIONS_MODEL = "openai/gpt-6-luna-decisions"
export const DECISIONS_CANONICAL_MODEL = "openai/gpt-6-luna-decisions-20261006"
// Bump when prompts, protocol validation or application-side assessment mapping changes.
// 材料完整性与语义概率分开判定，旧版全未知缓存不能继续参与新投影。
export const DECISIONS_VERSION = 3

export const decisionsSettingsSchema = z
  .object({
    enabled: z.boolean(),
    classificationEnabled: z.boolean().default(true),
    mode: z.enum(["observe", "apply"]),
    // 允许用户把分类与去重的概率门槛设为 85%。
    threshold: z.number().finite().min(0.85).max(0.999),
    maxInputChars: z.number().int().min(500).max(60_000),
    maxRequestsPerRun: z.number().int().min(1).max(100),
  })
  .strict()
export const dedupeObservationSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["observe", "apply"]).optional(),
    maxPairsPerTrigger: z.number().int().min(1).max(24),
    // 只对已成功返回的低置信比较追加一次生成核验，默认仍保持纯 Decisions。
    generationFallback: z.boolean().optional(),
  })
  .strict()
export const defaultDedupeObservationSettings = {
  enabled: false,
  mode: "observe" as const,
  maxPairsPerTrigger: 8,
}
export const decisionsConfigSchema = decisionsSettingsSchema.extend({
  apiKey: z.string().trim().max(4096).optional(),
  dedupeObservation: dedupeObservationSettingsSchema.optional(),
})
export type DecisionsSettings = z.infer<typeof decisionsSettingsSchema>
export type DecisionsConfig = z.infer<typeof decisionsConfigSchema>
export const defaultDecisionsSettings: DecisionsSettings = {
  enabled: false,
  classificationEnabled: true,
  mode: "observe",
  threshold: 0.95,
  maxInputChars: 12_000,
  maxRequestsPerRun: 20,
}
export function publicDecisionsSettings(config?: DecisionsConfig) {
  return {
    ...decisionsSettingsSchema.parse(config ? omitKey(config) : defaultDecisionsSettings),
    hasApiKey: Boolean(config?.apiKey),
    dedupeObservation: config?.dedupeObservation
      ? { ...config.dedupeObservation, mode: config.dedupeObservation.mode ?? "observe" }
      : defaultDedupeObservationSettings,
    model: DECISIONS_MODEL,
    endpoint: DECISIONS_ENDPOINT,
  }
}
export function decisionsSettings(config: DecisionsConfig): DecisionsSettings {
  return decisionsSettingsSchema.parse(omitKey(config))
}
export function decisionsClassificationEnabled(
  settings?: Pick<DecisionsSettings, "enabled" | "classificationEnabled">,
): settings is Pick<DecisionsSettings, "enabled" | "classificationEnabled"> {
  return Boolean(settings?.enabled && settings.classificationEnabled !== false)
}
export function ruleUsesDecisions(
  rule: Pick<AutomationRule, "decisionModel">,
  settings?: Pick<DecisionsSettings, "enabled" | "classificationEnabled">,
) {
  return (
    rule.decisionModel === "decisions" ||
    (rule.decisionModel === undefined && decisionsClassificationEnabled(settings))
  )
}
export function semanticRulesForInput(config: RuleSet, context: RuleInput) {
  return config.rules.filter(
    (rule) =>
      rule.enabled &&
      ruleRequiresSemantics(rule) &&
      matchConditions(rule.when, { ...context, entry_tag: null, ruleTagAssessments: undefined })
        .state !== "no_match",
  )
}
export function allSemanticRulesUseDecisions(
  config: RuleSet,
  context: RuleInput,
  settings?: DecisionsSettings,
) {
  const rules = semanticRulesForInput(config, context)
  return rules.length > 0 && rules.every((rule) => ruleUsesDecisions(rule, settings))
}
export function dedupeDecisionsMode(
  config: DecisionsConfig | undefined,
  model?: AutomationRule["decisionModel"],
): "generation" | "observe" | "apply" {
  if (model === "generation") return "generation"
  if (model === "decisions") return "apply"
  return config?.enabled && config.dedupeObservation?.enabled
    ? (config.dedupeObservation.mode ?? "observe")
    : "generation"
}
export function decisionsDedupeEnabled(config?: DecisionsConfig) {
  return Boolean(
    config?.enabled &&
    config.dedupeObservation?.enabled &&
    config.dedupeObservation.mode === "apply",
  )
}
function omitKey({ apiKey: _key, dedupeObservation: _dedupe, ...settings }: DecisionsConfig) {
  return settings
}
