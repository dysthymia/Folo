import type { RuleSet, TagAssessment } from "@follow/information-core"
import { semanticTagDefinition } from "@follow/information-core"
import { expect, it, vi } from "vitest"

import type { ProcessingInput } from "./automation-store"
import type { DecisionsConfig } from "./decisions-config"
import { DECISIONS_CANONICAL_MODEL, defaultDecisionsSettings } from "./decisions-config"
import type { requestDecisions } from "./openrouter-decisions"
import { parseDecisionsResponse } from "./openrouter-decisions"
import type { ProcessingDecision } from "./processing-decision"
import { attachRuleDecisions } from "./processing-rule-decisions"
import { projectSemanticDecision } from "./processing-semantic-decision"

const tagId = "signal:social_chatter"
function fixture(generationState: TagAssessment["state"] = "absent") {
  const assessment: TagAssessment = {
    tagId,
    definitionVersion: semanticTagDefinition(tagId)!.definitionVersion,
    state: generationState,
    confidence: 0.99,
    reason: "Generation fixture",
    evidenceIds: generationState === "present" ? ["E000001"] : [],
  }
  const config: RuleSet = {
    formatVersion: 5,
    ownerId: "owner",
    global: { version: 1, markdown: "" },
    rules: ["generation", "decisions"].map((model, order) => ({
      id: model,
      name: model,
      ownerId: "owner",
      order,
      version: 1,
      enabled: true,
      executionLocation: "processing_service",
      decisionModel: model as "generation" | "decisions",
      when: {
        anyOf: [
          {
            allOf: [
              { field: "entry_tag", operator: "contains_any", value: [tagId], minConfidence: 0.95 },
            ],
          },
        ],
      },
      actions: [{ type: "reading_decision", visibility: order === 0 ? "hide" : "show" }],
    })),
  }
  const text = "Good morning everyone!"
  const target = {
    seq: 1,
    generation: 1,
    contentVersion: "v1",
    itemId: "e1",
    sourceKey: "feed/1",
    body: {
      id: "e1",
      sourceKey: "feed/1",
      title: "Greeting",
      content: text,
      read: false,
      description: null,
      url: "https://example.test/1",
      publishedAt: "2026-10-13T00:00:00Z",
    },
  } as ProcessingInput
  const semantic = {
    entryId: "e1",
    title: "Greeting",
    summary: text,
    disposition: "keep" as const,
    reason: "Fixture",
    aggregation: true,
    rewrite: true,
    labels: [],
    facts: [],
    tagAssessments: [assessment],
    substantiveContribution: {
      state: "absent" as const,
      confidence: 0.99,
      evidenceIds: [],
      reason: "No contribution",
    },
    materialCoverage: "complete" as const,
  }
  const decision: ProcessingDecision = {
    schemaVersion: 2,
    fingerprint: "generation-base",
    provider: "codex",
    model: "generation-model",
    generatedAt: "2026-10-13T00:00:00Z",
    durationMs: 1,
    usage: null,
    status: "keep",
    title: "Greeting",
    summary: text,
    reason: "Fixture",
    labels: [],
    facts: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "reporting",
    context: { source_id: "feed/1", contextId: "feed/1", entry_content: text },
    semantic,
    semanticProfile: {
      schemaVersion: 2,
      contentVersion: "v1",
      materialDigest: "material",
      definitionDigest: "definition",
      assessedTagIds: [tagId],
      assessments: [assessment],
      evidence: { E000001: text },
      coverage: "complete",
      materialCoverage: "complete",
      semanticAssessmentCoverage: "complete",
      substantiveContribution: semantic.substantiveContribution,
    },
    reused: false,
  }
  let settings: DecisionsConfig = {
    ...defaultDecisionsSettings,
    enabled: true,
    classificationEnabled: false,
    mode: "apply",
    apiKey: "offline-key",
  }
  const cache = new Map<string, ProcessingDecision>()
  const record = vi.fn()
  const execute = vi.fn<typeof requestDecisions>(async (request) =>
    parseDecisionsResponse(
      {
        model: DECISIONS_CANONICAL_MODEL,
        provider: "OpenAI",
        usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 },
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            question.type === "choice"
              ? { type: "choice", choice: id === "contribution_evidence" ? "none" : "E000001" }
              : { type: "noul", noul: id === "contribution" ? 0.01 : 0.99 },
          ]),
        ),
      },
      request.questions,
    ),
  )
  const options = {
    target,
    decision,
    config,
    settings,
    text,
    signal: new AbortController().signal,
    readConfig: async () => settings,
    execute,
    budgetAllowed: () => true,
    record,
    store: {
      cache: (key: string) => cache.get(key) ?? null,
      saveCache: (value: ProcessingDecision) => {
        cache.set(value.fingerprint, value)
      },
      recordDecisions: record,
    },
  }
  return {
    options,
    execute,
    record,
    update: (value: Partial<DecisionsConfig>) => {
      settings = { ...settings, ...value }
    },
  }
}

