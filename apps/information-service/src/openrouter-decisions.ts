import { z } from "zod"

import { DECISIONS_CANONICAL_MODEL, DECISIONS_ENDPOINT, DECISIONS_MODEL } from "./decisions-config"

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
const probability = z.number().finite().min(0).max(1)
const optionalMetrics = {
  confidence: probability.optional(),
  probabilities: z.record(z.string(), probability).optional(),
}
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability, ...optionalMetrics }),
  z.object({ type: z.literal("choice"), choice: z.string(), ...optionalMetrics }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite().nonnegative(),
    legend: z.record(z.string(), z.string()).optional(),
    ...optionalMetrics,
  }),
])
export type DecisionAnswer = z.infer<typeof answerSchema>
export const decisionsUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost: z.number().finite().nonnegative().nullable().optional(),
})
export type DecisionsUsage = z.infer<typeof decisionsUsageSchema>
const responseSchema = z.object({
  id: z.string().optional(),
  model: z.enum([DECISIONS_MODEL, DECISIONS_CANONICAL_MODEL]),
  provider: z.literal("OpenAI"),
  answers: z.record(z.string(), answerSchema),
  usage: decisionsUsageSchema,
})
export class DecisionsError extends Error {
  constructor(
    public readonly code: "request_limit" | "invalid_response" | "http_error" | "network_error",
    public readonly usage: DecisionsUsage | null = null,
    public readonly status?: number,
  ) {
    super(code)
  }
}

export function parseDecisionsResponse(
  value: unknown,
  questions: Record<string, DecisionQuestion>,
) {
  const usage = z.object({ usage: decisionsUsageSchema }).safeParse(value)
  const invalid = () =>
    new DecisionsError("invalid_response", usage.success ? usage.data.usage : null)
  const rejected = (answer: unknown) =>
    typeof answer === "object" && answer !== null && ("error" in answer || "refusal" in answer)
  const raw = z.object({ answers: z.record(z.string(), z.unknown()) }).safeParse(value)
  const parsed = responseSchema.safeParse(value)
  if (
    !parsed.success ||
    rejected(value) ||
    (raw.success && Object.values(raw.data.answers).some(rejected))
  )
    throw invalid()
  const expected = Object.keys(questions)
  if (
    expected.length !== Object.keys(parsed.data.answers).length ||
    expected.some((id) => !Object.hasOwn(parsed.data.answers, id))
  )
    throw invalid()
  for (const [id, question] of Object.entries(questions)) {
    const answer = parsed.data.answers[id]!
    if (answer.type !== question.type) throw invalid()
    const options =
      question.type === "score"
        ? question.criteria.map((_, index) => String(index))
        : question.type === "choice"
          ? Object.keys(question.criteria)
          : ["true", "false"]
    if (question.type === "choice" && answer.type === "choice" && !options.includes(answer.choice))
      throw invalid()
    if (question.type === "score" && answer.type === "score") {
      if (answer.score > question.criteria.length - 1) throw invalid()
      if (
        answer.legend &&
        (Object.keys(answer.legend).length !== options.length ||
          options.some((key) => answer.legend?.[key] !== question.criteria[Number(key)]))
      )
        throw invalid()
    }
    if (
      answer.probabilities &&
      (Object.keys(answer.probabilities).some((key) => !options.includes(key)) ||
        Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.01)
    )
      throw invalid()
    if (answer.probabilities) {
      if (answer.type === "score") {
        const weighted = Object.entries(answer.probabilities).reduce(
          (sum, [key, p]) => sum + Number(key) * p,
          0,
        )
        if (Math.abs(answer.score - weighted) > 0.02) throw invalid()
      } else if (
        answer.type === "noul" &&
        Math.abs(answer.noul - (answer.probabilities.true ?? 0)) > 0.01
      )
        throw invalid()
    }
  }
  return parsed.data
}

export function serializeDecisionsRequest(input: {
  state: Record<string, unknown>
  questions: Record<string, DecisionQuestion>
}) {
  const body = JSON.stringify({
    model: DECISIONS_MODEL,
    state: input.state,
    questions: input.questions,
  })
  const count = Object.keys(input.questions).length
  if (!count || count > 200 || Buffer.byteLength(body, "utf8") > 128 * 1024)
    throw new DecisionsError("request_limit")
  return body
}

export async function requestDecisions(input: {
  apiKey: string
  state: Record<string, unknown>
  questions: Record<string, DecisionQuestion>
  signal: AbortSignal
  fetcher?: (url: string, init: RequestInit) => Promise<Response>
}) {
  const body = serializeDecisionsRequest(input)
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
  let response: Response
  try {
    response = await (input.fetcher ?? fetch)(DECISIONS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body,
      signal,
      redirect: "error",
    })
  } catch {
    // Never expose transport errors, which may contain credentials or article text.
    throw new DecisionsError("network_error")
  }
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const usage = z.object({ usage: decisionsUsageSchema }).safeParse(value)
    throw new DecisionsError("http_error", usage.success ? usage.data.usage : null, response.status)
  }
  return parseDecisionsResponse(value, input.questions)
}
