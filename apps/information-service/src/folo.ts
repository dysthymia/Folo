import type { EntryListRequest } from "@follow-app/client-sdk"
import { FollowClient } from "@follow-app/client-sdk"
import { z } from "zod"

import { inspectMaterialContext, requiredMaterialLinks } from "./material-context"
import type { PublicArticle } from "./public-article"
import { PublicArticleError, readPublicArticle } from "./public-article"

export type Source = {
  key: string
  kind: "feed" | "list" | "inbox" | "x_search"
  id: string
  title: string
  view: number
  category: string | null
  siteUrl?: string | null
  feedUrl?: string | null
  platform?: string | null
  // 生成综述来源只用于阅读投影，禁止重新进入原文采集。
  origin?: "original" | "generated"
  xUserId?: string | null
  xUsername?: string | null
}

export type LinkedMaterial = {
  url: string
  resolvedUrl: string | null
  title: string | null
  content: string | null
  status: "complete" | "failed" | "missing"
  failure: string | null
}

export type SourceEntry = {
  id: string
  sourceKey: string
  feedId?: string
  feedKind?: "feed" | "inbox"
  title: string
  url: string | null
  publishedAt: string
  read: boolean | null
  content: string | null
  description: string | null
  author?: string | null
  language?: string | null
  updatedAt?: string | null
  collected?: boolean | null
  collectedAt?: string | null
  view?: number
  // 图片与一般视频附件分开计数，避免普通附件误触图片补读保护。
  imageCount?: number | null
  mediaLength?: number | null
  attachmentsDuration?: number | null
  // 原帖与依赖的公开正文分别保留；content 同时包含明确来源标记，供证据处理与阅读使用。
  originalContent?: string | null
  linkedMaterials?: LinkedMaterial[]
  // 只有实际读取过的引用、串文、图片和外链上下文才能标为 complete。
  context?: Partial<
    Record<"quote" | "thread" | "images" | "links", "complete" | "missing" | "failed">
  >
}

export type Page = {
  entries: SourceEntry[]
  nextCursor: string | null
  pageFull: boolean
  boundaryCount: number
}

export type FoloReadErrorCode =
  "unauthorized" | "network" | "upstream" | "invalid-response" | "invalid-input"

export class FoloReadError extends Error {
  constructor(
    public readonly code: FoloReadErrorCode,
    public readonly status?: number,
  ) {
    // 错误只保留分类，避免 SDK 异常中的请求头或上游正文进入日志。
    super(`Folo read failed: ${code}`)
    this.name = "FoloReadError"
  }
}

const identifier = z.string().min(1)
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)))
const optionalUrl = z.string().url().nullish()
const sourceObject = z.object({
  id: identifier,
  title: z.string().nullish(),
  siteUrl: optionalUrl,
  url: optionalUrl,
  feedUrl: optionalUrl,
  platform: z.string().trim().min(1).max(100).nullish(),
})
const subscriptionSchema = z.object({
  feedId: z.string().nullish(),
  listId: z.string().nullish(),
  inboxId: z.string().nullish(),
  title: z.string().nullish(),
  view: z.number().int(),
  category: z.string().nullish(),
  feeds: sourceObject.optional(),
  lists: sourceObject.optional(),
  inboxes: sourceObject.optional(),
})
const entrySchema = z.object({
  id: identifier,
  title: z.string().nullish(),
  url: z.string().nullish(),
  publishedAt: timestamp,
  content: z.string().nullish(),
  description: z.string().nullish(),
  author: z.string().nullish(),
  language: z.string().nullish(),
  updatedAt: timestamp.nullish(),
  media: z.array(z.unknown()).nullish(),
  attachments: z
    .array(z.object({ duration_in_seconds: z.number().finite().nonnegative().nullish() }))
    .nullish(),
})
const entryRowSchema = z.object({
  entries: entrySchema,
  feeds: z.object({ id: identifier, type: z.enum(["feed", "inbox"]) }),
  read: z.boolean().nullish(),
  collections: z.unknown().nullish(),
  view: z.number().int().min(0).max(5).optional(),
})

function attachmentDuration(
  attachments: Array<{ duration_in_seconds?: number | null }> | null | undefined,
) {
  if (attachments === undefined || attachments === null) return null
  if (attachments.length === 0) return 0
  if (
    attachments.some(
      (attachment) =>
        attachment.duration_in_seconds === null || attachment.duration_in_seconds === undefined,
    )
  )
    return null
  return attachments.reduce((total, attachment) => total + attachment.duration_in_seconds!, 0)
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new FoloReadError("invalid-response")
  return result.data
}

