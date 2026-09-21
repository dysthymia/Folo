import { presentationPolicySchema } from "@follow/information-core"
import { z } from "zod"

import { oneTimeToken } from "~/lib/auth"

import { informationRequestInit } from "./request-init"
import { getOneTimeToken, InformationLoadError } from "./session"

const isoDateTime = z.iso.datetime({ offset: true })
const auditSchema = z
  .object({
    cutoffAt: isoDateTime,
    maxSeq: z.number().int().nonnegative(),
    appliedRelease: z.number().int().nonnegative().nullable(),
    currentDecisionId: z.string().nullable(),
    storyRevision: z.number().int().positive().nullable(),
  })
  .strict()
const storySchema = z
  .object({
    id: z.string(),
    aggregationRuleId: z.string(),
    aggregationScopeVersion: z.string(),
    status: z.enum(["active", "merged", "split", "repairing"]),
    currentRevision: z.number().int().positive(),
    currentSubstantiveRevision: z.number().int().nonnegative(),
    mergedInto: z.string().nullable(),
    splitInto: z.array(z.string()),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict()
const decisionSchema = z
  .object({
    id: z.string(),
    status: z.enum(["keep", "hide", "needs_context"]),
    title: z.string(),
    summary: z.string(),
    reason: z.string(),
    labels: z.array(z.string()),
    policy: presentationPolicySchema,
  })
  .strict()
const readyEntrySchema = z
  .object({
    kind: z.literal("entry"),
    state: z.literal("ready"),
    ordinal: z.number().int().nonnegative(),
    inputSeq: z.number().int().positive(),
    sourceKey: z.string(),
    itemId: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    read: z.boolean().nullable(),
    receivedAt: isoDateTime,
    decision: decisionSchema,
    audit: auditSchema,
  })
  .strict()
const pendingEntrySchema = z
  .object({
    kind: z.literal("entry"),
    state: z.literal("pending"),
    ordinal: z.number().int().nonnegative(),
    inputSeq: z.number().int().positive(),
    sourceKey: z.string(),
    itemId: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    read: z.boolean().nullable(),
    receivedAt: isoDateTime,
    status: z.string(),
    decision: z.null(),
    audit: auditSchema,
  })
  .strict()
const readyStorySchema = z
  .object({
    kind: z.literal("story"),
    state: z.literal("ready"),
    ordinal: z.number().int().nonnegative(),
    story: storySchema,
    revision: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    audit: auditSchema,
  })
  .strict()
const repairingSchema = z
  .object({
    kind: z.enum(["entry", "story"]),
    state: z.literal("repairing"),
    ordinal: z.number().int().nonnegative(),
    inputSeq: z.number().int().positive().nullable(),
    storyId: z.string().nullable(),
    audit: auditSchema,
  })
  .strict()
export const readingSnapshotItemSchema = z.union([
  readyEntrySchema,
  pendingEntrySchema,
  readyStorySchema,
  repairingSchema,
])
export const readingSnapshotSchema = z
  .object({
    id: z.uuid(),
    cutoffAt: isoDateTime,
    maxSeq: z.number().int().nonnegative(),
    createdAt: isoDateTime,
    latestAvailable: z.boolean(),
  })
  .strict()
export const readingSnapshotResponseSchema = z.object({ snapshot: readingSnapshotSchema }).strict()
export const readingSnapshotPageSchema = z
  .object({
    snapshot: readingSnapshotSchema,
    view: z.enum(["smart", "standalone", "all", "hidden", "pending", "failed", "stories"]),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(50),
    total: z.number().int().nonnegative(),
    items: z.array(readingSnapshotItemSchema),
  })
  .strict()
const entryMetadataSchema = z
  .object({ sourceSyncedAt: isoDateTime.nullable(), listMembershipVersion: z.number().int() })
  .strict()
export const readingEntriesSchema = z
  .object({
    entries: z.array(
      z
        .object({
          seq: z.number().int().positive(),
          sourceKey: z.string().min(1),
          itemId: z.string().min(1),
          title: z.string(),
          url: z.string().nullable(),
          read: z.boolean().nullable(),
          receivedAt: isoDateTime,
          status: z.string().min(1),
          decision: decisionSchema.nullable(),
          reviewNeeded: z.boolean(),
          issueCount: z.number().int().nonnegative(),
          override: z
            .object({
              inputSeq: z.number().int().positive(),
              mode: z.enum(["automatic", "restore", "hide"]),
              revision: z.number().int().nonnegative(),
            })
            .strict(),
          metadata: entryMetadataSchema,
        })
        // 这里对应 ProcessingEntryListItem；显式保留正式字段，同时拒绝正文等未授权扩展。
        .strict(),
    ),
  })
  .strict()
const revisionSchema = z
  .object({
    storyId: z.string(),
    revision: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    aggregationRuleId: z.string(),
    aggregationScopeVersion: z.string(),
    appliedRuleSetVersion: z.number().int().positive(),
    instructionFingerprint: z.string(),
    substantiveRevision: z.number().int().nonnegative(),
    substantiveContentFingerprint: z.string(),
    displayFingerprint: z.string(),
    createdAt: isoDateTime,
    members: z.array(
      z.object({ inputSeq: z.number().int().positive(), decisionId: z.string() }).strict(),
    ),
    sourceSpans: z.array(
      z
        .object({
          id: z.string(),
          inputSeq: z.number().int().positive(),
          sourceItemId: z.string(),
          contentVersion: z.string(),
          fragmentId: z.string(),
          quote: z.string(),
          sourceRole: z.string(),
        })
        .strict(),
    ),
    citations: z.array(
      z.object({ id: z.string(), sourceSpanId: z.string(), sentenceId: z.string() }).strict(),
    ),
    sentences: z.array(
      z.object({ id: z.string(), text: z.string(), citationIds: z.array(z.string()) }).strict(),
    ),
    facts: z.array(
      z
        .object({
          id: z.string(),
          kind: z.enum(["fact", "source_claim", "inference"]),
          text: z.string(),
          citationIds: z.array(z.string()),
          dependsOnFactIds: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict()
const storyLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current"), story: storySchema, revision: revisionSchema }),
  z.object({ kind: z.literal("merged"), story: storySchema, mergedInto: z.string() }),
  z.object({ kind: z.literal("split"), story: storySchema, splitInto: z.array(z.string()) }),
  z.object({ kind: z.literal("repairing"), story: storySchema }),
  z.object({ kind: z.literal("independent"), story: storySchema, reason: z.string() }),
  z.object({ kind: z.literal("missing") }),
])
export const readingStorySchema = storyLinkSchema
const researchPackReferenceSchema = z
  .object({
    inputSeq: z.number().int().positive(),
    sourceKey: z.string(),
    itemId: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    quote: z.string(),
  })
  .strict()
export const researchPackSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    storyId: z.string(),
    revision: z.number().int().positive(),
    title: z.string(),
    markdown: z.string(),
    references: z.array(researchPackReferenceSchema),
  }),
  z.object({
    status: z.enum(["repairing", "missing"]),
    storyId: z.string(),
    revision: z.null(),
    title: z.null(),
    markdown: z.null(),
    references: z.array(researchPackReferenceSchema).length(0),
  }),
])
const mutationResultSchema = z
  .object({
    inputSeq: z.number().int().positive(),
    mode: z.enum(["automatic", "restore", "hide"]),
    revision: z.number().int().positive(),
  })
  .strict()
const retryResultSchema = z
  .object({ inputSeq: z.number().int().positive(), status: z.string().min(1) })
  .strict()
const readResultSchema = z
  .object({
    storyId: z.string(),
    readStatus: z
      .object({
        readSubstantiveRevision: z.number().int().nonnegative(),
        unread: z.boolean(),
      })
      .strict(),
  })
  .strict()
const correctionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["member_removed", "material_withdrawn", "merged", "split", "undo"]),
    storyIds: z.array(z.string()),
    baseRevisions: z.record(z.string(), z.number().int().positive()),
    payload: z.record(z.string(), z.unknown()),
    undoOf: z.string().nullable(),
    undoneBy: z.string().nullable(),
    createdAt: isoDateTime,
  })
  .strict()
