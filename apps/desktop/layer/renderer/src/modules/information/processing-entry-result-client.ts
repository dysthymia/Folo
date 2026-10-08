import {
  semanticEntitySchema,
  semanticTagIdSchema,
  tagAssessmentSchema,
} from "@follow/information-core"
import { getEntry } from "@follow/store/entry/getter"
import { useWhoami } from "@follow/store/user/hooks"
import { useEffect, useSyncExternalStore } from "react"
import { z } from "zod"

import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"

import type {
  ProcessingEntryIdentity,
  ProcessingEntryResult,
} from "./processing-entry-result-match"
import { hasProcessingEntry, resolveProcessingEntryResult } from "./processing-entry-result-match"
import { readingRequest, ReadingRequestError } from "./processing-reader-client"

const resultIndexSchema = z.object({
  processed: z
    .array(
      z.object({
        itemId: z.string(),
        sourceKey: z.string(),
        sourceId: z.string().nullable(),
      }),
    )
    .optional(),
  results: z.array(
    z.object({
      itemId: z.string(),
      sourceKey: z.string(),
      sourceId: z.string().nullable(),
      inputSeq: z.number().int().positive(),
      decisionId: z.string(),
      contentVersion: z.string(),
      releaseVersion: z.number().int().positive(),
      semanticTags: z.array(semanticTagIdSchema).optional(),
      // 保留原始状态、置信度与定义版本，供本地标签条件按用户阈值匹配。
      semanticAssessments: z.array(tagAssessmentSchema).optional(),
      // 实体随当前正文的批量投影返回，避免列表逐条读取详情。
      semanticEntities: z.array(semanticEntitySchema).optional(),
    }),
  ),
})

const emptyResults: ProcessingEntryResult[] = []
const emptyIndex: {
  results: ProcessingEntryResult[]
  processed: ProcessingEntryIdentity[] | null
} = {
  results: emptyResults,
  processed: null,
}
let ownerId: string | null = null
let index = emptyIndex
let controller: AbortController | null = null
let interval: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((listener) => listener())
const reset = (nextOwner: string | null) => {
  controller?.abort()
  controller = null
  ownerId = nextOwner
  index = emptyIndex
  emit()
}

const refresh = () => {
  if (!ownerId || !isLocalFoloHost() || controller) return
  const requestOwner = ownerId
  const request = new AbortController()
  controller = request
  void readingRequest("processing/entry-results", resultIndexSchema, request.signal)
    .then((response) => {
      if (request.signal.aborted || ownerId !== requestOwner) return
      index = { results: response.results, processed: response.processed ?? null }
      emit()
    })
    .catch((error: unknown) => {
      if (request.signal.aborted || ownerId !== requestOwner) return
      if (error instanceof ReadingRequestError && error.kind === "authorization") {
        // 授权失败时撤销当前确认，但保留账号以便下一轮自动重试；账号变化会由 useResultIndex 清空。
        index = emptyIndex
        emit()
      }
      // 短暂的网络或服务错误不抹掉同一账号上次确认的处理记录。
    })
    .finally(() => {
      if (controller === request) controller = null
    })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  if (listeners.size === 1) {
    refresh()
    interval = setInterval(refresh, 60_000)
    window.addEventListener("processing-reading-invalidated", invalidate)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      if (interval) clearInterval(interval)
      interval = null
      controller?.abort()
      controller = null
      window.removeEventListener("processing-reading-invalidated", invalidate)
    }
  }
}

// 人工纠错立即失效当前标签与决定指针，不等待下一轮定时刷新，也不保留旧请求结果。
const invalidate = () => {
  reset(ownerId)
  refresh()
}

function useResultIndex() {
  const user = useWhoami()
  const userId = user?.id ?? null
  useEffect(() => {
    if (ownerId !== userId) {
      reset(userId)
      refresh()
    }
  }, [userId])
  return useSyncExternalStore(
    subscribe,
    () => (ownerId === userId ? index : emptyIndex),
    () => emptyIndex,
  )
}

function entrySourceIds(entryId: string): string[] | null {
  const entry = getEntry(entryId)
  if (!entry) return null
  return [
    ...(entry.feedId ? [`feed/${entry.feedId}`] : []),
    ...(entry.inboxHandle ? [`inbox/${entry.inboxHandle}`] : []),
    ...(entry.sources ?? []).flatMap((source) =>
      source.startsWith("feed/") || source.startsWith("inbox/")
        ? [source]
        : source !== "feed"
          ? [`feed/${source}`]
          : [],
    ),
  ]
}

export function useProcessingEntryResult(entryId: string): ProcessingEntryResult | null {
  const { results } = useResultIndex()
  const sources = entrySourceIds(entryId)
  return sources ? resolveProcessingEntryResult(results, entryId, sources) : null
}

/** null 表示服务尚未确认状态，不能把加载失败误写成“未处理”。 */
export function useProcessingEntryStatus(entryId: string): boolean | null {
  const { processed, results } = useResultIndex()
  const sources = entrySourceIds(entryId)
  if (!isLocalFoloHost() || !sources) return null
  // 旧后台仍能确认摘要变换已完成；其它条目等新状态索引到位后再判断。
  if (!processed) return hasProcessingEntry(results, entryId, sources) ? true : null
  return hasProcessingEntry(processed, entryId, sources)
}
