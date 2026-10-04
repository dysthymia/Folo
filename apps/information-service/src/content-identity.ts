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

// 只去明确的营销跟踪参数；业务查询条件、语言及版本参数仍是原文身份的一部分。
export function originalUrlIdentity(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    url.hash = ""
    for (const key of [...url.searchParams.keys()])
      if (/^utm_/iu.test(key) || /^(?:fbclid|gclid|mc_cid|mc_eid)$/iu.test(key))
        url.searchParams.delete(key)
    url.searchParams.sort()
    // 首页不是可核验的文章身份，不能把同站所有未提供深链的条目去成一篇。
    if (url.pathname === "/" && !url.search) return null
    return url.toString()
  } catch {
    return null
  }
}

// 原始深链跨 Feed/List 保持一致；正文相似、引用别人的链接和翻译标题不能伪造同一原文。
export function contentIdentity(entry: SourceEntry): string {
  const postId = xPostId(entry)
  const originalUrl = originalUrlIdentity(entry.url)
  return postId
    ? `x:${postId}`
    : originalUrl
      ? `url:${originalUrl}`
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