const mergeResultSchema = z
  .object({ correction: correctionSchema, revision: revisionSchema })
  .strict()
const splitResultSchema = z.union([
  z.object({ correction: correctionSchema, childIds: z.array(z.uuid()) }).strict(),
  z.object({ correction: correctionSchema, revisions: z.array(revisionSchema) }).strict(),
])
const withdrawalResultSchema = correctionSchema

export type ReadingSnapshot = z.infer<typeof readingSnapshotSchema>
export type ReadingSnapshotItem = z.infer<typeof readingSnapshotItemSchema>

export function readingEntryPresentation(
  item: { title: string; decision: { id: string; title: string; summary: string } },
  review: {
    decision: { id: string } | null
    reviewNeeded: boolean
    issueCount: number
  } | null,
) {
  // 反馈必须命中快照展示的同一 decision；旧决定反馈不能覆盖新摘要。
  const reviewNeeded = Boolean(
    review?.reviewNeeded && review.decision?.id === item.decision.id && review.issueCount > 0,
  )
  return reviewNeeded
    ? {
        title: item.title,
        summary: null,
        summaryKey: "processing.reader.review_needed" as const,
        aiSummary: item.decision.summary,
        issueCount: review!.issueCount,
      }
    : {
        title: item.decision.title,
        summary: item.decision.summary,
        summaryKey: null,
        aiSummary: null,
        issueCount: 0,
      }
}

