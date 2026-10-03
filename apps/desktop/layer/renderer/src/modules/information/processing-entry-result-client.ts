import { getEntry } from "@follow/store/entry/getter"
import { useWhoami } from "@follow/store/user/hooks"
import { useEffect, useSyncExternalStore } from "react"
import { z } from "zod"

import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"

import type { ProcessingEntryResult } from "./processing-entry-result-match"
import { resolveProcessingEntryResult } from "./processing-entry-result-match"
import { readingRequest, ReadingRequestError } from "./processing-reader-client"

const resultIndexSchema = z.object({
  results: z.array(
    z.object({
      itemId: z.string(),
      sourceKey: z.string(),
      sourceId: z.string().nullable(),
      inputSeq: z.number().int().positive(),
      decisionId: z.string(),
      contentVersion: z.string(),
      releaseVersion: z.number().int().positive(),
    }),
  ),
})

const emptyResults: ProcessingEntryResult[] = []
let ownerId: string | null = null
let results: ProcessingEntryResult[] = emptyResults
let controller: AbortController | null = null
let interval: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((listener) => listener())
const reset = (nextOwner: string | null) => {
  controller?.abort()
  controller = null
  ownerId = nextOwner
  results = emptyResults
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
      results = response.results
      emit()
    })
    .catch((error: unknown) => {
      if (error instanceof ReadingRequestError && error.kind === "authorization") reset(null)
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
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      if (interval) clearInterval(interval)
      interval = null
      controller?.abort()
      controller = null
    }
  }
}

export function useProcessingEntryResult(entryId: string): ProcessingEntryResult | null {
  const user = useWhoami()
  const userId = user?.id ?? null
  useEffect(() => {
    if (ownerId !== userId) {
      reset(userId)
      refresh()
    }
  }, [userId])
  const index = useSyncExternalStore(
    subscribe,
    () => (ownerId === userId ? results : emptyResults),
    () => emptyResults,
  )
  const entry = getEntry(entryId)
  if (!entry) return null
  const sources = [
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
  return resolveProcessingEntryResult(index, entryId, sources)
}
