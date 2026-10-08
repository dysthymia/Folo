import type { RuleInput, RuleSet } from "@follow/information-core"
import { matchConditions, ruleSetSchema } from "@follow/information-core"

import { createZustandStore } from "../../lib/helper"

export type PublishedLocalFilterSource = {
  key: string
  kind: "feed" | "list" | "inbox" | "x_search"
  id: string
  title: string
  view: number
  category: string | null
}

export type PublishedLocalFilterSnapshot = {
  ownerId: string
  ruleSet: RuleSet
  sources?: readonly PublishedLocalFilterSource[]
  sourceTags?: readonly { sourceKey: string; tagIds: readonly string[] }[]
  listMemberships?: readonly {
    listKey: string
    feedIds: readonly string[]
    complete: boolean
    status: "complete" | "unknown"
  }[]
}

const cacheKey = (ownerId: string) => `follow:published-local-filters:v1:${ownerId}`
const getStorage = () => (typeof window === "undefined" ? null : window.localStorage)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

function parseSnapshot(value: unknown): PublishedLocalFilterSnapshot {
  if (!isRecord(value) || typeof value.ownerId !== "string")
    throw new Error("invalid_published_rules")
  const ruleSet = ruleSetSchema.parse(value.ruleSet)
  if (ruleSet.ownerId !== value.ownerId) throw new Error("published_rules_owner_mismatch")
  // 离线缓存也属于不可信输入；来源、私人标签和 List 元数据必须通过边界校验。
  const sources =
    value.sources === undefined
      ? undefined
      : Array.isArray(value.sources)
        ? value.sources.map((source): PublishedLocalFilterSource => {
            if (
              !isRecord(source) ||
              typeof source.key !== "string" ||
              typeof source.id !== "string" ||
              typeof source.title !== "string" ||
              typeof source.view !== "number" ||
              !Number.isInteger(source.view) ||
              source.view < 0 ||
              source.view > 5 ||
              (source.category !== null && typeof source.category !== "string") ||
              !["feed", "list", "inbox", "x_search"].includes(String(source.kind))
            )
              throw new Error("invalid_published_sources")
            return {
              key: source.key,
              id: source.id,
              title: source.title,
              view: source.view,
              kind: source.kind as PublishedLocalFilterSource["kind"],
              category: source.category,
            }
          })
        : (() => {
            throw new Error("invalid_published_sources")
          })()
  const sourceTags =
    value.sourceTags === undefined
      ? undefined
      : Array.isArray(value.sourceTags)
        ? value.sourceTags.map((binding) => {
            if (
              !isRecord(binding) ||
              typeof binding.sourceKey !== "string" ||
              !stringArray(binding.tagIds)
            )
              throw new Error("invalid_published_tags")
            return { sourceKey: binding.sourceKey, tagIds: binding.tagIds }
          })
        : (() => {
            throw new Error("invalid_published_tags")
          })()
  const listMemberships =
    value.listMemberships === undefined
      ? undefined
      : Array.isArray(value.listMemberships)
        ? value.listMemberships.map(
            (membership): NonNullable<PublishedLocalFilterSnapshot["listMemberships"]>[number] => {
              if (
                !isRecord(membership) ||
                typeof membership.listKey !== "string" ||
                !stringArray(membership.feedIds) ||
                typeof membership.complete !== "boolean" ||
                (membership.status !== "complete" && membership.status !== "unknown")
              )
                throw new Error("invalid_published_lists")
              return {
                listKey: membership.listKey,
                feedIds: membership.feedIds,
                complete: membership.complete,
                status: membership.status,
              }
            },
          )
        : (() => {
            throw new Error("invalid_published_lists")
          })()
  return { ownerId: value.ownerId, ruleSet, sources, sourceTags, listMemberships }
}

// 只读缓存保证离线刷新仍可执行已发布的普通动作，不形成第二套可编辑规则。
export const usePublishedLocalFilterStore = createZustandStore<{
  snapshot: PublishedLocalFilterSnapshot | null
  revision: number
}>("action-published-local-filters")(() => ({ snapshot: null, revision: 0 }))

export const setPublishedLocalFilters = (snapshot: PublishedLocalFilterSnapshot): void => {
  const next = structuredClone(parseSnapshot(snapshot))
  // 必须先持久化；失败会向上传递，调用者此时必须保留旧规则，不能完成升级停用。
  getStorage()?.setItem(cacheKey(snapshot.ownerId), JSON.stringify(next))
  usePublishedLocalFilterStore.setState((state) => ({
    snapshot: next,
    revision: state.revision + 1,
  }))
}

export const hydratePublishedLocalFilters = (ownerId: string): boolean => {
  clearPublishedLocalFilters()
  try {
    const stored = getStorage()?.getItem(cacheKey(ownerId))
    if (!stored) return false
    const snapshot = parseSnapshot(JSON.parse(stored))
    if (snapshot.ownerId !== ownerId) return false
    usePublishedLocalFilterStore.setState((state) => ({ snapshot, revision: state.revision + 1 }))
    return true
  } catch {
    return false
  }
}

export const clearPublishedLocalFilters = (expectedOwnerId?: string): void => {
  const state = usePublishedLocalFilterStore.getState()
  // 旧账号请求的清理回调不能清掉新账号刚刚安装的镜像。
  if (expectedOwnerId && state.snapshot?.ownerId !== expectedOwnerId) return
  usePublishedLocalFilterStore.setState({ snapshot: null, revision: state.revision + 1 })
}

export const evaluatePublishedLocalFilters = (ruleSet: RuleSet, input: RuleInput) => {
  let blocked = false
  let silenced = false
  let dimmed = false
  const matchedRuleIds: string[] = []
  for (const rule of ruleSet.rules) {
    if (!rule.enabled || !rule.actions.some((action) => action.type === "local_filter")) continue
    // 元数据未知时不屏蔽也不标记已读，等待同步完成后重新求值。
    if (matchConditions(rule.when, input).state !== "match") continue
    matchedRuleIds.push(rule.id)
    for (const action of rule.actions) {
      if (action.type !== "local_filter") continue
      blocked ||= action.mode === "block"
      silenced ||= action.mode === "silence"
      // 虚化独立于屏蔽和静音，不改变条目的可见性或未读状态。
      dimmed ||= action.mode === "dim"
    }
  }
  return { blocked, silenced: silenced && !blocked, dimmed, matchedRuleIds }
}