export function readingPendingMessageKey(status: string) {
  // 主列表直接区分处理状态，避免失败条目继续显示为排队中。
  if (status === "failed") return "processing.reader.pending_failed" as const
  if (status === "running") return "processing.reader.pending_running" as const
  return "processing.reader.pending" as const
}
export type ReadingSnapshotPage = z.infer<typeof readingSnapshotPageSchema>
export type ReadingEntry = Extract<ReadingSnapshotItem, { kind: "entry" }>
export type ReadingStory = z.infer<typeof storyLinkSchema>
export type ReadingStories = ReadingStory[]
export type ReadingView = ReadingSnapshotPage["view"]
export type ReadingEntryOverride = z.infer<typeof readingEntriesSchema>["entries"][number]
export type ResearchPack = z.infer<typeof researchPackSchema>
export type ReadingMutation =
  | z.infer<typeof mutationResultSchema>
  | z.infer<typeof retryResultSchema>
  | z.infer<typeof readResultSchema>
  | z.infer<typeof correctionSchema>

export class ReadingRequestError extends Error {
  constructor(readonly kind: "authorization" | "conflict" | "request") {
    super(kind)
    this.name = "ReadingRequestError"
  }
}

export async function readingRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  body?: object,
): Promise<T> {
  const token = await oneTimeToken
    .generate()
    .then(getOneTimeToken)
    .catch((error: unknown) => {
      throw new ReadingRequestError(
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
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        "X-Folo-One-Time-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  if (!response.ok)
    throw new ReadingRequestError(
      [401, 403].includes(response.status)
        ? "authorization"
        : response.status === 409
          ? "conflict"
          : "request",
    )
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) throw new ReadingRequestError("request")
  signal.throwIfAborted()
  return parsed.data
}

export const loadReadingSnapshot = (signal: AbortSignal) =>
  readingRequest("reading-snapshot", readingSnapshotResponseSchema, signal)
export const refreshReadingSnapshot = (signal: AbortSignal) =>
  readingRequest("reading-snapshot/refresh", readingSnapshotResponseSchema, signal, {})
export const loadReadingSnapshotPage = (
  snapshotId: string,
  view: ReadingView,
  offset: number,
  signal: AbortSignal,
) =>
  readingRequest("reading-snapshot", readingSnapshotPageSchema, signal, {
    snapshotId,
    view,
    offset,
    limit: 50,
  })
export const loadEntryOverrides = async (signal: AbortSignal) => {
  const response = await readingRequest("processing/entries", readingEntriesSchema, signal)
  return new Map(response.entries.map((entry) => [entry.seq, entry]))
}
export const loadResearchPack = (storyId: string, signal: AbortSignal) =>
  readingRequest(`research-pack/${encodeURIComponent(storyId)}`, researchPackSchema, signal)

export const mutationSchemas = {
  override: mutationResultSchema,
  retry: retryResultSchema,
  read: readResultSchema,
  correction: correctionSchema,
  merge: mergeResultSchema,
  split: splitResultSchema,
  withdraw: withdrawalResultSchema,
} as const
