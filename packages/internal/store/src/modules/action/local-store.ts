import type {
  ActionConditionIndex,
  ActionFeedField,
  ActionFilterItem,
  ActionId,
  ActionOperation,
} from "@follow-app/client-sdk"
import { merge } from "es-toolkit/compat"

import { createImmerSetter, createZustandStore } from "../../lib/helper"
import type { ActionItem, ActionModel } from "./store"

interface LocalActionStore {
  rules: ActionItem[]
  isDirty: boolean
  isHydrated: boolean
  ownerKey: string | null
  revision: number
}

export type LocalActionMigrationTarget = {
  localId?: string
  index: number
  name: string
  condition: unknown
  result: unknown
}

const STORAGE_PREFIX = "follow:local-actions:v1"

const getStorageKey = (ownerKey: string) => `${STORAGE_PREFIX}:${ownerKey}`

const getLocalStorage = () => {
  if (typeof window === "undefined") return null
  return window.localStorage
}

const bumpLocalActionRevision = (state: LocalActionStore) => {
  state.revision += 1
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeConditionItem = (value: unknown): ActionFilterItem | null => {
  if (!isRecord(value)) return null

  const item: Partial<ActionFilterItem> = {}

  if (typeof value.field === "string") {
    item.field = value.field as ActionFeedField
  }
  if (typeof value.operator === "string") {
    item.operator = value.operator as ActionOperation
  }
  if (typeof value.value === "string" || typeof value.value === "number") {
    item.value = String(value.value)
  }

  return item as ActionFilterItem
}

const normalizeCondition = (condition: unknown): ActionFilterItem[][] => {
  if (!Array.isArray(condition)) return []

  const rawGroups = Array.isArray(condition[0]) ? condition : [condition]

  return rawGroups
    .filter((group): group is unknown[] => Array.isArray(group))
    .map((group) =>
      group.map(normalizeConditionItem).filter((item): item is ActionFilterItem => !!item),
    )
    .filter((group) => group.length > 0)
}

const normalizeResult = (result: unknown): ActionItem["result"] => {
  const nextResult: Partial<ActionItem["result"]> = {}

  if (!isRecord(result)) return nextResult as ActionItem["result"]

  if (result.disabled === true) {
    nextResult.disabled = true
  }

  if (result.block === true) {
    nextResult.block = true
  }
  if (result.silence === true) {
    nextResult.silence = true
  }

  return nextResult as ActionItem["result"]
}

const normalizeRule = (rule: unknown, index: number): ActionItem | null => {
  if (!isRecord(rule)) return null

  return {
    // 数组位置仅用于旧编辑器导航，升级绑定始终使用持久化标识。
    localId:
      typeof rule.localId === "string" && /^[\w-]{1,160}$/.test(rule.localId)
        ? rule.localId
        : crypto.randomUUID(),
    condition: normalizeCondition(rule.condition),
    index,
    name:
      typeof rule.name === "string" && rule.name.length > 0 ? rule.name : `Local Rule ${index + 1}`,
    result: normalizeResult(rule.result),
  }
}

const normalizeRules = (rules: unknown): ActionItem[] => {
  if (!Array.isArray(rules)) return []
  const ids = new Set<string>()
  return rules
    .map((rule, index) => normalizeRule(rule, index))
    .filter((rule): rule is ActionItem => !!rule)
    .map((rule) => {
      if (!rule.localId || ids.has(rule.localId)) rule.localId = crypto.randomUUID()
      ids.add(rule.localId)
      return rule
    })
}

const readRulesFromStorage = (ownerKey: string): ActionItem[] => {
  const storage = getLocalStorage()
  if (!storage) return []

  const raw = storage.getItem(getStorageKey(ownerKey))
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    const rawRules = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.rules : []
    const rules = normalizeRules(rawRules)
    const stableIds = new Set(
      Array.isArray(rawRules)
        ? rawRules.flatMap((rule) =>
            isRecord(rule) && typeof rule.localId === "string" ? [rule.localId] : [],
          )
        : [],
    )
    if (rules.some((rule) => !stableIds.has(rule.localId!))) {
      try {
        // 只在旧数据首次补 ID 时写入；持久化失败仍执行旧规则，但禁止以临时 ID 升级。
        writeRulesToStorage(ownerKey, rules)
      } catch {
        return rules.map((rule) =>
          stableIds.has(rule.localId!) ? rule : { ...rule, localId: undefined },
        )
      }
    }
    return rules
  } catch {
    return []
  }

  return []
}

