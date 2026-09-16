import { z } from "zod"

import { oneTimeToken } from "~/lib/auth"

import { informationRequestInit } from "./request-init"
import { getOneTimeToken, InformationLoadError } from "./session"

const isoDateTime = z.iso.datetime({ offset: true })
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("story"), storyId: z.uuid() }).strict(),
  z.object({ kind: z.literal("entry"), inputSeq: z.number().int().positive() }).strict(),
])
export const researchPackSchema = z
  .object({
    id: z.uuid(),
    revision: z.number().int().positive(),
    status: z.enum(["prepared", "submitted", "completed"]),
    target: targetSchema,
    question: z.string(),
    goal: z.string(),
    knownQuestions: z.array(z.string()),
    title: z.string(),
    markdown: z.string(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    submissionReference: z.string().nullable(),
    resultReference: z.string().nullable(),
  })
  .strict()
export const researchPacksResponseSchema = z.object({ packs: z.array(researchPackSchema) }).strict()
export const researchPackResponseSchema = z.object({ pack: researchPackSchema }).strict()
export type ResearchPack = z.infer<typeof researchPackSchema>
export type ResearchTarget = z.infer<typeof targetSchema>

export class ResearchRequestError extends Error {
  constructor(readonly kind: "authorization" | "conflict" | "request") {
    super(kind)
    this.name = "ResearchRequestError"
  }
}

async function request<T>(
  path: string,
  method: "GET" | "POST" | "PUT",
  schema: z.ZodType<T>,
  signal: AbortSignal,
  body?: object,
): Promise<T> {
  const token = await oneTimeToken
    .generate()
    .then(getOneTimeToken)
    .catch((error: unknown) => {
      throw new ResearchRequestError(
        error instanceof InformationLoadError &&
          ["authorization", "account_mismatch"].includes(error.kind)
          ? "authorization"
          : "request",
      )
    })
  signal.throwIfAborted()
  const response = await fetch(
    `/information/v1/${path}`,
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
    throw new ResearchRequestError(
      [401, 403].includes(response.status)
        ? "authorization"
        : response.status === 409
          ? "conflict"
          : "request",
    )
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) throw new ResearchRequestError("request")
  signal.throwIfAborted()
  return parsed.data
}

export const loadResearchPacks = (signal: AbortSignal) =>
  request("research-packs", "GET", researchPacksResponseSchema, signal)
export const loadResearchPackById = (id: string, signal: AbortSignal) =>
  request(`research-packs/${encodeURIComponent(id)}`, "GET", researchPackResponseSchema, signal)
export const prepareResearchPack = (
  input: {
    target: ResearchTarget
    question: string
    goal: string
    knownQuestions: string[]
  },
  signal: AbortSignal,
) => request("research-packs", "POST", researchPackResponseSchema, signal, input)
export const transitionResearchPack = (
  id: string,
  input: { expectedRevision: number; status: "submitted" | "completed"; reference: string },
  signal: AbortSignal,
) =>
  request(
    `research-packs/${encodeURIComponent(id)}`,
    "PUT",
    researchPackResponseSchema,
    signal,
    input,
  )
