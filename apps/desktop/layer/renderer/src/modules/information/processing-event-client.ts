import { z } from "zod"

import { readingRequest } from "./processing-reader-client"

export const eventRoles = ["reports", "analysis_of", "tutorial_for", "mentions"] as const
export const eventRoleSchema = z.enum(eventRoles)
const positiveInteger = z.number().int().positive()
export const processingEventSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    aliases: z.array(z.string()),
    status: z.enum(["candidate", "confirmed", "merged", "split"]),
    revision: positiveInteger,
    mergedInto: z.string().nullable(),
    splitInto: z.array(z.string()),
  })
  .passthrough()
const membershipFields = {
  mentionId: z.string().min(1),
  role: eventRoleSchema,
  isPrimary: z.boolean(),
  state: z.enum(["confirmed", "candidate", "excluded"]),
  evidence: z.array(z.string()),
}
export const entryEventsSchema = z
  .object({
    inputSeq: positiveInteger,
    contentVersion: z.string().min(1),
    decisionId: z.string().nullable(),
    events: z.array(z.object({ event: processingEventSchema, ...membershipFields }).passthrough()),
  })
  .passthrough()
export const eventDetailSchema = z
  .object({
    event: processingEventSchema,
    stories: z.array(
      z.object({ id: z.string(), title: z.string(), revision: positiveInteger }).passthrough(),
    ),
  })
  .passthrough()
export const eventMembersSchema = z
  .object({
    snapshotId: z.uuid(),
    rows: z.array(
      z
        .object({
          inputSeq: positiveInteger,
          sourceKey: z.string(),
          itemId: z.string(),
          title: z.string(),
          url: z.string().nullable(),
          publishedAt: z.string(),
          contentVersion: z.string(),
          decisionId: z.string().nullable(),
          ...membershipFields,
        })
        .passthrough(),
    ),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .passthrough()
const eventMemberTarget = z
  .object({ inputSeq: positiveInteger, mentionId: z.string().min(1) })
  .strict()
export const eventCorrectionActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename"), title: z.string().trim().min(1).max(500) }).strict(),
  eventMemberTarget.extend({ type: z.literal("exclude") }).strict(),
  eventMemberTarget.extend({ type: z.literal("move"), targetEventId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("merge"), targetEventId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("split"),
      groups: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(500),
              members: z.array(eventMemberTarget).min(1),
            })
            .strict(),
        )
        .min(2),
    })
    .strict(),
  z.object({ type: z.literal("undo"), correctionId: z.uuid() }).strict(),
])
export const eventSearchSchema = z
  .object({
    snapshotId: z.uuid(),
    events: z.array(processingEventSchema),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .passthrough()
const correctionResponseSchema = z
  .object({
    event: processingEventSchema,
    correctionId: z.uuid(),
    events: z.array(processingEventSchema).optional(),
  })
  .passthrough()
export type EventSearch = z.infer<typeof eventSearchSchema>
export type EventSearchQuery = {
  search?: string
  snapshotId?: string
  offset?: number
  limit?: number
}
export type ProcessingEvent = z.infer<typeof processingEventSchema>
export type EventRole = z.infer<typeof eventRoleSchema>
export type EntryEvents = z.infer<typeof entryEventsSchema>
export type EventDetail = z.infer<typeof eventDetailSchema>
export type EventMembers = z.infer<typeof eventMembersSchema>
export type EventCorrectionAction = z.infer<typeof eventCorrectionActionSchema>
export type EventMemberQuery = {
  role?: EventRole
  state?: "confirmed" | "candidate"
  snapshotId?: string
  offset?: number
  limit?: number
}

export const searchProcessingEvents = async (query: EventSearchQuery, signal: AbortSignal) =>
  readingRequest("processing/events", eventSearchSchema, signal, query)

export const loadEntryEvents = async (inputSeq: number, signal: AbortSignal) =>
  readingRequest(`processing/entries/${inputSeq}/events`, entryEventsSchema, signal)
export const loadEventDetail = async (eventId: string, signal: AbortSignal) =>
  readingRequest(`processing/events/${encodeURIComponent(eventId)}`, eventDetailSchema, signal)
export const loadEventMembers = async (
  eventId: string,
  query: EventMemberQuery,
  signal: AbortSignal,
) =>
  readingRequest(
    `processing/events/${encodeURIComponent(eventId)}/members`,
    eventMembersSchema,
    signal,
    query,
  )
export const correctProcessingEvent = async (
  eventId: string,
  expectedRevisions: Record<string, number>,
  action: EventCorrectionAction,
  signal: AbortSignal,
) =>
  // 只提交明确的事件和mention身份，旧修订冲突不能覆盖最新人工判断。
  readingRequest(
    `processing/events/${encodeURIComponent(eventId)}/corrections`,
    correctionResponseSchema,
    signal,
    {
      requestId: crypto.randomUUID(),
      expectedRevisions,
      action: eventCorrectionActionSchema.parse(action),
    },
  )
