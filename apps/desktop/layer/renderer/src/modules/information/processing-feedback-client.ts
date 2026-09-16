import { z } from "zod"

import { oneTimeToken } from "~/lib/auth"

import { informationRequestInit } from "./request-init"
import { getOneTimeToken, InformationLoadError } from "./session"

const isoDateTime = z.iso.datetime({ offset: true })
const feedbackKindSchema = z.enum([
  "should_keep",
  "wrong_merge",
  "should_merge",
  "missing_point",
  "unsupported_citation",
  "rule_exception",
  "value",
  "known",
  "irrelevant",
])
const entryTargetSchema = z
  .object({
    kind: z.literal("entry"),
    inputSeq: z.number().int().positive(),
    sourceKey: z.string(),
    itemId: z.string(),
    contentVersion: z.string(),
    decisionId: z.string().nullable(),
    releaseVersion: z.number().int().nonnegative().nullable(),
  })
  .strict()
const storyTargetSchema = z
  .object({
    kind: z.literal("story"),
    storyId: z.uuid(),
    storyRevision: z.number().int().positive(),
    decisionIds: z.array(z.string()),
    releaseVersions: z.array(z.number().int().nonnegative()),
  })
  .strict()
const feedbackTargetSchema = z.union([entryTargetSchema, storyTargetSchema])
const suggestionSchema = z
  .object({ status: z.literal("proposed"), userText: z.string(), prompt: z.string() })
  .strict()
const feedbackSchema = z
  .object({
    id: z.uuid(),
    kind: feedbackKindSchema,
    target: feedbackTargetSchema,
    explanation: z.string().nullable(),
    referenceIds: z.array(z.string()),
    suggestion: suggestionSchema.nullable(),
    createdAt: isoDateTime,
  })
  .strict()
export const feedbackResponseSchema = z.object({ feedback: z.array(feedbackSchema) }).strict()
export const feedbackRecordResponseSchema = z.object({ feedback: feedbackSchema }).strict()
export type FeedbackKind = z.infer<typeof feedbackKindSchema>
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>
export type ProcessingFeedback = z.infer<typeof feedbackSchema>

export class FeedbackRequestError extends Error {
  constructor(readonly kind: "authorization" | "conflict" | "request") {
    super(kind)
    this.name = "FeedbackRequestError"
  }
}

type FeedbackInput = {
  kind: FeedbackKind
  explanation?: string
  suggestion?: string
  referenceIds?: string[]
  target:
    | { kind: "entry"; inputSeq: number; expectedDecisionId: string | null }
    | { kind: "story"; storyId: string; storyRevision: number }
}
export type NewFeedback = FeedbackInput

async function request<T>(
  method: "GET" | "POST",
  schema: z.ZodType<T>,
  signal: AbortSignal,
  body?: object,
) {
  const token = await oneTimeToken
    .generate()
    .then(getOneTimeToken)
    .catch((error: unknown) => {
      throw new FeedbackRequestError(
        error instanceof InformationLoadError &&
          ["authorization", "account_mismatch"].includes(error.kind)
          ? "authorization"
          : "request",
      )
    })
  signal.throwIfAborted()
  const response = await fetch(
    "/information/v1/feedback",
    informationRequestInit({
      method,
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "X-Folo-One-Time-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  if (!response.ok)
    throw new FeedbackRequestError(
      [401, 403].includes(response.status)
        ? "authorization"
        : response.status === 409 || response.status === 400
          ? "conflict"
          : "request",
    )
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) throw new FeedbackRequestError("request")
  signal.throwIfAborted()
  return parsed.data
}

export const loadProcessingFeedback = (signal: AbortSignal) =>
  request("GET", feedbackResponseSchema, signal)
export const saveProcessingFeedback = (input: FeedbackInput, signal: AbortSignal) =>
  request("POST", feedbackRecordResponseSchema, signal, input)
