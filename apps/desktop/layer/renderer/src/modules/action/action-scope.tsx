import {
  useActionRule,
  useActionRules,
  useIsActionDataDirty,
  usePrefetchActions,
  useUpdateActionsMutation,
} from "@follow/store/action/hooks"
import {
  useIsLocalActionDataDirty,
  useLocalActionRule,
  useLocalActionRules,
  useUpdateLocalActionsMutation,
} from "@follow/store/action/local-hooks"
import { localActionActions } from "@follow/store/action/local-store"
import type { ActionItem } from "@follow/store/action/store"
import { actionActions } from "@follow/store/action/store"
import { createContext, use } from "react"

export type ActionScope = "cloud" | "local"

const ActionScopeContext = createContext<ActionScope>("cloud")

export const ActionScopeProvider = ({
  children,
  value,
}: {
  children: React.ReactNode
  value: ActionScope
}) => <ActionScopeContext value={value}>{children}</ActionScopeContext>

export const useActionScope = () => use(ActionScopeContext)

export function useScopedActionRules(): ActionItem[]
export function useScopedActionRules<T>(selector: (rules: ActionItem[]) => T): T
export function useScopedActionRules<T>(selector?: (rules: ActionItem[]) => T) {
  const scope = useActionScope()
  const resolvedSelector = selector ?? ((rules: ActionItem[]) => rules as T)
  const cloudRules = useActionRules(resolvedSelector)
  const localRules = useLocalActionRules(resolvedSelector)

  return scope === "local" ? localRules : cloudRules
}

export function useScopedActionRule(index: number): ActionItem | undefined
export function useScopedActionRule<T>(
  index: number,
  selector: (rule: ActionItem) => T,
): T | undefined
export function useScopedActionRule<T>(index: number, selector?: (rule: ActionItem) => T) {
  const scope = useActionScope()
  const resolvedSelector = selector ?? ((rule: ActionItem) => rule as T)
  const cloudRule = useActionRule(index, resolvedSelector)
  const localRule = useLocalActionRule(index, resolvedSelector)

  return scope === "local" ? localRule : cloudRule
}

export const useScopedActionDataDirty = () => {
  const scope = useActionScope()
  const cloudDirty = useIsActionDataDirty()
  const localDirty = useIsLocalActionDataDirty()

  return scope === "local" ? localDirty : cloudDirty
}

export const useScopedPrefetchActions = () => {
  const scope = useActionScope()
  const cloudQuery = usePrefetchActions()

  return scope === "local" ? { isPending: false } : cloudQuery
}

export const useScopedUpdateActionsMutation = (
  options?: Parameters<typeof useUpdateActionsMutation>[0],
) => {
  const scope = useActionScope()
  const cloudMutation = useUpdateActionsMutation(options)
  const localMutation = useUpdateLocalActionsMutation(options)

  return scope === "local" ? localMutation : cloudMutation
}

export const useScopedActionActions = () => {
  const scope = useActionScope()

  return scope === "local" ? localActionActions : actionActions
}
