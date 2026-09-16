import { describe, expect, it } from "vitest"

import { evaluateDataset, evaluationDatasetSchema } from "./evaluation"

function confirmedSample(
  id: string,
  overrides: {
    partition?: "dev" | "heldout"
    expectedEventId?: string | null
    resultEventId?: string | null
    important?: boolean
    resultDisposition?: "keep" | "hide" | "needs_context"
    result?: "present" | "missing"
  } = {},
) {
  const result =
    overrides.result === "missing"
      ? null
      : {
          disposition: overrides.resultDisposition ?? ("keep" as const),
          aggregation: "allow" as const,
          rewrite: "deny" as const,
          eventId: overrides.resultEventId ?? null,
          factIds: ["fact-1", "fact-2"],
        }

  return {
    id,
    original: { sourceKey: "feed/source", itemId: id, contentVersion: "sha256:v1" },
    partition: overrides.partition ?? ("dev" as const),
    humanReview: {
      status: "confirmed" as const,
      expectation: {
        disposition: "keep" as const,
        aggregation: "allow" as const,
        rewrite: "deny" as const,
        important: overrides.important ?? false,
        eventId: overrides.expectedEventId ?? null,
        factReviews: result
          ? [
              { factId: "fact-1", supported: true, citationSupported: true },
              { factId: "fact-2", supported: false, citationSupported: null },
            ]
          : [],
      },
    },
    result,
  }
}

