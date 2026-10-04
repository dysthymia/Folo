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
    inputSeq: z.number().int().positive(),
    decisionId: z.string(),
    storyIds: z.array(z.string()),
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
    .object({ pending: z.number(), failed: z.number(), needsContext: z.number() })
    .optional(),
})
export type GeneratedReaderItem = z.infer<typeof generatedReaderItemSchema>
export type GeneratedFeedPage = z.infer<typeof generatedFeedPageSchema>
export type GeneratedFeedQuery = {
  mode: "smart" | "stories"
  view?: number | "all"
  sourceKeys?: string[]
  category?: { view: number; name: string }
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
export const setGeneratedStoryState = (
  storyId: string,
  state: { read?: boolean; collected?: boolean; revision?: number },
  signal: AbortSignal,
) =>
  readingRequest(
    `processing/stories/${encodeURIComponent(storyId)}/reader-state`,
    readerStateSchema,
    signal,
    state,
  )

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
