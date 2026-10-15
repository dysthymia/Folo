import type { RuleSet } from "@follow/information-core"
import { requiredSemanticTagIds } from "@follow/information-core"

import type { ProcessingInput } from "./automation-store"
import { contentIdentity } from "./content-identity"
import type { DecisionsConfig, DecisionsSettings } from "./decisions-config"
import {
  DECISIONS_CANONICAL_MODEL,
  DECISIONS_VERSION,
  decisionsSettings,
  ruleUsesDecisions,
  semanticRulesForInput,
} from "./decisions-config"
import type { requestDecisions } from "./openrouter-decisions"
import type { EntrySemanticProfile, ProcessingDecision } from "./processing-decision"
import type { DecisionsAudit } from "./processing-decisions"
import { classifyWithDecisions, decisionsOnlyEligible } from "./processing-decisions"
import { createSemanticProfile, semanticDigest } from "./processing-semantic-decision"
import {
  protectWholeContentAssessments,
  semanticDefinitionsForIds,
} from "./processing-semantic-prompt"
import type { ProcessingStateStore } from "./processing-state"

/** Keep executor-specific judgments immutable; merge only the public objective tag index. */
export async function attachRuleDecisions(input: {
  target: ProcessingInput
  decision: ProcessingDecision
  config: RuleSet
  settings: DecisionsSettings
  text: string
  signal: AbortSignal
  readConfig: () => Promise<DecisionsConfig | undefined>
  store: Pick<ProcessingStateStore, "cache" | "saveCache" | "recordDecisions">
  execute?: typeof requestDecisions
  budgetAllowed: () => boolean
  record: (audit: DecisionsAudit) => void
  // 未发起的预算延期留给下一批，不能发布为已经完成的未知分类。
  onDeferred?: () => void
}) {
  const rules = semanticRulesForInput(input.config, input.decision.context)
  if (!rules.some((rule) => rule.decisionModel !== undefined)) return input.decision
  const base = input.decision.semanticProfile
  if (!base) return input.decision
  const legacyEligible = decisionsOnlyEligible(input.config, input.decision.context)
  const routes = { ...input.settings, enabled: input.settings.enabled && legacyEligible }
  const selected = rules.filter((rule) => ruleUsesDecisions(rule, routes))
  const tagIds = requiredSemanticTagIds(
    { ...input.config, rules: selected },
    input.decision.context,
  )
  const settings = { ...decisionsSettings(input.settings), classificationEnabled: true }
  const fingerprint = semanticDigest({
    executor: "rule-decisions-v1",
    model: DECISIONS_CANONICAL_MODEL,
    version: DECISIONS_VERSION,
    settings,
    definitions: semanticDefinitionsForIds(tagIds),
    identity: contentIdentity(input.target.body),
    material: {
      title: input.target.body.title,
      html: input.target.body.content,
      originalContent: input.target.body.originalContent,
      imageCount: input.target.body.imageCount,
      mediaLength: input.target.body.mediaLength,
      attachmentsDuration: input.target.body.attachmentsDuration,
      context: input.target.body.context,
      linkedMaterials: input.target.body.linkedMaterials,
    },
    text: input.text,
  })
  let profile: EntrySemanticProfile | undefined
  let latest: DecisionsConfig | undefined
  if (selected.length) {
    if (input.decision.classification) profile = base
    else {
      const current = await input.readConfig()
      const allowed =
        current?.enabled &&
        current.apiKey &&
        JSON.stringify({ ...decisionsSettings(current), classificationEnabled: true }) ===
          JSON.stringify(settings)
      const cached = allowed ? input.store.cache(fingerprint) : null
      if (cached?.classification?.kind === "openrouter-decisions" && cached.semanticProfile) {
        profile = { ...cached.semanticProfile, contentVersion: input.target.contentVersion }
        input.record({
          inputSeq: input.target.seq,
          contentVersion: input.target.contentVersion,
          generation: input.target.generation,
          endpoint: "https://openrouter.ai/api/alpha/decisions",
          protocolVersion: DECISIONS_VERSION,
          mode: settings.mode,
          threshold: settings.threshold,
          tagIds,
          definitionVersions: Object.fromEntries(
            profile.assessments.map((item) => [item.tagId, item.definitionVersion]),
          ),
          ruleIds: selected.map((rule) => rule.id),
          fingerprint,
          createdAt: new Date().toISOString(),
          durationMs: 0,
          attempted: false,
          status: "success",
          code: "cache_hit",
          requestId: null,
          model: cached.classification.model,
          provider: "OpenAI",
          usage: null,
          answers: null,
        })
      } else {
        const response = await classifyWithDecisions({
          target: input.target,
          text: input.text,
          tagIds,
          settings,
          config: current ? { ...current, classificationEnabled: true } : undefined,
          signal: input.signal,
          execute: input.execute,
          budgetAllowed: input.budgetAllowed(),
          ruleIds: selected.map((rule) => rule.id),
          fingerprint,
          record: input.record,
        })
        if (response.audit.code === "run_limit") {
          input.onDeferred?.()
          return input.decision
        }
        profile = createSemanticProfile({
          contentVersion: input.target.contentVersion,
          text: input.text,
          output: response.output,
          evidence: response.evidence,
        })
        if (response.cacheable && profile)
          input.store.saveCache({
            ...input.decision,
            fingerprint,
            model: response.audit.model ?? DECISIONS_CANONICAL_MODEL,
            provider: "openai-compatible",
            durationMs: response.audit.durationMs,
            usage: response.audit.usage
              ? {
                  inputTokens: response.audit.usage.input_tokens,
                  outputTokens: response.audit.usage.output_tokens,
                  cachedInputTokens: 0,
                }
              : null,
            semanticProfile: profile,
            semantic: response.output,
            facts: [],
            ruleSemanticProfiles: undefined,
            classification: {
              kind: "openrouter-decisions",
              mode: settings.mode,
              model: response.audit.model ?? DECISIONS_CANONICAL_MODEL,
              protocolVersion: DECISIONS_VERSION,
            },
          })
      }
    }
    // A cached answer is not continuing consent; late configuration changes keep rules unknown.
    const current = await input.readConfig()
    latest = current
    if (
      profile &&
      (input.signal.aborted ||
        !current?.enabled ||
        !current.apiKey ||
        JSON.stringify({ ...decisionsSettings(current), classificationEnabled: true }) !==
          JSON.stringify(settings))
    ) {
      profile = {
        ...profile,
        assessments: profile.assessments.map((assessment) => ({
          ...assessment,
          state: "unknown",
          confidence: null,
          reason: "Decisions consent changed; retain the article.",
        })),
        coverage: "partial",
        semanticAssessmentCoverage: "partial",
      }
    }
  }
  const profiles: NonNullable<ProcessingDecision["ruleSemanticProfiles"]> = {}
  for (const rule of rules) {
    const useDecisions = ruleUsesDecisions(rule, routes)
    const stillSelected = rule.decisionModel !== undefined || ruleUsesDecisions(rule, latest)
    const chosen = useDecisions
      ? stillSelected
        ? profile
        : undefined
      : input.decision.classification
        ? undefined
        : base
    const ids = new Set(
      requiredSemanticTagIds({ ...input.config, rules: [rule] }, input.decision.context),
    )
    const assessments =
      chosen?.assessments.filter((item) => ids.has(item.tagId)) ??
      base.assessments
        .filter((item) => ids.has(item.tagId))
        .map((item) => ({
          ...item,
          state: "unknown" as const,
          confidence: null,
          reason: "The selected executor has no current judgment.",
        }))
    const value = {
      ...(chosen ?? base),
      assessedTagIds: [...ids],
      assessments: protectWholeContentAssessments(assessments, chosen?.substantiveContribution),
    }
    const referenced = new Set([
      ...value.assessments.flatMap((item) => item.evidenceIds),
      ...(value.substantiveContribution?.evidenceIds ?? []),
    ])
    value.evidence = Object.fromEntries(
      Object.entries(value.evidence).filter(([id]) => referenced.has(id)),
    )
    delete value.entities
    delete value.entityVersion
    profiles[rule.id] = {
      executor: useDecisions ? "decisions" : "generation",
      model: useDecisions ? DECISIONS_CANONICAL_MODEL : input.decision.model,
      fingerprint: useDecisions
        ? input.decision.classification
          ? (input.decision.analysisFingerprint ?? input.decision.fingerprint)
          : fingerprint
        : (input.decision.analysisFingerprint ?? input.decision.fingerprint),
      profile: value,
    }
  }
  const byTag = new Map<string, EntrySemanticProfile["assessments"][number]>()
  // 两种执行器的编号可能相同但片段不同；全局索引用原文摘要重编号，规则档案保持原始证据。
  const evidence = { ...base.evidence }
  const contributions = [base.substantiveContribution]
  for (const { profile } of Object.values(profiles)) {
    const remap = (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const quote = profile.evidence[id]
        if (!quote) return []
        const mergedId = `M${semanticDigest(quote)}`
        evidence[mergedId] = quote
        return [mergedId]
      })
    if (profile.substantiveContribution)
      contributions.push({
        ...profile.substantiveContribution,
        evidenceIds: remap(profile.substantiveContribution.evidenceIds),
      })
    for (const item of profile.assessments) {
      const merged = { ...item, evidenceIds: remap(item.evidenceIds) }
      const previous = byTag.get(item.tagId)
      byTag.set(
        item.tagId,
        !previous
          ? merged
          : previous.state === item.state
            ? {
                ...merged,
                confidence:
                  previous.confidence == null || item.confidence == null
                    ? null
                    : Math.min(previous.confidence, item.confidence),
              }
            : {
                ...merged,
                state: "unknown",
                confidence: null,
                reason: "Rule executors disagree; inspect the rule audit.",
              },
      )
    }
  }
  // 可靠的贡献正证优先保护阅读入口，不能沿用另一执行器的“无贡献”覆盖它。
  const substantiveContribution =
    contributions.find((item) => item?.state === "present" && item.evidenceIds.length > 0) ??
    (contributions.every((item) => item?.state === "absent")
      ? base.substantiveContribution
      : contributions.find((item) => item?.state === "unknown"))
  const assessments = [...byTag.values()]
  const partial = assessments.some((item) => item.state === "unknown")
  return {
    ...input.decision,
    ruleSemanticProfiles: profiles,
    context: {
      ...input.decision.context,
      ruleTagAssessments: Object.fromEntries(
        Object.entries(profiles).map(([id, item]) => [id, item.profile.assessments]),
      ),
    },
    semanticProfile: {
      ...base,
      assessedTagIds: assessments.map((item) => item.tagId),
      assessments,
      evidence,
      substantiveContribution,
      semanticAssessmentCoverage: partial ? ("partial" as const) : ("complete" as const),
      coverage: partial ? ("partial" as const) : base.coverage,
    },
    semantic: input.decision.semantic
      ? { ...input.decision.semantic, tagAssessments: assessments, substantiveContribution }
      : null,
  }
}
