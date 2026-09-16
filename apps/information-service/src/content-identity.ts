import type { SourceEntry } from "./folo"
import type { Store } from "./store"

export function xPostId(entry: Pick<SourceEntry, "url">): string | null {
  if (!entry.url) return null
  try {
    const url = new URL(entry.url)
    if (!/^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/u.test(url.hostname)) return null
    return /^\/[^/]+\/status\/(\d+)(?:\/|$)/u.exec(url.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

// 只按可核验原帖身份去重；正文相似和转载标题不算同一内容。
export function contentIdentity(entry: SourceEntry): string {
  const postId = xPostId(entry)
  return postId
    ? `x:${postId}`
    : `${entry.feedKind ?? "feed"}/${entry.feedId ?? entry.sourceKey}/${entry.id}`
}

export function expandXContexts(store: Store) {
  const originals = new Map<string, SourceEntry>()
  for (const input of store.automation.inputs()) {
    const id = xPostId(input.body)
    if (!id) continue
    const previous = originals.get(id)
    if (!previous || (input.body.content?.length ?? 0) > (previous.content?.length ?? 0))
      originals.set(id, input.body)
  }
  store.transaction(() => {
    for (const [postId, original] of originals) {
      for (const context of store.xQueries.postContexts(postId)) {
        // 共享原帖身份但保留每个查询的视图/分类；规则可以产生各自有效的决定。
        store.saveEntry({ ...original, id: `x:${postId}`, sourceKey: context.sourceKey })
      }
    }
  })
}
