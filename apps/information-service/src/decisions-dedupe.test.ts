import { DatabaseSync } from "node:sqlite"

import { afterEach, expect, it, vi } from "vitest"

import type { DecisionsConfig } from "./decisions-config"
import { DECISIONS_CANONICAL_MODEL, defaultDecisionsSettings } from "./decisions-config"
import { dedupeDecisionQuestions, observeDecisionsDedupe } from "./decisions-dedupe"
import type { DecisionAnswer } from "./openrouter-decisions"
import { requestDecisions } from "./openrouter-decisions"
import { ProcessingDedupeStore } from "./processing-dedupe"
import type { SemanticDuplicateCandidate } from "./semantic-dedupe"

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
const reply = (answers: Partial<Record<string, DecisionAnswer>> = {}) => ({
  id: "offline-request",
  model: DECISIONS_CANONICAL_MODEL,
  provider: "OpenAI",
  usage: { input_tokens: 500, output_tokens: 0, cost: 0.00005 },
  answers: {
    same_event: { type: "noul", noul: 0.99 },
    conflicts: { type: "noul", noul: 0.01 },
    material_complete: { type: "noul", noul: 0.99 },
    coverage: {
      type: "choice",
      choice: "equivalent",
      confidence: 0.99,
      probabilities: { equivalent: 0.99, uncertain: 0.01 },
    },
    ...answers,
  },
})
function candidate(prefix = "article"): SemanticDuplicateCandidate {
  return {
    pairKey: `${prefix}-a::${prefix}-b`,
    keepEntryId: `${prefix}-a`,
    testEntryId: `${prefix}-b`,
    similarity: 0.9,
    entries: ["a", "b"].map((suffix, index) => ({
      itemId: `${prefix}-${suffix}`,
      title: "Example announces a release",
      sourceTitle: `source-${index}`,
      description: "Auxiliary summary",
      publishedAt: "2026-10-13T00:00:00Z",
      urlHost: "example.test",
      content: `Example releases version six. Price is ten dollars. Rephrasing ${suffix}.`,
      contentComplete: true,
    })) as SemanticDuplicateCandidate["entries"],
  }
}
function fixture(value: unknown = reply()) {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  const store = new ProcessingDedupeStore(db, () => [])
  let config: DecisionsConfig = {
    ...defaultDecisionsSettings,
    enabled: true,
    apiKey: "offline-secret",
    dedupeObservation: { enabled: true, maxPairsPerTrigger: 8 },
  }
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value)))
  const execute = vi.fn((input: Parameters<typeof requestDecisions>[0]) =>
    requestDecisions({ ...input, fetcher }),
  )
  const options = {
    candidates: [candidate()],
    store,
    readConfig: async () => config,
    inputs: (pair: SemanticDuplicateCandidate) =>
      pair.entries.map((entry, index) => ({
        seq: index + 1,
        generation: 1,
        contentVersion: "v1",
        itemId: entry.itemId,
      })),
    isCurrent: () => true,
    reference: () => ({
      model: "generation-fixture",
      provider: "fixture",
      evaluation: {
        duplicate: true,
        confidence: 0.99,
        verdict: "equivalent" as const,
        status: "decided" as const,
      },
    }),
    ruleId: "released-rule",
    configFingerprint: "rule-v1",
    triggerId: "trigger-one",
    signal: new AbortController().signal,
    execute,
  }
  return {
    options,
    store,
    execute,
    fetcher,
    update: (next: Partial<DecisionsConfig>) => {
      config = { ...config, ...next }
    },
  }
}

it("records a dedicated probability comparison without publishing a merge or storing article/key data", async () => {
  const f = fixture()
  await observeDecisionsDedupe(f.options)
  const row = f.store.decisionsObservations()[0]!
  expect(row).toMatchObject({
    status: "decided",
    attempted: true,
    comparison: "agree",
    assessment: { coverage: "equivalent" },
    usage: { cost: 0.00005 },
  })
  const body = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))
  expect(body.state.first.content).toContain("Price is ten dollars")
  expect(body).not.toHaveProperty("messages")
  expect(Object.keys(body.questions)).toEqual(Object.keys(dedupeDecisionQuestions))
  expect(JSON.stringify(row)).not.toContain("offline-secret")
  expect(JSON.stringify(row)).not.toContain("Price is ten dollars")
  expect(f.store.merges(new Set(["rule-v1"]))).toEqual([])
})