describe("固定样本语义评估", () => {
  it("按分区单列未确认、分歧和缺结果样本，不把它们计入确定分母", () => {
    const report = evaluateDataset({
      formatVersion: 1,
      samples: [
        confirmedSample("confirmed"),
        confirmedSample("missing", { result: "missing" }),
        {
          id: "disputed",
          original: { sourceKey: "feed/source", itemId: "d", contentVersion: "v1" },
          partition: "dev",
          humanReview: { status: "disputed" },
          result: null,
        },
        {
          id: "unreviewed",
          original: { sourceKey: "feed/source", itemId: "u", contentVersion: "v1" },
          partition: "heldout",
          humanReview: { status: "unreviewed" },
          result: null,
        },
      ],
    })

    expect(report.partitions.dev.samples).toEqual({
      total: 3,
      confirmed: 2,
      disputed: 1,
      unreviewed: 0,
    })
    expect(report.partitions.dev.exclusions).toEqual({
      disputedSampleIds: ["disputed"],
      unreviewedSampleIds: [],
      missingResultSampleIds: ["missing"],
    })
    expect(report.partitions.dev.disposition.denominator).toBe(1)
    expect(report.partitions.heldout.exclusions.unreviewedSampleIds).toEqual(["unreviewed"])
    expect(report.partitions.heldout.disposition.denominator).toBe(0)
    expect(report).not.toHaveProperty("pass")
  })

  it("给出重要误隐藏与事件成对错误的明确分母和错误成员", () => {
    const report = evaluateDataset({
      formatVersion: 1,
      samples: [
        confirmedSample("a", {
          expectedEventId: "expected-1",
          resultEventId: "predicted-wrong",
          important: true,
          resultDisposition: "hide",
        }),
        confirmedSample("b", {
          expectedEventId: "expected-1",
          resultEventId: "predicted-b",
        }),
        confirmedSample("c", {
          expectedEventId: "expected-2",
          resultEventId: "predicted-wrong",
        }),
      ],
    })
    const dev = report.partitions.dev

    expect(dev.importantFalseHide).toEqual({
      denominator: 1,
      errors: 1,
      errorSampleIds: ["a"],
    })
    expect(dev.eventPairs).toMatchObject({
      denominator: 3,
      expectedSameEventPairs: 1,
      expectedDifferentEventPairs: 2,
      wrongMerges: 1,
      missedMerges: 1,
      wrongMergePairs: [{ sampleIds: ["a", "c"] }],
      missedMergePairs: [{ sampleIds: ["a", "b"] }],
    })
  })

  it("事实和引用支持率只统计逐条人工审阅的数据", () => {
    const report = evaluateDataset({
      formatVersion: 1,
      samples: [confirmedSample("reviewed")],
    })
    const dev = report.partitions.dev

    expect(dev.humanFactSupport).toEqual({
      denominator: 2,
      supported: 1,
      unsupported: 1,
      unsupportedFacts: [{ sampleId: "reviewed", factId: "fact-2" }],
    })
    expect(dev.humanCitationSupport).toEqual({
      denominator: 1,
      supported: 1,
      unsupported: 0,
      unsupportedCitations: [],
    })
  })

  it("必保留事实缺失只统计人工已判定项，并单列未审阅项", () => {
    const sample = confirmedSample("required-facts")
    const report = evaluateDataset({
      formatVersion: 1,
      samples: [
        {
          ...sample,
          humanReview: {
            ...sample.humanReview,
            expectation: {
              ...sample.humanReview.expectation,
              requiredFacts: [
                { factId: "required-missing", statement: "人工确认必须保留的事实 A" },
                { factId: "required-unreviewed", statement: "人工确认必须保留的事实 B" },
              ],
              requiredFactReviews: [
                { factId: "required-missing", presence: "absent" },
                { factId: "required-unreviewed", presence: "unreviewed" },
              ],
            },
          },
        },
      ],
    })

    expect(report.partitions.dev.humanRequiredFactPresence).toEqual({
      denominator: 1,
      present: 0,
      missing: 1,
      missingFacts: [{ sampleId: "required-facts", factId: "required-missing" }],
      unreviewed: 1,
      unreviewedFacts: [{ sampleId: "required-facts", factId: "required-unreviewed" }],
    })
  })

  it("拒绝未知字段、重复样本和脱离结果的事实审阅", () => {
    expect(() =>
      evaluationDatasetSchema.parse({ formatVersion: 1, samples: [], extra: true }),
    ).toThrow()
    expect(() =>
      evaluationDatasetSchema.parse({
        formatVersion: 1,
        samples: [confirmedSample("same"), confirmedSample("same")],
      }),
    ).toThrow(/样本 id 不能重复/)

    const invalid = confirmedSample("invalid")
    invalid.result = null
    expect(() => evaluationDatasetSchema.parse({ formatVersion: 1, samples: [invalid] })).toThrow(
      /缺少 result 时不能填写事实审阅/,
    )
  })

  it("拒绝重复必保留事实及引用未定义事实的人工判定", () => {
    const sample = confirmedSample("invalid-required-facts")
    const withRequiredFacts = (requiredFacts: unknown[], requiredFactReviews: unknown[]) => ({
      ...sample,
      humanReview: {
        ...sample.humanReview,
        expectation: {
          ...sample.humanReview.expectation,
          requiredFacts,
          requiredFactReviews,
        },
      },
    })

    expect(() =>
      evaluationDatasetSchema.parse({
        formatVersion: 1,
        samples: [
          withRequiredFacts(
            [
              { factId: "same", statement: "事实一" },
              { factId: "same", statement: "事实二" },
            ],
            [{ factId: "same", presence: "present" }],
          ),
        ],
      }),
    ).toThrow(/requiredFacts 的 factId 不能重复/)

    expect(() =>
      evaluationDatasetSchema.parse({
        formatVersion: 1,
        samples: [
          withRequiredFacts(
            [{ factId: "defined", statement: "已定义事实" }],
            [
              { factId: "defined", presence: "present" },
              { factId: "defined", presence: "absent" },
            ],
          ),
        ],
      }),
    ).toThrow(/requiredFactReviews 的 factId 不能重复/)

    expect(() =>
      evaluationDatasetSchema.parse({
        formatVersion: 1,
        samples: [
          withRequiredFacts(
            [{ factId: "defined", statement: "已定义事实" }],
            [
              { factId: "defined", presence: "present" },
              { factId: "undefined", presence: "absent" },
            ],
          ),
        ],
      }),
    ).toThrow(/引用了未定义的 factId/)
  })
})
