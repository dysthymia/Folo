import { z } from "zod"

import { generatedItemKey } from "./generated-feed-identity"
import { readingRequest, readingStorySchema } from "./processing-reader-client"

export { generatedItemKey } from "./generated-feed-identity"

// 生成源使用独立身份，只与处理服务通信，不能传入官方订阅接口。
export const generatedFeedSchema = z.object({
  id: z.literal("generated:events"),
  origin: z.literal("generated"),
  title: z.string(),
  private: z.literal(true),
})
const commonItem = {
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  publishedAt: z.string(),
  read: z.boolean().nullable(),
  collected: z.boolean().nullable(),
  collectedAt: z.string().nullable().optional(),
  materialCount: z.number().int().nonnegative(),
  topics: z.array(z.string()),
}
export const generatedReaderItemSchema = z.discriminatedUnion("kind", [
  z.object({
    ...commonItem,
    kind: z.literal("story"),
    origin: z.literal("generated"),
    storyId: z.string(),
    generatedFeedId: z.literal("generated:events"),
    revision: z.number().int().positive(),
    substantiveRevision: z.number().int().nonnegative(),
    updatedAt: z.string(),
    hasImportantUpdate: z.boolean(),
    sourceKeys: z.array(z.string()),
  }),
  z.object({
    ...commonItem,
    kind: z.literal("entry"),
    origin: z.literal("original"),
    sourceKey: z.string(),
    inputSeq: z.number().int().positive().nullable(),
    decisionId: z.string().nullable(),
    storyIds: z.array(z.string()),
    view: z.number().int().optional(),
    updatedAt: z.string().optional(),
  }),
])
export const generatedFeedPageSchema = z.object({
  feed: generatedFeedSchema,
  snapshotId: z.string().uuid(),
  latestAvailable: z.boolean(),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  items: z.array(generatedReaderItemSchema),
  counts: z
    .object({
      pending: z.number(),
      failed: z.number(),
      needsContext: z.number(),
      inputs: z.number().int().nonnegative().optional(),
      uncovered: z.number().int().nonnegative().optional(),
      hidden: z.number().int().nonnegative().optional(),
      folded: z.number().int().nonnegative().optional(),
    })
    .optional(),
  collectionSync: z
    .object({
      status: z.enum(["complete", "stale"]),
      syncedAt: z.string().nullable(),
      failure: z.string().nullable(),
    })
    .optional(),
})
export type GeneratedReaderItem = z.infer<typeof generatedReaderItemSchema>
export type GeneratedFeedPage = z.infer<typeof generatedFeedPageSchema>
export type GeneratedFeedQuery = {
  mode: "smart" | "stories" | "collections"
  view?: number | "all"
  sourceKeys?: string[]
  category?: { view: number | "all"; name: string }
  search?: string
  topic?: string
  unreadOnly?: boolean
  collectedOnly?: boolean
  since?: string
  until?: string
  snapshotId?: string
  cursor?: string
  refresh?: boolean
  limit?: number
}

export const loadGeneratedFeedPage = (query: GeneratedFeedQuery, signal: AbortSignal) =>
  readingRequest("processing/generated-feed/items", generatedFeedPageSchema, signal, query)

export const loadGeneratedFeedStats = (signal: AbortSignal) =>
  readingRequest(
    "processing/generated-feed/stats",
    z.object({
      feedId: z.literal("generated:events"),
      total: z.number().int().nonnegative(),
      unread: z.number().int().nonnegative(),
      collected: z.number().int().nonnegative(),
    }),
    signal,
  )

const generatedTargetSchema = z.object({
  snapshotId: z.uuid(),
  cursor: z.string().nullable(),
  previousCursor: z.string().nullable(),
})
export const generatedEntryStateSchema = z.object({
  entryId: z.string(),
  status: z.enum([
    "ready",
    "hidden",
    "needs_context",
    "pending",
    "failed",
    "unprocessed",
    "unavailable",
  ]),
  reason: z.string().nullable(),
  item: generatedReaderItemSchema.options[1].nullable(),
  target: generatedTargetSchema.nullable(),
})
export type GeneratedEntryState = z.infer<typeof generatedEntryStateSchema>
// 原文深链单独读取处理状态，不依赖第一批 30 行或偷偷触发模型调用。
export const loadGeneratedEntryState = (entryId: string, signal: AbortSignal) =>
  readingRequest(
    `processing/generated-feed/entries/${encodeURIComponent(entryId)}`,
    generatedEntryStateSchema,
    signal,
  )
export const locateGeneratedReaderTarget = (
  target: { entryId?: string; storyId?: string },
  query: GeneratedFeedQuery,
  signal: AbortSignal,
) =>
  readingRequest(
    "processing/generated-feed/locate",
    z.object({ target: generatedTargetSchema.nullable() }),
    signal,
    { ...target, query },
  )

const readerStateSchema = z.object({
  storyId: z.string(),
  read: z.boolean(),
  collected: z.boolean(),
  hasImportantUpdate: z.boolean(),
  link: readingStorySchema,
})
export type GeneratedStoryState = z.infer<typeof readerStateSchema>
export const loadGeneratedStoryState = (storyId: string, signal: AbortSignal) =>
  readingRequest(
    `processing/stories/${encodeURIComponent(storyId)}/reader-state`,
    readerStateSchema,
    signal,
  )
export const setGeneratedStoryState = async (
  storyId: string,
  state: { read?: boolean; collected?: boolean; revision?: number },
  signal: AbortSignal,
) => {
  const result = await readingRequest(
    `processing/stories/${encodeURIComponent(storyId)}/reader-state`,
    readerStateSchema,
    signal,
    state,
  )
  // 读态和收藏保存成功后立即刷新私人来源计数，不刷新正在阅读的冻结成员。
  window.dispatchEvent(new Event("processing-story-state-changed"))
  return result
}

export function appendGeneratedPage(
  current: GeneratedReaderItem[],
  next: GeneratedReaderItem[],
): GeneratedReaderItem[] {
  const known = new Set(current.map(generatedItemKey))
  // 同一页内也去重，重复版本不能追加第二个稳定身份。
  return [
    ...current,
    ...next.filter((item) => {
      const key = generatedItemKey(item)
      if (known.has(key)) return false
      known.add(key)
      return true
    }),
  ]
}
