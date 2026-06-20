import { useMutation } from "@tanstack/react-query"
import { useCallback, useEffect } from "react"

import type { GeneralMutationOptions } from "../../types"
import { useEntryStore } from "../entry/store"
import { unreadSyncService } from "../unread/store"
import { getLocalActionSilenceEntryIds } from "./local-match"
import { localActionSyncService, useLocalActionStore } from "./local-store"
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

export const useLocalActionRevision = () => useLocalActionStore((state) => state.revision)

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
