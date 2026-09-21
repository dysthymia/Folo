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
 */
export type EntryProcessingRoleKind = "hidden" | "merged" | "keeper" | "story"

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
}

export interface EntryProcessingRelatedEntry {
  feedTitle: string
  id: string
  publishedAt: Date | null
  title: string
  url: string | null
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
}

const defaultState: EntryProcessingRoleStore = {
  revision: 0,
  serviceRoles: {},
}

export const useEntryProcessingRoleStore = createZustandStore<EntryProcessingRoleStore>(
  "entry-processing-role",
)(() => defaultState)

const set = createImmerSetter(useEntryProcessingRoleStore)

export const entryProcessingRoleActions = {
  replaceServiceRoles: (roles: EntryProcessingServiceRole[]) => {
    set((state) => {
      state.serviceRoles = Object.fromEntries(roles.map((role) => [role.entryId, role]))
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
    }
  }

  if (options.localDedupe === false) return null

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

    const entry = getEntry(relatedEntryId)
    if (!entry) continue

    seenEntryIds.add(relatedEntryId)

    const feed = entry.feedId ? getFeedById(entry.feedId) : undefined
    const subscription = getSubscriptionByEntryId(entry.id)

    relatedEntries.push({
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
