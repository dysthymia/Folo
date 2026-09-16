import { z } from "zod"

const originalSchema = z
  .object({
    sourceKey: z.string().min(1),
    itemId: z.string().min(1),
    contentVersion: z.string().min(1),
  })
  .strict()

const factReviewSchema = z
  .object({
    factId: z.string().min(1),
    supported: z.boolean(),
    citationSupported: z.boolean().nullable(),
  })
  .strict()

const requiredFactSchema = z
  .object({
    factId: z.string().min(1),
    statement: z.string().min(1),
  })
  .strict()

const requiredFactReviewSchema = z
  .object({
    factId: z.string().min(1),
    presence: z.enum(["present", "absent", "unreviewed"]),
  })
  .strict()

const expectationSchema = z
  .object({
    disposition: z.enum(["keep", "hide"]),
    aggregation: z.enum(["allow", "deny"]),
    rewrite: z.enum(["allow", "deny"]),
    important: z.boolean(),
    eventId: z.string().min(1).nullable(),
    factReviews: z.array(factReviewSchema),
    requiredFacts: z.array(requiredFactSchema).optional(),
    requiredFactReviews: z.array(requiredFactReviewSchema).optional(),
  })
  .strict()

const humanReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), expectation: expectationSchema }).strict(),
  z.object({ status: z.literal("disputed") }).strict(),
  z.object({ status: z.literal("unreviewed") }).strict(),
])

const resultSchema = z
  .object({
    disposition: z.enum(["keep", "hide", "needs_context"]),
    aggregation: z.enum(["allow", "deny"]),
    rewrite: z.enum(["allow", "deny"]),
    eventId: z.string().min(1).nullable(),
    factIds: z.array(z.string().min(1)),
  })
  .strict()

export const evaluationSampleSchema = z
  .object({
    id: z.string().min(1),
    original: originalSchema,
    partition: z.enum(["dev", "heldout"]),
    humanReview: humanReviewSchema,
    result: resultSchema.nullable(),
  })
  .strict()
  .superRefine((sample, context) => {
    if (sample.result && new Set(sample.result.factIds).size !== sample.result.factIds.length) {
      context.addIssue({
        code: "custom",
        message: "result.factIds 不能重复",
        path: ["result", "factIds"],
      })
    }

    if (sample.humanReview.status !== "confirmed") return

    const factReviews = sample.humanReview.expectation.factReviews
    if (new Set(factReviews.map((review) => review.factId)).size !== factReviews.length) {
      context.addIssue({
        code: "custom",
        message: "humanReview.expectation.factReviews 的 factId 不能重复",
        path: ["humanReview", "expectation", "factReviews"],
      })
    }

    const requiredFacts = sample.humanReview.expectation.requiredFacts
    const requiredFactReviews = sample.humanReview.expectation.requiredFactReviews
    if (requiredFacts || requiredFactReviews) {
      const factIds = requiredFacts?.map((fact) => fact.factId) ?? []
      const reviewedFactIds = requiredFactReviews?.map((review) => review.factId) ?? []
      const definedFactIds = new Set(factIds)

      if (definedFactIds.size !== factIds.length) {
        context.addIssue({
          code: "custom",
          message: "requiredFacts 的 factId 不能重复",
          path: ["humanReview", "expectation", "requiredFacts"],
        })
      }
      if (new Set(reviewedFactIds).size !== reviewedFactIds.length) {
        context.addIssue({
          code: "custom",
          message: "requiredFactReviews 的 factId 不能重复",
          path: ["humanReview", "expectation", "requiredFactReviews"],
        })
      }
      requiredFactReviews?.forEach((review, index) => {
        if (!definedFactIds.has(review.factId)) {
          context.addIssue({
            code: "custom",
            message: "必保留事实审阅引用了未定义的 factId",
            path: ["humanReview", "expectation", "requiredFactReviews", index, "factId"],
          })
        }
        if (!sample.result && review.presence !== "unreviewed") {
          context.addIssue({
            code: "custom",
            message: "缺少 result 时必保留事实只能标记为 unreviewed",
            path: ["humanReview", "expectation", "requiredFactReviews", index, "presence"],
          })
        }
      })
      factIds.forEach((factId, index) => {
        if (!reviewedFactIds.includes(factId)) {
          context.addIssue({
            code: "custom",
            message: "每项必保留事实都必须有人工 present、absent 或 unreviewed 判定",
            path: ["humanReview", "expectation", "requiredFacts", index, "factId"],
          })
        }
      })
    }

    if (!sample.result && factReviews.length > 0) {
      context.addIssue({
        code: "custom",
        message: "缺少 result 时不能填写事实审阅",
        path: ["humanReview", "expectation", "factReviews"],
      })
      return
    }

    const resultFactIds = new Set(sample.result?.factIds ?? [])
    factReviews.forEach((review, index) => {
      if (!resultFactIds.has(review.factId)) {
        context.addIssue({
          code: "custom",
          message: "事实审阅必须引用 result.factIds 中的事实",
          path: ["humanReview", "expectation", "factReviews", index, "factId"],
        })
      }
    })
  })

