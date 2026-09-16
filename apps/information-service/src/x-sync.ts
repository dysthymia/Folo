import type { SourceEntry } from "./folo"
import type { XConfig } from "./x-config"
import type { XQueryStatus, XQueryStore, XSavedQuery } from "./x-query-store"

export type XPost = {
  id: string
  text: string
  createdAt: string
  authorUsername?: string | null
  url?: string | null
  updatedAt?: string | null
}
export type XSearchPage = { posts: XPost[]; nextToken: string | null; newestId: string | null }
export interface XSearchClient {
  search(input: {
    query: string
    sinceId: string | null
    nextToken: string | null
    maxResults: number
    signal?: AbortSignal
  }): Promise<XSearchPage>
}
export type XSyncResult = {
  queryId: string
  entries: number
  pages: number
  status: XQueryStatus
  pending: boolean
}

// 网络实现由接线层显式注入；此模块不会自行读取其他应用凭据或发起 X 请求。
export async function syncXSavedQueries(input: {
  config: XConfig | null
  queries: XQueryStore
  client: XSearchClient
  saveEntry(entry: SourceEntry): void
  // 已订阅的 Folo X 帖子由接线层按原始 post ID 提供，避免双份内容。
  subscribedFoloSource(postId: string): string | null
  pageBudget?: number
  now?: () => string
  signal?: AbortSignal
}): Promise<XSyncResult[]> {
  const now = input.now ?? (() => new Date().toISOString())
  const budget = input.pageBudget ?? 20
  if (!Number.isInteger(budget) || budget < 1) throw new Error("invalid_page_budget")
  if (!input.config?.enabled || !input.config.bearerToken) {
    return input.queries
      .list()
      .filter((query) => query.enabled)
      .map((query) => {
        input.queries.fail(query.id, "unconfigured", now())
        return result(query, 0, 0, input.queries.state(query.id))
      })
  }
  let remaining = budget
  const results: XSyncResult[] = []
  for (const query of input.queries.list().filter((value) => value.enabled)) {
    const previous = input.queries.state(query.id)
    if (previous.retryAt && Date.parse(previous.retryAt) > Date.parse(now())) {
      results.push(result(query, 0, 0, previous))
      continue
    }
    if (input.signal?.aborted) {
      results.push(result(query, 0, 0, input.queries.state(query.id)))
      continue
    }
    if (remaining === 0) {
      input.queries.savePage({
        queryId: query.id,
        nextToken: input.queries.state(query.id).nextToken,
        newestId: null,
        now: now(),
        budget: true,
      })
      results.push(result(query, 0, 0, input.queries.state(query.id)))
      continue
    }
    let state = input.queries.begin(query.id, now())
    let pages = 0
    let entries = 0
    try {
      while (remaining > 0) {
        if (input.signal?.aborted) break
        const page = await input.client.search({
          query: query.query,
          sinceId: state.scanSinceId,
          nextToken: state.nextToken,
          maxResults: 100,
          signal: input.signal,
        })
        pages += 1
        remaining -= 1
        for (const post of page.posts) {
          if (
            input.queries.savePost(
              post.id,
              query.id,
              now(),
              input.subscribedFoloSource(post.id),
              () => input.saveEntry(toEntry(query, post)),
            )
          )
            entries += 1
        }
        input.queries.savePage({
          queryId: query.id,
          nextToken: page.nextToken,
          newestId: page.newestId,
          now: now(),
          budget: remaining === 0 && page.nextToken !== null,
        })
        state = input.queries.state(query.id)
        if (!state.pending || input.signal?.aborted) break
      }
    } catch (error) {
      input.queries.fail(query.id, failure(error), now(), retryAt(error))
    }
    results.push(result(query, entries, pages, input.queries.state(query.id)))
  }
  return results
}

function toEntry(query: XSavedQuery, post: XPost): SourceEntry {
  if (!/^\d{1,30}$/u.test(post.id) || !Number.isFinite(Date.parse(post.createdAt)))
    throw new Error("invalid_x_post")
  return {
    id: `x:${post.id}`,
    sourceKey: query.sourceKey,
    title: post.text.slice(0, 240),
    url: post.url ?? `https://x.com/i/status/${post.id}`,
    publishedAt: new Date(post.createdAt).toISOString(),
    read: null,
    content: post.text,
    description: null,
    author: post.authorUsername ?? null,
    updatedAt: post.updatedAt ?? null,
  }
}
function result(
  query: XSavedQuery,
  entries: number,
  pages: number,
  state: ReturnType<XQueryStore["state"]>,
): XSyncResult {
  return { queryId: query.id, entries, pages, status: state.status, pending: state.pending }
}
function failure(
  error: unknown,
): Extract<
  XQueryStatus,
  "rate_limited" | "forbidden" | "insufficient_access" | "billing" | "failed"
> {
  return error instanceof XApiError ? error.status : "failed"
}
function retryAt(error: unknown): string | null {
  return error instanceof XApiError ? error.retryAt : null
}
export class XApiError extends Error {
  constructor(
    public readonly status: Extract<
      XQueryStatus,
      "rate_limited" | "forbidden" | "insufficient_access" | "billing" | "failed"
    >,
    public readonly retryAt: string | null = null,
  ) {
    super(status)
  }
}
