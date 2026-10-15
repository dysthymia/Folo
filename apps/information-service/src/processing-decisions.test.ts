import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import type { RuleSet } from "@follow/information-core"
import { semanticTagDefinition } from "@follow/information-core"
import { join } from "pathe"
import { expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { DECISIONS_CANONICAL_MODEL, defaultDecisionsSettings } from "./decisions-config"
import type { SourceEntry } from "./folo"
import type { requestDecisions } from "./openrouter-decisions"
import { DecisionsError, parseDecisionsResponse } from "./openrouter-decisions"
import { decisionsOnlyEligible } from "./processing-decisions"
import { runEntryProcessing } from "./processing-engine"
import { processListLoaded } from "./processing-list-load"
import { processingSemanticApi } from "./processing-semantic-api"
import { Store } from "./store"

const config: RuleSet = {
  formatVersion: 5,
  ownerId: "owner",
  global: { version: 1, markdown: "" },
  rules: [
    {
      id: "noise",
      ownerId: "owner",
      name: "Hide chatter",
      enabled: true,
      order: 0,
      version: 1,
      executionLocation: "processing_service",
      when: {
        anyOf: [
          {
            allOf: [
              { field: "source_id", operator: "in", value: ["feed/1"] },
              {
                field: "entry_tag",
                operator: "contains_any",
                value: ["signal:social_chatter"],
                minConfidence: 0.95,
              },
            ],
          },
        ],
      },
      actions: [{ type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" }],
    },
  ],
}
function executor(
  options: {
    p?: number
    contribution?: number
    coverage?: number
    malformed?: boolean
    answers?: Record<string, unknown>
    model?: string
    provider?: string
  } = {},
) {
  return vi.fn<typeof requestDecisions>(async (request) => {
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        question.type === "choice"
          ? {
              type: "choice",
              choice:
                id === "contribution_evidence" && (options.contribution ?? 0) < 0.95
                  ? "none"
                  : "E000001",
            }
          : {
              type: "noul",
              noul:
                id === "material_complete"
                  ? (options.coverage ?? 0.99)
                  : id === "contribution"
                    ? (options.contribution ?? 0.01)
                    : (options.p ?? 0.99),
            },
      ]),
    )
    if (options.malformed) delete answers.tag_0
    Object.assign(answers, options.answers)
    return parseDecisionsResponse(
      {
        id: "offline",
        model: options.model ?? DECISIONS_CANONICAL_MODEL,
        provider: options.provider ?? "OpenAI",
        answers,
        usage: { input_tokens: 100, output_tokens: 5, cost: 0.00001 },
      },
      request.questions,
    )
  })
}
async function fixture(
  options: {
    mode?: "apply" | "observe"
    count?: number
    limit?: number
    text?: string
    enabled?: boolean
    classificationEnabled?: boolean
    read?: boolean
    ruleSet?: RuleSet
    entryFields?: Partial<SourceEntry>
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "folo-decisions-test-"))
  const aiConfig = new AIConfigStore(join(directory, "ai.json"))
  await aiConfig.save({ provider: "codex", model: "unused-generation" })
  await aiConfig.saveDecisions({
    ...defaultDecisionsSettings,
    enabled: options.enabled ?? true,
    classificationEnabled: options.classificationEnabled ?? true,
    mode: options.mode ?? "apply",
    maxRequestsPerRun: options.limit ?? 20,
    apiKey: "offline-only-key",
  })
  const store = new Store(":memory:")
  store.bindOwner("owner")
  store.replaceSources([
    { key: "feed/1", kind: "feed", id: "1", title: "Fixture", view: 0, category: null },
  ])
  store.automation.saveDraft(options.ruleSet ?? config, 0)
  store.automation.publish(1, { mode: "future" }, randomUUID())
  for (let index = 0; index < (options.count ?? 1); index++)
    store.saveEntry({
      id: `e${index}`,
      sourceKey: "feed/1",
      title: `Greeting ${index}`,
      url: `https://example.test/${index}`,
      publishedAt: "2026-10-12T00:00:00Z",
      content: options.text ?? `Good morning ${index}!`,
      description: null,
      read: options.read ?? false,
      ...options.entryFields,
    })
  for (const target of store.automation.inputs())
    store.processingState.setMaterial(target, "complete")
  const execute = vi.fn(async () => {
    throw new Error("generation must not run")
  })
  return {
    store,
    execute,
    options: {
      store,
      aiConfig,
      execute,
      runtimeDir: "/tmp",
      sourceKeys: ["feed/1"],
      historySince: "2026-10-01T00:00:00Z",
      signal: new AbortController().signal,
    },
    close: async () => {
      store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
it.each(["generation", "decisions"] as const)(
  "dispatches an explicitly %s rule independently of the global tag default",
  async (model) => {
    const f = await fixture({
      classificationEnabled: model === "generation",
      ruleSet: { ...config, rules: [{ ...config.rules[0]!, decisionModel: model }] },
    })
    const decisionsExecute = executor()
    try {
      await runEntryProcessing({ ...f.options, decisionsExecute })
      expect(decisionsExecute).toHaveBeenCalledTimes(model === "decisions" ? 1 : 0)
      expect(f.execute).toHaveBeenCalledTimes(model === "generation" ? 1 : 0)
      if (model === "decisions")
        expect(f.store.processingState.published()[0]?.decision.status).toBe("hide")
    } finally {
      await f.close()
    }
  },
)

it("publishes a mixed-model article with each rule's own answer and unchanged priority", async () => {
  const rules: RuleSet = {
    ...config,
    rules: [
      { ...config.rules[0]!, id: "generation", decisionModel: "generation", order: 0 },
      {
        ...config.rules[0]!,
        id: "decisions",
        decisionModel: "decisions",
        order: 1,
        actions: [{ type: "reading_decision", visibility: "show" }],
      },
    ],
  }
  const f = await fixture({ ruleSet: rules, classificationEnabled: false })
  const decisionsExecute = executor()
  let generationCalls = 0
  const execute = async <T>(request: CodexJsonOptions<T>) => {
    generationCalls++
    const output = {
      entryId: "e0",
      title: "Greeting 0",
      summary: "Good morning 0!",
      disposition: "keep",
      reason: "Generation judgment",
      aggregation: true,
      rewrite: true,
      labels: [],
      event: null,
      eventMentions: [],
      entities: [],
      facts: [],
      tagAssessments: [
        {
          tagId: "signal:social_chatter",
          definitionVersion: semanticTagDefinition("signal:social_chatter")!.definitionVersion,
          state: "absent",
          confidence: 0.99,
          evidenceIds: [],
          reason: "Generation says absent",
        },
      ],
      substantiveContribution: {
        state: "absent",
        confidence: 0.99,
        evidenceIds: [],
        reason: "No contribution",
      },
      materialCoverage: "complete",
    }
    const result = request.validate(output) ? output : { items: [output] }
    expect(request.validate(result)).toBe(true)
    return { result: result as T, model: request.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
  try {
    expect(await runEntryProcessing({ ...f.options, execute, decisionsExecute })).toMatchObject({
      completed: 1,
      failures: [],
    })
    expect(generationCalls).toBe(1)
    expect(decisionsExecute).toHaveBeenCalledTimes(1)
    const decision = f.store.processingState.published()[0]!.decision
    expect(decision).toMatchObject({
      status: "keep",
      policy: { standalone: "always" },
      ruleSemanticProfiles: {
        generation: { executor: "generation", profile: { assessments: [{ state: "absent" }] } },
        decisions: { executor: "decisions", profile: { assessments: [{ state: "present" }] } },
      },
    })
    expect(f.store.processingState.decisionsAudit()[0]).toMatchObject({
      ruleIds: ["decisions"],
      attempted: true,
    })
    expect(f.store.entry("feed/1", "e0")?.read).toBe(false)
  } finally {
    await f.close()
  }
})
it("publishes via existing tag rules, preserves read state and honors manual correction without another model call", async () => {
  const f = await fixture()
  const decisionsExecute = executor()
  try {
    expect(await runEntryProcessing({ ...f.options, decisionsExecute })).toMatchObject({
      completed: 1,
      failures: [],
    })
    const published = f.store.processingState.published()[0]!
    expect(published.decision).toMatchObject({
      status: "hide",
      classification: { kind: "openrouter-decisions", model: DECISIONS_CANONICAL_MODEL },
      facts: [],
      policy: { aggregation: "deny", rewrite: "deny" },
    })
    expect(published.decision.semanticProfile?.entities).toBeUndefined()
    expect(f.store.entry("feed/1", "e0")?.read).toBe(false)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.store.processingState.decisionsAudit()[0]).toMatchObject({
      status: "success",
      usage: { cost: 0.00001 },
      answers: { tag_0: { noul: 0.99 } },
    })
    expect(JSON.stringify(f.store.processingState.decisionsAudit())).not.toContain(
      "offline-only-key",
    )
    processingSemanticApi(
      f.store,
      "POST",
      `/processing/entries/${published.input.seq}/semantic-overrides`,
      {
        expectedContentVersion: published.input.contentVersion,
        expectedRevision: 0,
        requestId: randomUUID(),
        changes: [{ tagId: "signal:social_chatter", state: "absent" }],
      },
    )
    expect(f.store.processingState.published()[0]?.decision.status).toBe("keep")
    expect(decisionsExecute).toHaveBeenCalledTimes(1)
    expect(f.store.automation.effective().config?.rules).toEqual(config.rules)
  } finally {
    await f.close()
  }
})
it.each([
  { mode: "observe" as const, response: {} },
  { mode: "apply" as const, response: { p: 0.6 } },
  { mode: "apply" as const, response: { contribution: 0.99 } },
  { mode: "apply" as const, response: { coverage: 0.01 } },
  { mode: "apply" as const, response: { malformed: true } },
  { mode: "apply" as const, response: { model: "unexpected-model" } },
  { mode: "apply" as const, response: { provider: "unexpected-provider" } },
  {
    mode: "apply" as const,
    response: {
      answers: {
        evidence_0: {
          type: "choice",
          choice: "E000001",
          probabilities: { E000001: 0.1, none: 0.9 },
        },
      },
    },
  },
  {
    mode: "apply" as const,
    response: { answers: { tag_0: { type: "noul", noul: 0.99, refusal: "Cannot classify" } } },
  },
])(
  "retains visible content for observation, uncertainty, contribution conflict, missing evidence and malformed replies: %j",
  async ({ mode, response }) => {
    const f = await fixture({ mode })
    try {
      await runEntryProcessing({ ...f.options, decisionsExecute: executor(response) })
      const decision = f.store.processingState.published()[0]!.decision
      expect(decision.status).not.toBe("hide")
      expect(decision.semanticProfile?.assessments[0]?.state).toBe("unknown")
      expect(f.execute).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  },
)
// 已取得完整文本时，模糊的材料概率不能把明确的标签判断全部抹成未知。
it.each([0.34, 0.74, 0.75, 0.89])(
  "keeps supported classification with ambiguous coverage %s",
  async (coverage) => {
    const f = await fixture()
    const decisionsExecute = executor({ p: 0.01, contribution: 0.99, coverage })
    try {
      await runEntryProcessing({ ...f.options, decisionsExecute })
      const decision = f.store.processingState.published()[0]!.decision
      expect(decision.semanticProfile?.assessments[0]?.state).toBe("absent")
      expect(decision.pendingPolicyFields).toEqual([])
      expect(decision.policy.standalone).toBe("auto")
      expect(decisionsExecute.mock.calls[0]?.[0].state).toMatchObject({
        text: "Good morning 0!",
        material: { textComplete: true, missingContext: [] },
      })
      expect(decisionsExecute.mock.calls[0]?.[0].questions.evidence_0?.instructions).toContain(
        "social_chatter",
      )
    } finally {
      await f.close()
    }
  },
)
it("preserves a custom rule threshold stricter than supplied optional confidence", async () => {
  const rules = structuredClone(config)
  rules.rules[0]!.when = {
    anyOf: [
      {
        allOf: [
          {
            field: "entry_tag",
            operator: "contains_any",
            value: ["signal:social_chatter"],
            minConfidence: 0.995,
          },
        ],
      },
    ],
  }
  const f = await fixture({ ruleSet: rules })
  try {
    await runEntryProcessing({
      ...f.options,
      decisionsExecute: executor({
        answers: { tag_0: { type: "noul", noul: 0.999, confidence: 0.96 } },
      }),
    })
    const decision = f.store.processingState.published()[0]!.decision
    expect(decision.status).toBe("keep")
    expect(decision.semanticProfile?.assessments[0]?.confidence).toBe(0.96)
    expect(decision.pendingPolicyFields).toContain("standalone")
  } finally {
    await f.close()
  }
})
it("maps independent topic tags together and protects contradictory whole-content noise", async () => {
  const rules = structuredClone(config)
  rules.rules.push({
    ...rules.rules[0]!,
    id: "classify",
    order: 1,
    when: { all: true },
    actions: [
      { type: "ai_classify", tagIds: ["topic:ai", "topic:blockchain", "signal:reasoned_analysis"] },
    ],
  })
  const f = await fixture({ ruleSet: rules })
  try {
    await runEntryProcessing({ ...f.options, decisionsExecute: executor() })
    const decision = f.store.processingState.published()[0]!.decision
    expect(decision.status).toBe("keep")
    expect(
      decision.semanticProfile?.assessments
        .filter((item) => item.tagId.startsWith("topic:"))
        .every((item) => item.state === "present"),
    ).toBe(true)
    expect(
      decision.semanticProfile?.assessments.find((item) => item.tagId === "signal:social_chatter")
        ?.state,
    ).toBe("unknown")
  } finally {
    await f.close()
  }
})
it("defers unattempted budget targets and processes them in the next invocation", async () => {
  const f = await fixture({ count: 3, limit: 1 })
  const decisionsExecute = vi.fn<typeof requestDecisions>(async () => {
    throw new DecisionsError("http_error", null, 429)
  })
  try {
    expect(await runEntryProcessing({ ...f.options, decisionsExecute })).toMatchObject({
      completed: 1,
      pending: 2,
      failures: [],
      metrics: { budgetDeferred: 2 },
    })
    expect(decisionsExecute).toHaveBeenCalledTimes(1)
    expect(
      f.store.processingState.published().every((item) => item.decision.status === "keep"),
    ).toBe(true)
    expect(
      f.store.processingState
        .decisionsAudit()
        .map((item) => item.code)
        .sort(),
    ).toEqual(["http_error", "run_limit", "run_limit"])
    expect(f.store.automation.inputs().map((item) => item.status)).toEqual([
      "succeeded",
      "pending",
      "pending",
    ])
    expect(await runEntryProcessing({ ...f.options, decisionsExecute: executor() })).toMatchObject({
      completed: 1,
      pending: 1,
    })
    expect(f.execute).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})
it("does not send overlong text or already-read material", async () => {
  for (const options of [{ text: "a".repeat(12_001) }, { read: true }]) {
    const f = await fixture(options)
    const decisionsExecute = executor()
    try {
      await runEntryProcessing({ ...f.options, decisionsExecute })
      expect(decisionsExecute).not.toHaveBeenCalled()
      expect(f.execute).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  }
})
it.each([
  { imageCount: 1 },
  { content: '<p>Good morning.</p><img src="https://example.test/private-chart.png">' },
  { content: '<p>Caption.</p><video src="https://example.test/video.mp4"></video>' },
  { content: '<p>完整教程详见 <a href="https://example.test/full">原文</a></p>' },
])("does not call or hide known unread media or required linked text: %j", async (entryFields) => {
  const f = await fixture({ entryFields })
  const decisionsExecute = executor()
  try {
    await runEntryProcessing({ ...f.options, decisionsExecute })
    expect(decisionsExecute).not.toHaveBeenCalled()
    const decision = f.store.processingState.published()[0]!.decision
    expect(decision.status).toBe("needs_context")
    expect(decision.semanticProfile?.materialCoverage).toBe("partial")
    expect(decision.semanticProfile?.assessments[0]?.state).toBe("unknown")
    expect(f.store.processingState.decisionsAudit()[0]?.attempted).toBe(false)
  } finally {
    await f.close()
  }
})
it.each(["global", "classification"])(
  "keeps the original generation route when %s is disabled",
  async (disabled) => {
    const f = await fixture({ enabled: disabled !== "global" })
    if (disabled === "classification")
      await f.options.aiConfig.saveDecisions({
        ...defaultDecisionsSettings,
        enabled: true,
        classificationEnabled: false,
      })
    const decisionsExecute = executor()
    try {
      await runEntryProcessing({ ...f.options, decisionsExecute })
      expect(decisionsExecute).not.toHaveBeenCalled()
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect(f.store.processingState.decisionsAudit()).toEqual([])
    } finally {
      await f.close()
    }
  },
)
it("reuses a successful classification cache and does not repeatedly queue missing entities for tag-only rules", async () => {
  const f = await fixture()
  const decisionsExecute = executor()
  try {
    await runEntryProcessing({ ...f.options, decisionsExecute })
    const original = f.store.processingState.published()[0]!
    f.store.automation.assignLoadedRelease(original.input, original.input.releaseVersion!)
    expect(await runEntryProcessing({ ...f.options, decisionsExecute })).toMatchObject({
      completed: 1,
      metrics: { cacheHits: 1 },
    })
    expect(decisionsExecute).toHaveBeenCalledTimes(1)
    expect(f.store.processingState.decisionsAudit()).toHaveLength(1)
    f.store.schedule.save(
      {
        sourceKeys: ["feed/1"],
        scope: { mode: "rules" },
        historySince: f.options.historySince,
        timeZone: "UTC",
        enabled: true,
        runOnListLoad: true,
      },
      0,
    )
    const current = f.store.automation.current("feed/1", "e0")!
    const { id, sourceKey, title, publishedAt, url, read, description } = current.body
    processListLoaded(
      f.store,
      { entries: [{ id, sourceKey, title, publishedAt, url, read, description }] },
      new Date("2026-10-13T00:00:00Z"),
    )
    expect(f.store.automation.current("feed/1", "e0")).toMatchObject({
      generation: current.generation,
      status: "succeeded",
    })
  } finally {
    await f.close()
  }
})
it("a late reply cannot apply tag rules after Decisions is disabled", async () => {
  const f = await fixture()
  const offline = executor()
  const decisionsExecute: typeof requestDecisions = async (request) => {
    const response = await offline(request)
    await f.options.aiConfig.saveDecisions({ ...defaultDecisionsSettings, enabled: false })
    return response
  }
  try {
    await runEntryProcessing({ ...f.options, decisionsExecute })
    expect(f.store.processingState.published()[0]?.decision.status).toBe("keep")
    expect(f.store.processingState.decisionsAudit()[0]?.status).toBe("success")
  } finally {
    await f.close()
  }
})
it("rule-only release changes reuse analysis but project the new reading decision", async () => {
  const f = await fixture()
  const decisionsExecute = executor()
  try {
    await runEntryProcessing({ ...f.options, decisionsExecute })
    const original = f.store.processingState.published()[0]!
    const rules = structuredClone(config)
    rules.rules[0]!.version++
    rules.rules[0]!.actions = [{ type: "reading_decision", visibility: "show" }]
    const draft = f.store.automation.draft()
    f.store.automation.saveDraft(rules, draft.revision)
    const released = f.store.automation.publish(
      draft.revision + 1,
      { mode: "future" },
      randomUUID(),
    )
    f.store.automation.assignLoadedRelease(original.input, released.version)
    const result = await runEntryProcessing({ ...f.options, decisionsExecute })
    expect(result.metrics?.cacheHits).toBe(1)
    const current = f.store.processingState.published()[0]!
    expect(current.decision.status).toBe("keep")
    expect(current.decision.fingerprint).toBe(original.decision.fingerprint)
    expect(current.input.generation).toBeGreaterThan(original.input.generation)
    expect(decisionsExecute).toHaveBeenCalledTimes(1)
    expect(f.store.processingState.decisionsAudit()).toHaveLength(1)
    expect(f.store.entry("feed/1", "e0")?.read).toBe(false)
  } finally {
    await f.close()
  }
})
it("new article material cannot reuse the old classification cache", async () => {
  const f = await fixture()
  const decisionsExecute = executor()
  try {
    await runEntryProcessing({ ...f.options, decisionsExecute })
    const original = f.store.processingState.published()[0]!
    f.store.saveEntry({
      ...original.input.body,
      content: "New material with a different content identity.",
    })
    const target = f.store.automation.current("feed/1", "e0")!
    f.store.processingState.setMaterial(target, "complete")
    await runEntryProcessing({ ...f.options, decisionsExecute })
    expect(decisionsExecute).toHaveBeenCalledTimes(2)
    const current = f.store.processingState.published()[0]!
    expect(current.decision.fingerprint).not.toBe(original.decision.fingerprint)
    expect(current.decision.semanticProfile?.contentVersion).toBe(target.contentVersion)
    expect(f.store.processingState.decisionsAudit()).toHaveLength(2)
  } finally {
    await f.close()
  }
})
it("new media metadata cannot reuse a text-only cache even when plain text is identical", async () => {
  const f = await fixture()
  const decisionsExecute = executor()
  try {
    await runEntryProcessing({ ...f.options, decisionsExecute })
    const original = f.store.processingState.published()[0]!
    f.store.saveEntry({ ...original.input.body, imageCount: 1 })
    const target = f.store.automation.current("feed/1", "e0")!
    f.store.processingState.setMaterial(target, "complete")
    await runEntryProcessing({ ...f.options, decisionsExecute })
    expect(decisionsExecute).toHaveBeenCalledTimes(1)
    const current = f.store.processingState.published()[0]!.decision
    expect(current.fingerprint).not.toBe(original.decision.fingerprint)
    expect(current.status).toBe("needs_context")
    expect(current.semanticProfile?.assessments[0]?.state).toBe("unknown")
  } finally {
    await f.close()
  }
})
it("does not bypass generation selected by currently unknown tag conditions", () => {
  const context = { source_id: "feed/1", contextId: "feed/1", entry_tag: null }
  expect(decisionsOnlyEligible(config, context)).toBe(true)
  for (const type of ["ai_transform", "ai_dedupe", "ai_aggregate"] as const) {
    const rule = {
      ...config.rules[0]!,
      id: "generation",
      order: 1,
      actions:
        type === "ai_transform"
          ? [{ type, prompt: "Generate" }]
          : type === "ai_dedupe"
            ? [{ type, scope: { all: true as const } }]
            : [
                {
                  type,
                  scope: { all: true as const },
                  mode: "same_event" as const,
                  createPrompt: "Generate",
                  updatePrompt: "",
                },
              ],
    }
    expect(decisionsOnlyEligible({ ...config, rules: [...config.rules, rule] }, context)).toBe(
      false,
    )
  }
})
