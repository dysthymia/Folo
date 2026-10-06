import { useMemo } from "react"

import { createImmerSetter, createZustandStore } from "../../lib/helper"
import { getFeedById } from "../feed/getter"
import { getSubscriptionByEntryId } from "../subscription/getter"
import { getEntry } from "./getter"
import { getSemanticDuplicateRoleDetail, useSemanticDedupeRevision } from "./semantic-dedupe"

/**
 * Entry processing role.
 *
 * The timeline renders a single list, but content can be hidden or merged by two
 * independent engines:
 *
 * - the information service (rule based decisions and cross-source stories), and
 * - the local semantic dedupe (immediate, same-event duplicate collapsing).
 *
 * This module is the only place that resolves which role an entry plays, so the
 * list filter and the merged-entries badge can never diverge again. Engines only
 * feed the role layer, they never drive the UI directly.
 *
 * `hidden` is an explicit rule decision, `merged` means the content already
 * appears elsewhere (an entry kept by the local dedupe or a service story).
 * `restored` is an entry the user brought back by hand: it outranks both
 * hiding and merging, because a restore the timeline keeps suppressing would
 * look broken.
 */
export type EntryProcessingRoleKind = "hidden" | "merged" | "keeper" | "story" | "restored"

export type EntryProcessingRoleSource = "service" | "local-dedupe"

export interface EntryProcessingRole {
  kind: EntryProcessingRoleKind
  /**
   * - `hidden` points at nothing.
   * - `merged` points at the entry or story that kept the content.
   * - `keeper` and `story` point at the entries merged into them.
   */
  relatedEntryIds: string[]
  reason: string | null
  source: EntryProcessingRoleSource
  storyId?: string
  /**
   * 服务端的输入序号。只有服务端角色有；渲染层用它按需取处理理由（命中规则），
   * 不用再为时间线单独查一次映射表。
   */
  inputSeq?: number
  /** 服务端完整材料数，不受当前浏览器已加载条目数影响。 */
  materialCount?: number
  /**
   * Title of the service story this entry belongs to. Only the service side
   * produces stories, so it is absent for local dedupe roles.
   */
  storyTitle?: string
}

/**
 * Service side projection. The information service owns these decisions; the
 * client only mirrors them so the timeline can read them synchronously.
 */
export interface EntryProcessingServiceRole {
  entryId: string
  kind: EntryProcessingRoleKind
  reason?: string | null
  relatedEntryIds?: string[]
  storyId?: string
  storyTitle?: string
  inputSeq?: number
  /** 服务端完整材料数，不受当前浏览器已加载条目数影响。 */
  materialCount?: number
  /** 服务端列表携带的轻量预览，弥补本地尚未加载的折叠报道。 */
  relatedEntryPreviews?: Array<{
    itemId: string
    title: string | null
    sourceTitle: string | null
    publishedAt: string | null
    url: string | null
  }>
}

export interface EntryProcessingRelatedEntry {
  feedTitle: string
  id: string
  publishedAt: Date | null
  title: string
  url: string | null
  /** 当前服务角色已核验的折叠理由；展示不再等待详情接口。 */
  reason?: string | null
}

export interface ResolveEntryProcessingRoleOptions {
  /**
   * Whether the local dedupe takes part. Pass `false` when the local engine is
   * disabled so that only service side roles are honored.
   */
  localDedupe?: boolean
}

interface EntryProcessingRoleStore {
  revision: number
  serviceRoles: Record<string, EntryProcessingServiceRole>
  /** 当前部署与开关共同决定是否允许旧缓存参与，所有列表和角标读取同一口径。 */
  localDedupeAllowed: boolean
}

const defaultState: EntryProcessingRoleStore = {
  revision: 0,
  serviceRoles: {},
  localDedupeAllowed: true,
}

export const useEntryProcessingRoleStore = createZustandStore<EntryProcessingRoleStore>(
  "entry-processing-role",
)(() => defaultState)

const set = createImmerSetter(useEntryProcessingRoleStore)

export const entryProcessingRoleActions = {
  setLocalDedupeAllowed: (allowed: boolean) => {
    set((state) => {
      if (state.localDedupeAllowed === allowed) return
      state.localDedupeAllowed = allowed
      state.revision += 1
    })
  },
  replaceServiceRoles: (roles: EntryProcessingServiceRole[]) => {
    set((state) => {
      const serviceRoles = Object.fromEntries(roles.map((role) => [role.entryId, role]))
      // 轮询返回相同角色时不制造新版本，避免重复明细缓存无故失效和弹窗重读。
      if (JSON.stringify(state.serviceRoles) === JSON.stringify(serviceRoles)) return
      state.serviceRoles = serviceRoles
      state.revision += 1
    })
  },
  clearServiceRoles: () => {
    set((state) => {
      state.serviceRoles = {}
      state.revision += 1
    })
  },
}