function data<T>(schema: z.ZodType<T>, response: unknown): T {
  const envelope = parse(z.object({ code: z.number(), data: z.unknown().optional() }), response)
  if (envelope.code !== 0) throw new FoloReadError("upstream")
  return parse(schema, envelope.data)
}

function toEntry(source: Source, row: z.infer<typeof entryRowSchema>): SourceEntry {
  const expectedKind = source.kind === "inbox" ? "inbox" : "feed"
  if (row.feeds.type !== expectedKind || (source.kind !== "list" && row.feeds.id !== source.id)) {
    throw new FoloReadError("invalid-response")
  }
  const entry: SourceEntry = {
    id: row.entries.id,
    sourceKey: source.key,
    // 保留 List 条目的实际来源身份，分类上下文仍由 sourceKey 区分。
    feedId: row.feeds.id,
    feedKind: row.feeds.type,
    title: row.entries.title ?? "",
    url: row.entries.url ?? null,
    publishedAt: row.entries.publishedAt,
    read: row.read ?? null,
    content: row.entries.content ?? null,
    description: row.entries.description ?? null,
    author: row.entries.author ?? null,
    language: row.entries.language ?? null,
    updatedAt: row.entries.updatedAt ?? null,
    collected: row.collections === undefined || row.collections === null ? null : true,
    imageCount:
      row.entries.media?.filter(
        (media) => media && typeof media === "object" && Reflect.get(media, "type") === "photo",
      ).length ?? null,
    mediaLength:
      row.entries.media === undefined || row.entries.media === null
        ? null
        : row.entries.media.length,
    // 官方附件 duration_in_seconds 为秒；未知附件时保持 null，不能当作 0 秒。
    attachmentsDuration: attachmentDuration(row.entries.attachments),
  }
  // Feed 正文已包含的嵌入引用/完整串文可直接核验，不把下载图片误认为已读图片。
  const verified = inspectMaterialContext(entry).verified
  if (Object.keys(verified).length) entry.context = verified
  return entry
}

export class FoloReader {
  private readonly client: FollowClient
  private readonly publicArticle: (
    url: string,
    options?: { signal?: AbortSignal },
  ) => Promise<PublicArticle>
  private readonly linkedReads = new Map<
    string,
    { startedAt: number; promise: Promise<PublicArticle> }
  >()

