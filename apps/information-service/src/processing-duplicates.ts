import { createHash } from "node:crypto"

import type { ProcessingInput } from "./automation-store"
import { AutomationError } from "./automation-store"
import type { ProcessingEntryRole } from "./processing-reading-store"
import type { Store } from "./store"

export type ProcessingDuplicateMember = {
  itemId: string
  inputSeq: number | null
  contentVersion: string | null
  title: string | null
  sourceTitle: string | null
  publishedAt: string | null
  url: string | null
  reason: string | null
  canRestore: boolean
  overrideRevision: number | null
}
export type ProcessingDuplicateGroup = {
  representative: ProcessingDuplicateMember
  members: ProcessingDuplicateMember[]
  total: number
  offset: number
  nextOffset: number | null
  fingerprint: string
}

/** 按当前有效角色读取重复组，不依赖浏览器缓存；缺失成员仍保留身份和数量。 */
export function processingDuplicateGroup(
  store: Store,
  inputSeq: number,
  page: { offset: number; limit: number; expectedFingerprint?: string },
): ProcessingDuplicateGroup {
  const roles = store.reading.duplicateRoles(inputSeq)
  const keeper = roles.find((role) => role.inputSeq === inputSeq && role.kind === "keeper")
  const sources = new Map(store.sources().map((source) => [source.key, source]))
  const inputs = new Map(
    store.automation
      .inputs(roles.map((role) => role.inputSeq))
      .filter(
        (input) =>
          input.current &&
          sources.has(input.sourceKey) &&
          !store.stories.isMaterialWithdrawn(input.seq),
      )
      .map((input) => [input.seq, input]),
  )
  const representative = inputs.get(inputSeq)
  if (!keeper || !representative) throw new AutomationError("invalid_target")
  const overrides = new Map(
    store.processingState
      .overrides(roles.map((role) => role.inputSeq))
      .map((override) => [override.inputSeq, override]),
  )
  const memberIds = [...new Set(keeper.relatedEntryIds)].filter((id) => id !== keeper.itemId)
  const related = new Map(
    roles
      .filter(
        (role) =>
          role.kind === "merged" && !role.storyId && role.relatedEntryIds.includes(keeper.itemId),
      )
      .map((role) => [role.itemId, role]),
  )
  const metadata = (
    itemId: string,
    input: ProcessingInput | undefined,
    role?: ProcessingEntryRole,
  ): ProcessingDuplicateMember => ({
    itemId,
    inputSeq: input?.seq ?? null,
    contentVersion: input?.contentVersion ?? null,
    title: input?.body.title || null,
    sourceTitle: input ? (sources.get(input.sourceKey)?.title ?? null) : null,
    publishedAt: input?.body.publishedAt ?? null,
    url: input?.body.url ?? null,
    reason: role?.reason ?? null,
    canRestore: Boolean(
      input && role?.kind === "merged" && overrides.get(input.seq)?.mode !== "restore",
    ),
    overrideRevision: input ? (overrides.get(input.seq)?.revision ?? 0) : null,
  })
  const members = memberIds.map((id) => {
    const role = related.get(id)
    return metadata(id, role ? inputs.get(role.inputSeq) : undefined, role)
  })
  // 分页期间关系或材料换代时拒绝拼接两代成员；刷新从第一页重新核验。
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([inputSeq, representative.contentVersion, members]))
    .digest("hex")
  if (page.expectedFingerprint && page.expectedFingerprint !== fingerprint)
    throw new AutomationError("revision_conflict")
  const end = Math.min(page.offset + page.limit, members.length)
  return {
    representative: metadata(keeper.itemId, representative, keeper),
    members: members.slice(page.offset, end),
    total: members.length,
    offset: page.offset,
    nextOffset: end < members.length ? end : null,
    fingerprint,
  }
}