export const evaluationDatasetSchema = z
  .object({
    formatVersion: z.literal(1),
    samples: z.array(evaluationSampleSchema),
  })
  .strict()
  .superRefine((dataset, context) => {
    const seen = new Set<string>()
    dataset.samples.forEach((sample, index) => {
      if (seen.has(sample.id)) {
        context.addIssue({
          code: "custom",
          message: "样本 id 不能重复",
          path: ["samples", index, "id"],
        })
      }
      seen.add(sample.id)
    })
  })

export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>
type EvaluationSample = z.infer<typeof evaluationSampleSchema>
type ConfirmedSample = EvaluationSample & {
  humanReview: Extract<EvaluationSample["humanReview"], { status: "confirmed" }>
}
type EvaluatedSample = ConfirmedSample & { result: NonNullable<EvaluationSample["result"]> }

interface ErrorMetric {
  denominator: number
  errors: number
  errorSampleIds: string[]
}

interface PairError {
  sampleIds: [string, string]
}

interface FactError {
  sampleId: string
  factId: string
}

export interface EvaluationPartitionReport {
  samples: {
    total: number
    confirmed: number
    disputed: number
    unreviewed: number
  }
  exclusions: {
    disputedSampleIds: string[]
    unreviewedSampleIds: string[]
    missingResultSampleIds: string[]
  }
  disposition: ErrorMetric
  aggregationPermission: ErrorMetric
  rewritePermission: ErrorMetric
  importantFalseHide: ErrorMetric
  eventPairs: {
    denominator: number
    expectedSameEventPairs: number
    expectedDifferentEventPairs: number
    wrongMerges: number
    missedMerges: number
    wrongMergePairs: PairError[]
    missedMergePairs: PairError[]
  }
  humanFactSupport: {
    denominator: number
    supported: number
    unsupported: number
    unsupportedFacts: FactError[]
  }
  humanCitationSupport: {
    denominator: number
    supported: number
    unsupported: number
    unsupportedCitations: FactError[]
  }
  humanRequiredFactPresence: {
    denominator: number
    present: number
    missing: number
    missingFacts: FactError[]
    unreviewed: number
    unreviewedFacts: FactError[]
  }
}

export interface EvaluationReport {
  formatVersion: 1
  sampleCount: number
  partitions: Record<"dev" | "heldout", EvaluationPartitionReport>
}

function errorMetric(
  samples: EvaluatedSample[],
  mismatch: (sample: EvaluatedSample) => boolean,
): ErrorMetric {
  const errorSampleIds = samples.filter(mismatch).map((sample) => sample.id)
  return {
    denominator: samples.length,
    errors: errorSampleIds.length,
    errorSampleIds,
  }
}

