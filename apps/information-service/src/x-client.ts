import { z } from "zod"

import type { XSearchClient, XSearchPage } from "./x-sync"
import { XApiError } from "./x-sync"

const schema = z
  .object({
    data: z
      .array(
        z.object({
          id: z.string().regex(/^\d+$/u),
          text: z.string(),
          created_at: z.string(),
          author_id: z.string().optional(),
          edit_history_tweet_ids: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    includes: z
      .object({ users: z.array(z.object({ id: z.string(), username: z.string() })).optional() })
      .passthrough()
      .optional(),
    meta: z
      .object({
        next_token: z.string().optional(),
        newest_id: z.string().optional(),
        result_count: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough()
// 唯一允许的真实网络出口固定为官方 API origin；调用者必须在用户显式 sync 时创建实例。
export class XRecentSearchClient implements XSearchClient {
  constructor(
    private readonly bearerToken: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async search(input: Parameters<XSearchClient["search"]>[0]): Promise<XSearchPage> {
    const url = new URL("https://api.x.com/2/tweets/search/recent")
    url.searchParams.set("query", input.query)
    url.searchParams.set("max_results", String(input.maxResults))
    url.searchParams.set("tweet.fields", "created_at,author_id")
    url.searchParams.set("expansions", "author_id")
    url.searchParams.set("user.fields", "username")
    if (input.sinceId) url.searchParams.set("since_id", input.sinceId)
    if (input.nextToken) url.searchParams.set("next_token", input.nextToken)
    const timeout = AbortSignal.timeout(20_000)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.request(url, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
        signal,
        redirect: "error",
      })
    } catch {
      throw new XApiError("failed")
    }
    const retry = response.headers.get("x-rate-limit-reset")
    const retryAt =
      retry && /^\d+$/u.test(retry) ? new Date(Number(retry) * 1000).toISOString() : null
    if (response.status === 429) throw new XApiError("rate_limited", retryAt)
    if (response.status === 401 || response.status === 403) throw new XApiError("forbidden")
    if (response.status === 402) throw new XApiError("billing")
    if (!response.ok) throw new XApiError("insufficient_access")
    const body = schema.safeParse(await response.json())
    if (!body.success) throw new XApiError("failed")
    // 部分成功响应若同时带错误，不能推进水位并声称该页完整。
    if (body.data.errors?.length) throw new XApiError("failed")
    const users = new Map((body.data.includes?.users ?? []).map((user) => [user.id, user.username]))
    return {
      posts: (body.data.data ?? []).map((post) => ({
        id: post.id,
        text: post.text,
        createdAt: post.created_at,
        authorUsername: post.author_id ? (users.get(post.author_id) ?? null) : null,
      })),
      nextToken: body.data.meta.next_token ?? null,
      newestId: body.data.meta.newest_id ?? null,
    }
  }
}

// 当前只实现 recent endpoint；配置 full archive 时明确拒绝，不能伪装成全历史搜索。
export function createXSearchClient(
  config: { bearerToken: string; access: "recent_search" | "full_archive" },
  request?: typeof fetch,
): XSearchClient {
  if (config.access === "full_archive")
    return {
      search: async () => {
        throw new XApiError("insufficient_access")
      },
    }
  return new XRecentSearchClient(config.bearerToken, request)
}
