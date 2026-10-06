import type { DuplicateGroup } from "./processing-duplicates-client"

const groups = new Map<string, { group: DuplicateGroup; expiresAt: number }>()
let cachedOwner: string | undefined

/** 账号、代表和角色版本共同约束复用；短期缓存有数量上限，不跨账号保留明细。 */
export const duplicateGroupCacheKey = (
  inputSeq: number | undefined,
  entryId: string,
  memberIds: readonly string[],
  revision: string,
) => JSON.stringify([inputSeq, entryId, memberIds, revision])

export const clearDuplicateGroupCache = () => groups.clear()

export const cachedDuplicateGroup = (owner: string | undefined, key: string) => {
  if (owner !== cachedOwner) {
    groups.clear()
    cachedOwner = owner
  }
  if (!owner) return null
  const cached = groups.get(key)
  if (!cached || cached.expiresAt <= Date.now()) {
    groups.delete(key)
    return null
  }
  return cached.group
}

export const cacheDuplicateGroup = (owner: string, key: string, group: DuplicateGroup) => {
  cachedDuplicateGroup(owner, key)
  groups.delete(key)
  groups.set(key, { group, expiresAt: Date.now() + 60_000 })
  if (groups.size > 100) groups.delete(groups.keys().next().value!)
}
