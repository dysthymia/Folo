import type { EntryModel } from "@follow/store/entry/types"
import { getEntryTitleDedupeKey } from "@follow/store/entry/utils"

/** 只扣除已确认被过滤的未读，尚未加载的条目继续保留在服务端未读总数中。 */
export function getFilteredSidebarUnreadCount({
  sourceIds,
  unread,
  entries,
  isBlocked,
  isHidden,
}: {
  sourceIds: readonly string[]
  unread: Record<string, number>
  entries: readonly EntryModel[]
  isBlocked: (entryId: string) => boolean
  isHidden: (entryId: string) => boolean
}) {
  const sources = new Set(sourceIds)
  const excludedBySource = new Map<string, number>()
  const seenTitles = new Set<string>()
  // 与时间线一样先按发布时间排序、按标题去重，再执行动作和处理角色过滤。
  const candidates = entries
    .filter((entry) => !entry.read && sources.has(entry.inboxHandle || entry.feedId || ""))
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())

  for (const entry of candidates) {
    const title = getEntryTitleDedupeKey(entry.title)
    const duplicate = title !== null && seenTitles.has(title)
    if (title !== null) seenTitles.add(title)
    if (!duplicate && !isBlocked(entry.id) && !isHidden(entry.id)) continue

    // 同一条目即使同时命中屏蔽、隐藏和合并也只扣一次，已读条目不参与扣减。
    const sourceId = entry.inboxHandle || entry.feedId!
    excludedBySource.set(sourceId, (excludedBySource.get(sourceId) ?? 0) + 1)
  }

  return [...sources].reduce(
    (count, id) => count + Math.max(0, (unread[id] ?? 0) - (excludedBySource.get(id) ?? 0)),
    0,
  )
}