it("reuses an observed answer in direct mode without rebilling, but blocks stale publication", async () => {
  const f = fixture()
  await observeDecisionsDedupe(f.options)
  f.update({ dedupeObservation: { enabled: true, mode: "apply", maxPairsPerTrigger: 8 } })
  const report = await observeDecisionsDedupe({ ...f.options, mode: "apply" })
  expect(report.audits[0]?.status).toBe("decided")
  expect(report.requested).toEqual([])
  const stale = await observeDecisionsDedupe({
    ...f.options,
    mode: "apply",
    isCurrent: () => false,
  })
  expect(stale.audits[0]).toMatchObject({ status: "skipped", code: "stale_inputs" })
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.store.decisionsObservations()[0]?.status).toBe("decided")
})

it.each(["first_contains_second", "second_contains_first", "different"])(
  "observes %s as a distinct coverage verdict and a baseline disagreement",
  async (coverage) => {
    const f = fixture(reply({ coverage: { type: "choice", choice: coverage, confidence: 0.99 } }))
    await observeDecisionsDedupe(f.options)
    expect(f.store.decisionsObservations()[0]).toMatchObject({
      status: "decided",
      comparison: "disagree",
      assessment: { coverage },
    })
  },
)

it.each([
  { same_event: { type: "noul", noul: 0.01 } },
  { conflicts: { type: "noul", noul: 0.99 } },
])(
  "keeps same-topic/different-event or conflicting reports when coverage is different",
  async (answers) => {
    const f = fixture(
      reply({
        ...answers,
        coverage: { type: "choice", choice: "different", confidence: 0.99 },
      } as Partial<Record<string, DecisionAnswer>>),
    )
    await observeDecisionsDedupe(f.options)
    expect(f.store.decisionsObservations()[0]).toMatchObject({
      status: "decided",
      assessment: { coverage: "different" },
    })
  },
)

it.each([
  { same_event: { type: "noul", noul: 0.01 } },
  { conflicts: { type: "noul", noul: 0.99 } },
  { material_complete: { type: "noul", noul: 0.99, confidence: 0.1 } },
  {
    coverage: {
      type: "choice",
      choice: "equivalent",
      confidence: 0.99,
      probabilities: { equivalent: 0.1, different: 0.9 },
    },
  },
  { coverage: { type: "choice", choice: "equivalent" } },
])("keeps inconsistent or insufficiently confident conclusions unknown", async (answers) => {
  const f = fixture(reply(answers as Partial<Record<string, DecisionAnswer>>))
  await observeDecisionsDedupe(f.options)
  expect(f.store.decisionsObservations()[0]).toMatchObject({
    status: "uncertain",
    comparison: "unavailable",
    assessment: { coverage: "uncertain" },
  })
})

it.each(["disabled", "dedupe-disabled", "missing-key"])(
  "requires independent consent and a key: %s",
  async (mode) => {
    const f = fixture()
    f.update(
      mode === "disabled"
        ? { enabled: false }
        : mode === "missing-key"
          ? { apiKey: undefined }
          : { dedupeObservation: undefined },
    )
    await observeDecisionsDedupe(f.options)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.store.decisionsObservations()).toEqual([])
  },
)

it.each(["incomplete_material", "unsupported_media", "input_limit"])(
  "skips %s locally without truncating or charging",
  async (code) => {
    const f = fixture()
    const pair = f.options.candidates[0]!
    if (code === "incomplete_material") pair.entries[0].contentComplete = false
    if (code === "unsupported_media") pair.entries[0].content += '<img src="omitted">'
    if (code === "input_limit") {
      pair.entries[0].contentComplete = false
      pair.entries[0].fullContentComplete = true
      pair.entries[0].fullContent = "x".repeat(501)
      f.update({ maxInputChars: 500 })
    }
    await observeDecisionsDedupe(f.options)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.store.decisionsObservations()[0]).toMatchObject({
      attempted: false,
      status: "skipped",
      code,
    })
  },
)

it("shares a persistent trigger budget and does not charge the same observation twice", async () => {
  const f = fixture()
  f.update({ dedupeObservation: { enabled: true, maxPairsPerTrigger: 1 } })
  await observeDecisionsDedupe(f.options)
  await observeDecisionsDedupe({ ...f.options, candidates: [candidate("second")] })
  await observeDecisionsDedupe({ ...f.options, ruleId: "overlapping-rule" })
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.store.decisionsObservationAttempts("trigger-one")).toBe(1)
  expect(f.store.decisionsObservations()).toContainEqual(
    expect.objectContaining({ code: "pair_budget", attempted: false }),
  )
  await observeDecisionsDedupe({
    ...f.options,
    candidates: [candidate("second")],
    triggerId: "trigger-two",
  })
  expect(f.execute).toHaveBeenCalledTimes(2)
})

