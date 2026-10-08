import type { TagAssessment } from "@follow/information-core"
import { useMutation } from "@tanstack/react-query"
import { useCallback, useEffect } from "react"

import type { GeneralMutationOptions } from "../../types"
import { useCollectionStore } from "../collection/store"
import { useEntryStore } from "../entry/store"
import { useFeedStore } from "../feed/store"
import { getSubscriptionByEntryId } from "../subscription/getter"
import { useSubscriptionStore } from "../subscription/store"
import { unreadSyncService } from "../unread/store"
import { getLocalActionSilenceEntryIds, getPublishedLocalActionResult } from "./local-match"
import { localActionSyncService, useLocalActionStore } from "./local-store"
import { usePublishedLocalFilterStore } from "./published-local-filters"
import type { ActionItem } from "./store"

export const useLocalActionHydration = (ownerKey: string | null | undefined) => {
  useEffect(() => {
    localActionSyncService.hydrate(ownerKey ?? undefined)
  }, [ownerKey])
}

export function useLocalActionRules(): ActionItem[]
export function useLocalActionRules<T>(selector: (rules: ActionItem[]) => T): T
export function useLocalActionRules<T>(selector?: (rules: ActionItem[]) => T) {
  return useLocalActionStore((state) => (selector ? selector(state.rules) : state.rules))
}

export function useLocalActionRule(index: number): ActionItem | undefined
export function useLocalActionRule<T>(
  index: number,
  selector: (rule: ActionItem) => T,
): T | undefined
export function useLocalActionRule<T>(index: number, selector?: (rule: ActionItem) => T) {
  return useLocalActionStore((state) => {
    const rule = state.rules[index]
    if (!rule) return
    return selector ? selector(rule) : rule
  })
}

export const useLocalActionRevision = () => {
  const localRevision = useLocalActionStore((state) => state.revision)
  const publishedRevision = usePublishedLocalFilterStore((state) => state.revision)
  return localRevision + publishedRevision
}

// 规则发布、来源元数据和阅读状态变化后重新匹配，停用或删除动作立即恢复正常显示。
export const useIsEntryDimmedByLocalActions = (
  entryId: string,
  entryTags?: readonly TagAssessment[] | null,
): boolean => {
  useLocalActionRevision()
  useLocalActionStore((state) => ({ ownerKey: state.ownerKey, isHydrated: state.isHydrated }))
  const entry = useEntryStore((state) => state.data[entryId])
  useFeedStore((state) => state.feeds[entry?.feedId ?? ""])
  useSubscriptionStore(() => getSubscriptionByEntryId(entryId))
  useCollectionStore((state) => state.collections[entryId])
  return getPublishedLocalActionResult(entryId, entryTags).dimmed
}

export const useIsLocalActionDataDirty = () => useLocalActionStore((state) => state.isDirty)

export const useLocalActionSilenceProcessor = () => {
  const localActionRevision = useLocalActionRevision()
  const entryIds = useEntryStore(
    useCallback(
      (state) => {
        void localActionRevision
        return Array.from(state.entryIdSet)
      },
      [localActionRevision],
    ),
  )

  useEffect(() => {
    void localActionRevision

    const silenceEntryIds = getLocalActionSilenceEntryIds(entryIds)
    if (silenceEntryIds.length === 0) return

    void unreadSyncService.queueEntriesAsRead(silenceEntryIds)
  }, [entryIds, localActionRevision])
}

export const useUpdateLocalActionsMutation = (options?: GeneralMutationOptions) =>
  useMutation({
    ...options,
    mutationFn: localActionSyncService.saveRules,
  })