const resolveLocalDedupeRole = (entryId: string): EntryProcessingRole | null => {
  const detail = getSemanticDuplicateRoleDetail(entryId)
  if (!detail) return null

  if (detail.role === "duplicate") {
    return {
      kind: "merged",
      reason: null,
      relatedEntryIds: detail.keepEntryId ? [detail.keepEntryId] : [],
      source: "local-dedupe",
    }
  }

  return {
    kind: "keeper",
    reason: null,
    relatedEntryIds: detail.mergedEntryIds,
    source: "local-dedupe",
  }
}

/**
 * Service decisions win: they follow the user's rules and survive a cache reset.
 * The local dedupe is an immediate approximation for entries the service never
 * processed.
 */
export const resolveEntryProcessingRole = (
  entryId: string,
  options: ResolveEntryProcessingRoleOptions = {},
): EntryProcessingRole | null => {
  const serviceRole = useEntryProcessingRoleStore.getState().serviceRoles[entryId]

  if (serviceRole) {
    return {
      kind: serviceRole.kind,
      reason: serviceRole.reason ?? null,
      relatedEntryIds: serviceRole.relatedEntryIds ?? [],
      source: "service",
      ...(serviceRole.storyId ? { storyId: serviceRole.storyId } : {}),
      ...(serviceRole.storyTitle ? { storyTitle: serviceRole.storyTitle } : {}),
      ...(serviceRole.inputSeq ? { inputSeq: serviceRole.inputSeq } : {}),
      ...(serviceRole.materialCount !== undefined
        ? { materialCount: serviceRole.materialCount }
        : {}),
    }
  }

  // 后台接管或旧执行器停用时，旧缓存仅保留审计，不能在服务角色消失后重新隐藏原文。
  if (options.localDedupe === false || !useEntryProcessingRoleStore.getState().localDedupeAllowed)
    return null

  return resolveLocalDedupeRole(entryId)
}

export const isEntryHiddenByProcessingRole = (
  entryId: string,
  options?: ResolveEntryProcessingRoleOptions,
) => {
  const role = resolveEntryProcessingRole(entryId, options)

  return role?.kind === "hidden" || role?.kind === "merged"
}

export const getEntryProcessingRoleRelatedEntries = (
  entryId: string,
): EntryProcessingRelatedEntry[] => {
  const role = resolveEntryProcessingRole(entryId)
  if (role?.kind !== "keeper" && role?.kind !== "story") return []

  const relatedEntries: EntryProcessingRelatedEntry[] = []
  const seenEntryIds = new Set<string>()

  for (const relatedEntryId of role.relatedEntryIds) {
    if (seenEntryIds.has(relatedEntryId)) continue

    // 两侧必须属于同一服务关系，不能把其他代表或综述的理由套到本组。
    const memberRole = useEntryProcessingRoleStore.getState().serviceRoles[relatedEntryId]
    const explanation =
      role.source === "service" &&
      role.kind === "keeper" &&
      memberRole?.kind === "merged" &&
      !memberRole.storyId &&
      memberRole.relatedEntryIds?.includes(entryId)
        ? { reason: memberRole.reason ?? null }
        : {}
    const entry = getEntry(relatedEntryId)
    if (!entry) {
      const preview =
        role.source === "service"
          ? useEntryProcessingRoleStore
              .getState()
              .serviceRoles[entryId]?.relatedEntryPreviews?.find(
                (entry) => entry.itemId === relatedEntryId,
              )
          : undefined
      if (preview || explanation.reason) {
        seenEntryIds.add(relatedEntryId)
        relatedEntries.push({
          id: relatedEntryId,
          title: preview?.title ?? relatedEntryId,
          feedTitle: preview?.sourceTitle ?? "",
          publishedAt: preview?.publishedAt ? new Date(preview.publishedAt) : null,
          url: preview?.url ?? null,
          ...explanation,
        })
      }
      continue
    }

    seenEntryIds.add(relatedEntryId)

    const feed = entry.feedId ? getFeedById(entry.feedId) : undefined
    const subscription = getSubscriptionByEntryId(entry.id)

    relatedEntries.push({
      ...explanation,
      feedTitle: subscription?.title || feed?.title || "",
      id: entry.id,
      publishedAt: entry.publishedAt ?? null,
      title: entry.title || entry.description || entry.id,
      url: entry.url || null,
    })
  }

  return relatedEntries
}

/**
 * Stable key that changes whenever any engine updates its decisions.
 */
export const useEntryProcessingRolesRevision = () => {
  const serviceRevision = useEntryProcessingRoleStore((state) => state.revision)
  const localDedupeRevision = useSemanticDedupeRevision()

  return `${serviceRevision}:${localDedupeRevision}`
}

export const useEntryProcessingRole = (entryId: string): EntryProcessingRole | null => {
  const revision = useEntryProcessingRolesRevision()

  return useMemo(() => {
    void revision
    return resolveEntryProcessingRole(entryId)
  }, [entryId, revision])
}

export const useEntryProcessingRoleRelatedEntries = (entryId: string) => {
  const revision = useEntryProcessingRolesRevision()

  return useMemo(() => {
    void revision
    return getEntryProcessingRoleRelatedEntries(entryId)
  }, [entryId, revision])
}
