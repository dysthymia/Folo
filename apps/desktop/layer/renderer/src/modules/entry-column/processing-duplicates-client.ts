import { z } from "zod"

import { readingRequest } from "~/modules/information/processing-reader-client"

const memberSchema = z
  .object({
    itemId: z.string().min(1),
    inputSeq: z.number().int().positive().nullable(),
    contentVersion: z.string().nullable(),
    title: z.string().nullable(),
    sourceTitle: z.string().nullable(),
    publishedAt: z.string().nullable(),
    url: z.string().nullable(),
    reason: z.string().nullable(),
    canRestore: z.boolean(),
    overrideRevision: z.number().int().nonnegative().nullable(),
  })
  .strict()

export const duplicateGroupSchema = z
  .object({
    representative: memberSchema,
    members: z.array(memberSchema),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>

/** 分页沿用首屏组版本，服务端拒绝把两次不同的组关系拼在一起。 */
export const loadDuplicateGroup = (
  inputSeq: number,
  signal: AbortSignal,
  page?: { offset: number; expectedFingerprint: string },
) =>
  readingRequest(
    `processing/entries/${inputSeq}/duplicates`,
    duplicateGroupSchema,
    signal,
    page ? { ...page, limit: 20 } : undefined,
  )