  constructor(options: {
    apiUrl: string
    token: string
    fetch?: typeof fetch
    publicArticle?: typeof readPublicArticle
  }) {
    this.publicArticle = options.publicArticle ?? readPublicArticle
    let apiUrl: URL
    let token = options.token
    try {
      apiUrl = new URL(options.apiUrl)
      if (token.includes("%")) token = decodeURIComponent(token)
    } catch {
      throw new FoloReadError("invalid-input")
    }
    if (!token) throw new FoloReadError("unauthorized")
    if (
      !["http:", "https:"].includes(apiUrl.protocol) ||
      apiUrl.username ||
      apiUrl.password ||
      /[\s;]/u.test(token)
    ) {
      throw new FoloReadError("invalid-input")
    }

    const requestFetch = options.fetch ?? globalThis.fetch
    const safeFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== apiUrl.origin) throw new FoloReadError("invalid-input")
      let response: Response
      try {
        // 禁止自动跟随重定向，防止 Cookie 与 Bearer 被送往其他地址。
        response = await requestFetch(input, { ...init, redirect: "manual" })
      } catch {
        throw new FoloReadError("network")
      }
      if (response.status === 401 || response.status === 403) {
        throw new FoloReadError("unauthorized", response.status)
      }
      if (!response.ok || response.redirected) {
        throw new FoloReadError("upstream", response.status)
      }
      return response
    }
    this.client = new FollowClient({
      baseURL: apiUrl.toString(),
      timeout: 20_000,
      fetch: safeFetch,
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: `__Secure-better-auth.session_token=${token}; better-auth.session_token=${token}`,
      },
    })
  }

  private async request(operation: () => Promise<unknown>): Promise<unknown> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof FoloReadError) throw error
      throw new FoloReadError("invalid-response")
    }
  }

  async session(): Promise<{ ownerId: string; expiresAt: string | null }> {
    const response: unknown = await this.request(async () => {
      // Better Auth 会以顶层 null 表示失效会话；绕过 SDK 对 null 执行 in 运算的解析缺陷。
      const raw = await this.client.request<Response>("/better-auth/get-session", {
        method: "GET",
        asRaw: true,
      })
      return raw.json()
    })
    if (
      response === null ||
      (typeof response === "object" &&
        (Reflect.get(response, "user") === null || Reflect.get(response, "session") === null))
    ) {
      throw new FoloReadError("unauthorized")
    }
    const result = parse(
      z.object({
        code: z.number().optional(),
        user: z.object({ id: identifier }),
        session: z.object({ userId: identifier, expiresAt: timestamp.nullish() }),
      }),
      response,
    )
    if (result.code !== undefined && result.code !== 0) throw new FoloReadError("upstream")
    if (result.user.id !== result.session.userId) throw new FoloReadError("invalid-response")
    if (result.session.expiresAt && Date.parse(result.session.expiresAt) <= Date.now()) {
      throw new FoloReadError("unauthorized")
    }
    return { ownerId: result.user.id, expiresAt: result.session.expiresAt ?? null }
  }

  async sources(): Promise<Source[]> {
    const response = await this.request(() => this.client.api.subscriptions.get({}))
    return data(z.array(subscriptionSchema), response).map((row) => {
      const variants = [row.feeds, row.lists, row.inboxes].filter(Boolean)
      if (variants.length !== 1) throw new FoloReadError("invalid-response")
      const kind = row.feeds ? "feed" : row.lists ? "list" : "inbox"
      const item = row.feeds ?? row.lists ?? row.inboxes
      const id = kind === "feed" ? row.feedId : kind === "list" ? row.listId : row.inboxId
      if (!item || !id || id !== item.id) throw new FoloReadError("invalid-response")
      // 显式挑选字段，邮箱 secret、用户信息等不进入持久化来源快照。
      return {
        key: `${kind}/${id}`,
        kind,
        id,
        // feed/list 实体标题才是来源标题；订阅自定义名称不替代实际来源身份。
        title: item.title ?? row.title ?? id,
        view: row.view,
        category: row.category ?? null,
        siteUrl: item.siteUrl ?? null,
        // 官方 Feed 使用 url 表示 RSS/Atom 地址；兼容已见过的 feedUrl 返回名。
        feedUrl: item.url ?? item.feedUrl ?? null,
        platform: item.platform ?? null,
      }
    })
  }

  async listMembers(
    listId: string,
  ): Promise<{ feedIds: string[]; complete: boolean; ownerId: string | null }> {
    const response = await this.request(() => this.client.api.lists.get({ listId }))
    const result = data(
      z.object({
        list: z.object({
          id: identifier,
          // SDK GetListData.list 使用 ListSchema，真实类型提供 ownerUserId；仅保存稳定 ID。
          ownerUserId: identifier.nullish(),
          feeds: z.array(z.object({ id: identifier })),
          feedIds: z.array(identifier).optional(),
        }),
        feedCount: z.number().int().nonnegative().optional(),
      }),
      response,
    )
    if (result.list.id !== listId) throw new FoloReadError("invalid-response")
    const feedIds = [...new Set(result.list.feeds.map((feed) => feed.id))]
    const declaredIds = result.list.feedIds
    return {
      feedIds,
      ownerId: result.list.ownerUserId ?? null,
      complete:
        result.feedCount === feedIds.length &&
        (!declaredIds ||
          (declaredIds.length === feedIds.length &&
            declaredIds.every((id) => feedIds.includes(id)))),
    }
  }

  async page(source: Source, options: { cursor?: string; limit: number }): Promise<Page> {
    // 外部搜索使用独立官方适配器，不能把虚拟来源 ID 发给 Folo API。
    if (
      source.origin === "generated" ||
      source.key.startsWith("generated:") ||
      source.kind === "x_search"
    )
      throw new FoloReadError("invalid-input")
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100 ||
      (options.cursor !== undefined && !timestamp.safeParse(options.cursor).success)
    ) {
      throw new FoloReadError("invalid-input")
    }
    const pagination = { publishedAfter: options.cursor, limit: options.limit }
    const query: EntryListRequest & { listId?: string } = {
      ...pagination,
      ...(source.kind === "list" ? { listId: source.id } : { feedId: source.id }),
    }
    // read 与 aiSort 均省略：采集所有阅读状态，并沿用上游时间分页。
    const response = await this.request(() =>
      source.kind === "inbox"
        ? this.client.api.entries.inbox.list({ ...pagination, inboxId: source.id })
        : this.client.api.entries.list(query),
    )
    const entries = data(z.array(entryRowSchema), response).map((row) => toEntry(source, row))
    const nextCursor = entries.at(-1)?.publishedAt ?? null
    return {
      entries,
      nextCursor,
      pageFull: entries.length >= options.limit,
      boundaryCount: entries.filter((entry) => entry.publishedAt === nextCursor).length,
    }
  }

  // 官方收藏列表按收藏时间分页，范围不受 AI 计划或当前订阅名单限制。
  async collectionPage(options: { cursor?: string; limit: number }): Promise<Page> {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100 ||
      (options.cursor !== undefined && !timestamp.safeParse(options.cursor).success)
    )
      throw new FoloReadError("invalid-input")
    const response = await this.request(() =>
      this.client.api.entries.list({
        isCollection: true,
        publishedAfter: options.cursor,
        limit: options.limit,
      }),
    )
    const rows = data(
      z.array(
        entryRowSchema.extend({
          collections: z.object({ createdAt: timestamp }),
        }),
      ),
      response,
    )
    const entries = rows.map((row) => ({
      ...toEntry(
        {
          key: `${row.feeds.type}/${row.feeds.id}`,
          kind: row.feeds.type,
          id: row.feeds.id,
          title: row.feeds.id,
          view: row.view ?? 0,
          category: null,
        },
        row,
      ),
      collected: true,
      collectedAt: row.collections.createdAt,
      view: row.view,
    }))
    const nextCursor = entries.at(-1)?.collectedAt ?? null
    return {
      entries,
      nextCursor,
      pageFull: entries.length >= options.limit,
      boundaryCount: entries.filter((item) => item.collectedAt === nextCursor).length,
    }
  }

  // 显式研究选材可读取已读原文；先核验当前订阅及真实归属，绝不依赖调用方伪造 sourceKey。
  async entry(source: Source, entryId: string): Promise<SourceEntry> {
    if (
      source.origin === "generated" ||
      source.key.startsWith("generated:") ||
      source.kind === "x_search" ||
      !identifier.safeParse(entryId).success ||
      !entryId.trim() ||
      source.key !== `${source.kind}/${source.id}`
    )
      throw new FoloReadError("invalid-input")
    const subscribed = (await this.sources()).find(
      (item) => item.key === source.key && item.kind === source.kind && item.id === source.id,
    )
    if (!subscribed) throw new FoloReadError("invalid-input")
    const response = await this.request(() =>
      subscribed.kind === "inbox"
        ? this.client.api.entries.inbox.get({ id: entryId })
        : this.client.api.entries.get({ id: entryId }),
    )
    const row = data(entryRowSchema, response)
    if (row.entries.id !== entryId) throw new FoloReadError("invalid-response")
    if (subscribed.kind === "list") {
      if (row.feeds.type !== "feed") throw new FoloReadError("invalid-input")
      const members = await this.listMembers(subscribed.id)
      // 已返回的成员是正向归属证据；未返回目标 feed 时即使清单不完整也拒绝，不扫描历史猜测。
      if (!members.feedIds.includes(row.feeds.id)) throw new FoloReadError("invalid-input")
    } else if (row.feeds.type !== subscribed.kind || row.feeds.id !== subscribed.id) {
      throw new FoloReadError("invalid-input")
    }
    return this.hydrateLinkedMaterials(toEntry(subscribed, row))
  }

  async detail(
    source: Source,
    entry: SourceEntry,
    options: { signal?: AbortSignal; includeLinkedMaterials?: boolean } = {},
  ): Promise<SourceEntry> {
    if (
      source.origin === "generated" ||
      source.key.startsWith("generated:") ||
      source.kind === "x_search"
    )
      throw new FoloReadError("invalid-input")
    if (entry.sourceKey !== source.key) throw new FoloReadError("invalid-input")
    const response = await this.request(() =>
      source.kind === "inbox"
        ? this.client.api.entries.inbox.get({ id: entry.id })
        : this.client.api.entries.get({ id: entry.id }),
    )
    const result = toEntry(source, data(entryRowSchema, response))
    if (result.id !== entry.id) throw new FoloReadError("invalid-response")
    // 详情接口没有阅读状态，不能把之前读过的文章重置成未读。
    const detail = { ...result, read: entry.read }
    // 后台先完成官方正文提取，再统一补外链，避免同一轮失败立即重复请求。
    return options.includeLinkedMaterials === false
      ? detail
      : this.hydrateLinkedMaterials(detail, options.signal)
  }

  // 补读至多两个去重目标，保留原帖并附真实 URL/状态；网页文字仅作证据，不产生执行权限。
  async hydrateLinkedMaterials(entry: SourceEntry, signal?: AbortSignal): Promise<SourceEntry> {
    const urls = requiredMaterialLinks(entry)
    if (!urls.length) {
      if (!entry.context?.links) return entry
      // 链接状态是正文依赖的派生结果；完整正文恢复后清除旧误判，抓取记录仍保留供审计。
      const context = { ...entry.context }
      delete context.links
      return { ...entry, context }
    }
    const originalContent = entry.originalContent ?? entry.content ?? ""
    const linkedMaterials: LinkedMaterial[] = []
    for (const [index, url] of urls.entries()) {
      signal?.throwIfAborted()
      const existing = entry.linkedMaterials?.find(
        (material) => material.url === url && material.status === "complete" && material.content,
      )
      if (existing) {
        linkedMaterials.push(existing)
        continue
      }
      if (index >= 2) {
        linkedMaterials.push({
          url,
          resolvedUrl: null,
          title: null,
          content: null,
          status: "missing",
          failure: "link_budget",
        })
        continue
      }
      try {
        let cached = this.linkedReads.get(url)
        if (!cached || Date.now() - cached.startedAt > 60_000) {
          cached = { startedAt: Date.now(), promise: this.publicArticle(url, { signal }) }
          this.linkedReads.set(url, cached)
          if (this.linkedReads.size > 100)
            this.linkedReads.delete(this.linkedReads.keys().next().value!)
        }
        const article = await cached.promise
        if (!article.text.trim()) throw new PublicArticleError("empty")
        linkedMaterials.push({
          url,
          resolvedUrl: article.url,
          title: article.title,
          content: article.text,
          status: "complete",
          failure: null,
        })
      } catch (error) {
        // 普通失败在本轮/一分钟内复用，避免同一失败 URL 反复消耗八秒；取消不缓存。
        if (signal?.aborted) this.linkedReads.delete(url)
        signal?.throwIfAborted()
        linkedMaterials.push({
          url,
          resolvedUrl: null,
          title: null,
          content: null,
          status: "failed",
          failure: error instanceof PublicArticleError ? error.code : "network",
        })
      }
    }
    const escape = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
    const content =
      originalContent +
      linkedMaterials
        .map(
          (material) =>
            `<section data-folo-linked-material><p>关联材料来源：<a href="${escape(material.resolvedUrl ?? material.url)}">${escape(material.resolvedUrl ?? material.url)}</a>；获取状态：${material.status}${material.failure ? ` (${escape(material.failure)})` : ""}</p>${material.content ? `<pre>${escape(material.content)}</pre>` : ""}</section>`,
        )
        .join("\n")
    const hydrated = {
      ...entry,
      originalContent,
      content,
      linkedMaterials,
      context: { ...entry.context },
    }
    hydrated.context.links =
      inspectMaterialContext(hydrated).verified.links === "complete" ? "complete" : "missing"
    return hydrated
  }

  async readability(entryId: string): Promise<string | null> {
    const response = await this.request(() => this.client.api.entries.readability({ id: entryId }))
    return data(z.object({ content: z.string().nullish() }).nullable(), response)?.content ?? null
  }

  async chatEntry(entryId: string, sources: Source[]): Promise<SourceEntry> {
    // 当前文章可能尚未扫描入本地库；从官方接口读取并核验其订阅归属。
    const response = await this.request(() => this.client.api.entries.get({ id: entryId }))
    const row = data(entryRowSchema, response)
    const source = sources.find((item) => item.kind === row.feeds.type && item.id === row.feeds.id)
    if (!source || row.entries.id !== entryId) throw new FoloReadError("invalid-input")
    return toEntry(source, row)
  }
}