function evaluatePartition(samples: EvaluationSample[]): EvaluationPartitionReport {
  const ordered = [...samples].sort((left, right) => left.id.localeCompare(right.id))
  const confirmed = ordered.filter(
    (sample): sample is ConfirmedSample => sample.humanReview.status === "confirmed",
  )
  const evaluated = confirmed.filter((sample): sample is EvaluatedSample => sample.result !== null)
  const importantExpectedKeep = evaluated.filter(
    (sample) =>
      sample.humanReview.expectation.important &&
      sample.humanReview.expectation.disposition === "keep",
  )

  const wrongMergePairs: PairError[] = []
  const missedMergePairs: PairError[] = []
  let expectedSameEventPairs = 0
  let expectedDifferentEventPairs = 0
  for (let leftIndex = 0; leftIndex < evaluated.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < evaluated.length; rightIndex += 1) {
      const left = evaluated[leftIndex]!
      const right = evaluated[rightIndex]!
      const expectedEventId = left.humanReview.expectation.eventId
      const expectedSame =
        expectedEventId !== null && expectedEventId === right.humanReview.expectation.eventId
      const predictedEventId = left.result.eventId
      const predictedSame = predictedEventId !== null && predictedEventId === right.result.eventId
      const pair: PairError = { sampleIds: [left.id, right.id] }

      if (expectedSame) expectedSameEventPairs += 1
      else expectedDifferentEventPairs += 1
      if (predictedSame && !expectedSame) wrongMergePairs.push(pair)
      if (expectedSame && !predictedSame) missedMergePairs.push(pair)
    }
  }

  const unsupportedFacts: FactError[] = []
  const unsupportedCitations: FactError[] = []
  const missingRequiredFacts: FactError[] = []
  const unreviewedRequiredFacts: FactError[] = []
  let factDenominator = 0
  let supportedFacts = 0
  let citationDenominator = 0
  let supportedCitations = 0
  let requiredFactDenominator = 0
  let presentRequiredFacts = 0
  for (const sample of evaluated) {
    for (const review of sample.humanReview.expectation.factReviews) {
      factDenominator += 1
      if (review.supported) supportedFacts += 1
      else unsupportedFacts.push({ sampleId: sample.id, factId: review.factId })

      if (review.citationSupported === null) continue
      citationDenominator += 1
      if (review.citationSupported) supportedCitations += 1
      else unsupportedCitations.push({ sampleId: sample.id, factId: review.factId })
    }
  }

  // 缺少模型结果的必保留事实也保留 unreviewed 记录，但不进入确定分母。
  for (const sample of confirmed) {
    for (const review of sample.humanReview.expectation.requiredFactReviews ?? []) {
      if (review.presence === "unreviewed") {
        unreviewedRequiredFacts.push({ sampleId: sample.id, factId: review.factId })
        continue
      }
      requiredFactDenominator += 1
      if (review.presence === "present") presentRequiredFacts += 1
      else missingRequiredFacts.push({ sampleId: sample.id, factId: review.factId })
    }
  }

  return {
    samples: {
      total: ordered.length,
      confirmed: confirmed.length,
      disputed: ordered.filter((sample) => sample.humanReview.status === "disputed").length,
      unreviewed: ordered.filter((sample) => sample.humanReview.status === "unreviewed").length,
    },
    exclusions: {
      disputedSampleIds: ordered
        .filter((sample) => sample.humanReview.status === "disputed")
        .map((sample) => sample.id),
      unreviewedSampleIds: ordered
        .filter((sample) => sample.humanReview.status === "unreviewed")
        .map((sample) => sample.id),
      missingResultSampleIds: confirmed
        .filter((sample) => sample.result === null)
        .map((sample) => sample.id),
    },
    disposition: errorMetric(
      evaluated,
      (sample) => sample.result.disposition !== sample.humanReview.expectation.disposition,
    ),
    aggregationPermission: errorMetric(
      evaluated,
      (sample) => sample.result.aggregation !== sample.humanReview.expectation.aggregation,
    ),
    rewritePermission: errorMetric(
      evaluated,
      (sample) => sample.result.rewrite !== sample.humanReview.expectation.rewrite,
    ),
    importantFalseHide: errorMetric(
      importantExpectedKeep,
      (sample) => sample.result.disposition === "hide",
    ),
    eventPairs: {
      denominator: (evaluated.length * (evaluated.length - 1)) / 2,
      expectedSameEventPairs,
      expectedDifferentEventPairs,
      wrongMerges: wrongMergePairs.length,
      missedMerges: missedMergePairs.length,
      wrongMergePairs,
      missedMergePairs,
    },
    humanFactSupport: {
      denominator: factDenominator,
      supported: supportedFacts,
      unsupported: unsupportedFacts.length,
      unsupportedFacts,
    },
    humanCitationSupport: {
      denominator: citationDenominator,
      supported: supportedCitations,
      unsupported: unsupportedCitations.length,
      unsupportedCitations,
    },
    humanRequiredFactPresence: {
      denominator: requiredFactDenominator,
      present: presentRequiredFacts,
      missing: missingRequiredFacts.length,
      missingFacts: missingRequiredFacts,
      unreviewed: unreviewedRequiredFacts.length,
      unreviewedFacts: unreviewedRequiredFacts,
    },
  }
}

/** 只根据固定样本和人工标注计算指标，不推断质量结论。 */
export function evaluateDataset(input: unknown): EvaluationReport {
  const dataset = evaluationDatasetSchema.parse(input)
  return {
    formatVersion: 1,
    sampleCount: dataset.samples.length,
    partitions: {
      dev: evaluatePartition(dataset.samples.filter((sample) => sample.partition === "dev")),
      heldout: evaluatePartition(
        dataset.samples.filter((sample) => sample.partition === "heldout"),
      ),
    },
  }
}