it("opposite executor answers do not leak across two rules on the same article", async () => {
  const f = fixture()
  const result = await attachRuleDecisions(f.options)
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(result.ruleSemanticProfiles?.generation).toMatchObject({
    executor: "generation",
    model: "generation-model",
    profile: { assessments: [{ state: "absent" }] },
  })
  expect(result.ruleSemanticProfiles?.decisions).toMatchObject({
    executor: "decisions",
    model: DECISIONS_CANONICAL_MODEL,
    profile: { assessments: [{ state: "present" }] },
  })
  expect(result.semanticProfile?.assessments[0]?.state).toBe("unknown")
  const projected = projectSemanticDecision(result, f.options.config, result.context)
  expect(projected.status).toBe("keep")
  expect(projected.policy.standalone).toBe("always")
  expect(f.record.mock.calls[0]?.[0]).toMatchObject({ ruleIds: ["decisions"], attempted: true })
  expect(f.options.decision.semanticProfile?.assessments[0]?.state).toBe("absent")
})

// 全局证据编号独立于生成批次和 Decisions，各条规则仍保留各自原始档案。
it("merges evidence without collisions and preserves a supported contribution", async () => {
  const f = fixture()
  const original = f.execute.getMockImplementation()!
  f.options.decision.semanticProfile!.evidence = { E000001: "Other generation evidence" }
  f.execute.mockImplementation(async (request) => {
    const response = await original(request)
    response.answers.contribution = { type: "noul", noul: 0.99 }
    response.answers.contribution_evidence = { type: "choice", choice: "E000001" }
    return response
  })
  const result = await attachRuleDecisions(f.options)
  const profile = result.semanticProfile!
  for (const id of profile.assessments.flatMap((item) => item.evidenceIds))
    expect(profile.evidence[id]).toBe(f.options.text)
  expect(profile.evidence.E000001).toBe("Other generation evidence")
  expect(profile.substantiveContribution?.state).toBe("present")
  for (const id of profile.substantiveContribution!.evidenceIds)
    expect(profile.evidence[id]).toBe(f.options.text)
  expect(result.ruleSemanticProfiles?.decisions?.profile.evidence.E000001).toBe(f.options.text)
})

it("signals a mixed-model budget deferral without publishing unknown judgments", async () => {
  const f = fixture()
  const onDeferred = vi.fn()
  const result = await attachRuleDecisions({ ...f.options, budgetAllowed: () => false, onDeferred })
  expect(onDeferred).toHaveBeenCalledOnce()
  expect(result).toBe(f.options.decision)
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.record.mock.calls[0]?.[0].code).toBe("run_limit")
})

it("reuses only a Decisions cache, preserving the generation profile and recording current rule consumers", async () => {
  const f = fixture()
  await attachRuleDecisions(f.options)
  const result = await attachRuleDecisions({
    ...f.options,
    target: { ...f.options.target, generation: 2 },
  })
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(result.ruleSemanticProfiles?.generation?.fingerprint).toBe("generation-base")
  expect(f.record.mock.calls.at(-1)?.[0]).toMatchObject({
    code: "cache_hit",
    attempted: false,
    ruleIds: ["decisions"],
  })
  const generationOnly = {
    ...f.options.config,
    rules: f.options.config.rules.map((rule) => ({
      ...rule,
      decisionModel: "generation" as const,
    })),
  }
  expect(
    (await attachRuleDecisions({ ...f.options, config: generationOnly })).ruleSemanticProfiles
      ?.decisions?.executor,
  ).toBe("generation")
  expect(f.execute).toHaveBeenCalledTimes(1)
})
it("adding an explicit choice preserves a legacy rule's existing generation path when generation actions are required", async () => {
  const f = fixture()
  f.update({ classificationEnabled: true })
  const legacy = {
    ...f.options.config.rules[0]!,
    id: "legacy",
    order: 2,
    actions: [{ type: "ai_transform" as const, prompt: "keep facts" }],
  }
  delete legacy.decisionModel
  const result = await attachRuleDecisions({
    ...f.options,
    settings: { ...f.options.settings, classificationEnabled: true },
    config: { ...f.options.config, rules: [...f.options.config.rules, legacy] },
  })
  expect(result.ruleSemanticProfiles?.legacy?.executor).toBe("generation")
  expect(f.record.mock.calls[0]?.[0]?.ruleIds).toEqual(["decisions"])
})

it.each(["disabled", "failure", "media", "late-disable"])(
  "%s retains the selected Decisions rule without replacing another rule's judgment",
  async (mode) => {
    const f = fixture("present")
    if (mode === "disabled") f.update({ enabled: false })
    if (mode === "failure") f.execute.mockRejectedValue(new Error("offline failure"))
    if (mode === "late-disable") {
      const original = f.execute.getMockImplementation()!
      f.execute.mockImplementation(async (request) => {
        const result = await original(request)
        f.update({ enabled: false })
        return result
      })
    }
    const result = await attachRuleDecisions({
      ...f.options,
      budgetAllowed: () => true,
      target:
        mode === "media"
          ? { ...f.options.target, body: { ...f.options.target.body, imageCount: 1 } }
          : f.options.target,
    })
    expect(result.ruleSemanticProfiles?.decisions?.profile.assessments[0]?.state).toBe("unknown")
    expect(result.ruleSemanticProfiles?.generation?.profile.assessments[0]?.state).toBe("present")
    if (["disabled", "media"].includes(mode)) expect(f.execute).not.toHaveBeenCalled()
  },
)