it("shares the explicit invocation budget without a trigger", async () => {
  const f = fixture()
  f.update({ dedupeObservation: { enabled: true, maxPairsPerTrigger: 1 } })
  const budget = { attempts: 0 }
  await observeDecisionsDedupe({ ...f.options, triggerId: undefined, budget })
  await observeDecisionsDedupe({
    ...f.options,
    candidates: [candidate("other")],
    triggerId: undefined,
    budget,
  })
  expect(f.execute).toHaveBeenCalledTimes(1)
})

it("preserves billed invalid/refused outcomes and never automatically repeats a failed request", async () => {
  const f = fixture({
    ...reply(),
    answers: {
      ...reply().answers,
      same_event: { type: "noul", noul: 0.99, refusal: "untrusted text offline-secret" },
    },
  })
  await observeDecisionsDedupe(f.options)
  await observeDecisionsDedupe(f.options)
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.store.decisionsObservations()[0]).toMatchObject({
    status: "error",
    code: "invalid_response",
    usage: { cost: 0.00005 },
  })
  expect(JSON.stringify(f.store.decisionsObservations())).not.toContain("offline-secret")
})

it("reserves an attempt before transport and treats a stranded pending attempt as unknown billing", async () => {
  const f = fixture()
  f.execute.mockImplementationOnce(async () => {
    expect(f.store.decisionsObservations()[0]).toMatchObject({
      status: "pending",
      attempted: true,
      usage: null,
    })
    throw new Error("transport contains offline-secret")
  })
  await observeDecisionsDedupe(f.options)
  expect(f.store.decisionsObservations()[0]).toMatchObject({
    status: "error",
    code: "observation_failed",
    usage: null,
  })
  const row = f.store.decisionsObservations()[0]!
  f.store.recordDecisionsObservation({ ...row, status: "pending" })
  await observeDecisionsDedupe(f.options)
  expect(f.execute).toHaveBeenCalledTimes(1)
})

it.each(["settings_changed", "stale_inputs", "cancelled"])(
  "retains raw late results but excludes %s from reliable comparisons",
  async (code) => {
    const f = fixture()
    const controller = new AbortController()
    let current = true
    const original = f.execute.getMockImplementation()!
    f.execute.mockImplementationOnce(async (input) => {
      const response = await original(input)
      if (code === "settings_changed") f.update({ enabled: false })
      if (code === "stale_inputs") current = false
      if (code === "cancelled") controller.abort()
      return response
    })
    await observeDecisionsDedupe({
      ...f.options,
      signal: controller.signal,
      isCurrent: () => current,
    })
    expect(f.store.decisionsObservations()[0]).toMatchObject({
      status: "skipped",
      code,
      comparison: "unavailable",
      answers: expect.any(Object),
      usage: { cost: 0.00005 },
    })
  },
)

it("material/generation changes isolate observations without deleting earlier audit", async () => {
  const f = fixture()
  await observeDecisionsDedupe(f.options)
  f.options.candidates[0]!.entries[1].content += " New launch deadline."
  await observeDecisionsDedupe({
    ...f.options,
    inputs: (pair) =>
      f.options.inputs(pair).map((input) => ({ ...input, generation: 2, contentVersion: "v2" })),
  })
  expect(f.execute).toHaveBeenCalledTimes(2)
  expect(f.store.decisionsObservations()).toHaveLength(2)
})

it("rejects oversized UTF-8 payloads before reserving a paid attempt", async () => {
  const f = fixture()
  f.update({ maxInputChars: 60000 })
  for (const entry of f.options.candidates[0]!.entries) entry.content = "文".repeat(50000)
  await observeDecisionsDedupe(f.options)
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.store.decisionsObservations()[0]).toMatchObject({
    attempted: false,
    status: "skipped",
    code: "request_limit",
  })
})

it("does not repeat billing solely because tag mode or pair budget changes", async () => {
  const f = fixture()
  await observeDecisionsDedupe(f.options)
  f.update({ mode: "apply", dedupeObservation: { enabled: true, maxPairsPerTrigger: 24 } })
  await observeDecisionsDedupe(f.options)
  expect(f.execute).toHaveBeenCalledTimes(1)
})

it("retains failed HTTP billing without exposing the upstream error body", async () => {
  const f = fixture()
  f.fetcher.mockResolvedValueOnce(
    Response.json(
      {
        error: { message: "contains offline-secret" },
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.01 },
      },
      { status: 402 },
    ),
  )
  await observeDecisionsDedupe(f.options)
  expect(f.store.decisionsObservations()[0]).toMatchObject({
    status: "error",
    code: "http_error",
    usage: { cost: 0.01 },
  })
  expect(JSON.stringify(f.store.decisionsObservations())).not.toContain("offline-secret")
})