const writeRulesToStorage = (ownerKey: string, rules: ActionItem[]) => {
  const storage = getLocalStorage()
  if (!storage) return

  storage.setItem(
    getStorageKey(ownerKey),
    JSON.stringify({
      rules: normalizeRules(rules),
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
  )
}

export const useLocalActionStore = createZustandStore<LocalActionStore>("action-local")(() => ({
  isDirty: false,
  isHydrated: false,
  ownerKey: null,
  revision: 0,
  rules: [],
}))

const set = createImmerSetter(useLocalActionStore)

const sanitizeRuleAtIndex = (state: LocalActionStore, index: number) => {
  const nextRule = normalizeRule(state.rules[index], index)
  if (nextRule) {
    state.rules[index] = nextRule
  }
}

export const localActionActions = {
  addConditionGroup: (index: Omit<ActionConditionIndex, "conditionIndex" | "groupIndex">) => {
    set((state) => {
      const rule = state.rules[index.ruleIndex]
      if (!rule) return

      rule.condition.push([{} as ActionFilterItem])
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  addConditionItem: (index: Omit<ActionConditionIndex, "conditionIndex">) => {
    set((state) => {
      const rule = state.rules[index.ruleIndex]
      if (!rule) return
      const group = rule.condition[index.groupIndex]
      if (!group) return

      group.push({} as ActionFilterItem)
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  addRewriteRule: (_index: number) => {},
  addRule: (getName?: ((index: number) => string) | string) => {
    set((state) => {
      const index = state.rules.length
      state.rules.push({
        localId: crypto.randomUUID(),
        condition: [],
        index,
        name:
          typeof getName === "function" ? getName(index + 1) : getName || `Local Rule ${index + 1}`,
        result: {},
      } as ActionItem)
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  addWebhook: (_index: number) => {},
  deleteConditionItem: (index: ActionConditionIndex) => {
    set((state) => {
      const rule = state.rules[index.ruleIndex]
      if (!rule) return
      const group = rule.condition[index.groupIndex]
      if (!group) return

      group.splice(index.conditionIndex, 1)
      if (group.length === 0) {
        rule.condition.splice(index.groupIndex, 1)
      }
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  deleteRewriteRule: (_index: number, _rewriteIdx: number) => {},
  deleteRule: (index: number) => {
    set((state) => {
      state.rules.splice(index, 1)
      state.rules.forEach((rule, ruleIndex) => {
        rule.index = ruleIndex
      })
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  deleteRuleAction: (index: number, actionId: ActionId) => {
    set((state) => {
      if (!state.rules[index]) return
      delete state.rules[index].result[actionId]
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  deleteWebhook: (_index: number, _webhookIndex: number) => {},
  exportRules: () => {
    const { rules } = useLocalActionStore.getState()
    return JSON.stringify(
      {
        exportDate: new Date().toISOString(),
        rules,
        type: "folo-local-actions",
        version: "1.0",
      },
      null,
      2,
    )
  },
  hydrate: (ownerKey: string) => {
    const rules = readRulesFromStorage(ownerKey)

    set((state) => {
      state.ownerKey = ownerKey
      state.rules = rules
      state.isDirty = false
      state.isHydrated = true
      bumpLocalActionRevision(state)
    })
  },
  importRules: (
    jsonData: string,
  ): { importedCount?: number; message: string; success: boolean } => {
    try {
      const parsed = JSON.parse(jsonData) as unknown
      const rules = isRecord(parsed) ? normalizeRules(parsed.rules) : normalizeRules(parsed)

      set((state) => {
        state.rules = rules
        state.isDirty = true
        bumpLocalActionRevision(state)
      })

      return {
        importedCount: rules.length,
        message: `Successfully imported ${rules.length} local rules`,
        success: true,
      }
    } catch (error) {
      return {
        message: `Failed to import local rules: ${error instanceof Error ? error.message : "Invalid JSON"}`,
        success: false,
      }
    }
  },
  patchRule: (index: number, rule: Partial<ActionModel>) => {
    set((state) => {
      if (!state.rules[index]) return
      state.rules[index] = merge(state.rules[index], rule)
      sanitizeRuleAtIndex(state, index)
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  pathCondition: (index: ActionConditionIndex, condition: Partial<ActionFilterItem>) => {
    set((state) => {
      const rule = state.rules[index.ruleIndex]
      if (!rule) return
      const group = rule.condition[index.groupIndex]
      if (!group) return

      group[index.conditionIndex] = merge(group[index.conditionIndex], condition)
      sanitizeRuleAtIndex(state, index.ruleIndex)
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  saveRules: () => {
    const { ownerKey, rules } = useLocalActionStore.getState()
    const nextRules = normalizeRules(rules)
    writeRulesToStorage(ownerKey || "anonymous", nextRules)

    set((state) => {
      state.ownerKey ||= "anonymous"
      state.rules = nextRules
      state.isDirty = false
    })
  },
  setDirty: (dirty: boolean) => {
    set((state) => {
      state.isDirty = dirty
    })
  },
  toggleRuleFilter: (index: number) => {
    set((state) => {
      if (!state.rules[index]) return

      const hasCustomFilters = state.rules[index].condition.length > 0
      state.rules[index].condition = hasCustomFilters ? [] : [[{} as ActionFilterItem]]
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  updateRewriteRule: (_payload: {
    index: number
    key: "from" | "to"
    rewriteRuleIndex: number
    value: string
  }) => {},
  updateRules: (rules: ActionItem[]) => {
    set((state) => {
      state.rules = normalizeRules(rules)
      state.isDirty = true
      bumpLocalActionRevision(state)
    })
  },
  updateWebhook: (_payload: { index: number; value: string; webhookIndex: number }) => {},
}

export const localActionSyncService = {
  hydrate: (resolvedOwnerKey = "anonymous") => {
    const state = useLocalActionStore.getState()

    if (state.ownerKey === resolvedOwnerKey && state.isHydrated) return

    localActionActions.hydrate(resolvedOwnerKey)
  },
  saveRules: async () => {
    localActionActions.saveRules()
  },
  disablePublishedMigrationTargets: (
    expectedOwnerKey: string,
    targets: readonly LocalActionMigrationTarget[],
  ) => {
    const state = useLocalActionStore.getState()
    if (
      !state.isHydrated ||
      !state.ownerKey ||
      state.ownerKey === "anonymous" ||
      state.ownerKey !== expectedOwnerKey
    )
      return { switched: false as const, reason: "owner" as const }
    const matches = targets.every((target) => {
      const rule = target.localId
        ? state.rules.find((item) => item.localId === target.localId)
        : state.rules[target.index]
      return (
        rule?.name === target.name &&
        JSON.stringify(rule.condition) === JSON.stringify(target.condition) &&
        JSON.stringify(rule.result) === JSON.stringify(target.result)
      )
    })
    if (!matches) return { switched: false as const, reason: "changed" as const }

    const nextRules = state.rules.map((rule, index) =>
      targets.some((target) =>
        target.localId ? target.localId === rule.localId : target.index === index,
      )
        ? { ...rule, result: { ...rule.result, disabled: true } }
        : rule,
    )
    // 先写持久化副本，再更新运行态；存储失败时旧规则仍保持启用。
    writeRulesToStorage(state.ownerKey || "anonymous", nextRules)
    set((draft) => {
      draft.rules = normalizeRules(nextRules)
      draft.isDirty = false
      bumpLocalActionRevision(draft)
    })
    return { switched: true as const, count: targets.length }
  },
}
