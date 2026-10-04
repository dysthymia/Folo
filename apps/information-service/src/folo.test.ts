import { describe, expect, it, vi } from "vitest"

import type { Source, SourceEntry } from "./folo"
import { FoloReader, FoloReadError } from "./folo"
import { inspectMaterialContext } from "./material-context"
import type { readPublicArticle } from "./public-article"
import { PublicArticleError } from "./public-article"
import { sourceText } from "./service"

const token = "test-secret-token"
const apiUrl = "https://api.example.test"
const publishedAt = "2026-09-01T10:00:00.000Z"
const source: Source = {
  key: "feed/f1",
  kind: "feed",
  id: "f1",
  title: "来源",
  view: 0,
  category: null,
}
const entry: SourceEntry = {
  id: "e1",
  sourceKey: source.key,
  title: "文章",
  url: "https://example.test/article",
  publishedAt,
  read: true,
  content: null,
  description: null,
}

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  entries: { id, title: "文章", publishedAt, ...overrides },
  feeds: { id: "f1", type: "feed" },
  read: true,
})

const mockReader = (
  responses: { body: unknown; status?: number }[],
  publicArticle?: typeof readPublicArticle,
) => {
  // 每个用例使用独立响应队列；缺少 mock 会直接失败，绝不访问网络。
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift()
    if (!response) throw new Error("Unexpected mock request")
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  })
  return { reader: new FoloReader({ apiUrl, token, fetch, publicArticle }), fetch }
}

describe("FoloReader", () => {
  // 单条选择不能把任意官方文章绑到用户指定的来源，也不能扫描完整历史来猜归属。
  it.each(["feed", "inbox", "list"] as const)(
    "按当前订阅及官方成员读取 %s 已读原文",
    async (kind) => {
      const selected: Source = {
        ...source,
        kind,
        id: kind === "feed" ? "f1" : kind === "inbox" ? "i1" : "l1",
        key: kind === "feed" ? "feed/f1" : kind === "inbox" ? "inbox/i1" : "list/l1",
      }
      const detailRow =
        kind === "inbox" ? { ...row("e1"), feeds: { id: "i1", type: "inbox" } } : row("e1")
      const { reader, fetch } = mockReader([
        {
          body: {
            code: 0,
            data: [
              {
                [`${kind}Id`]: selected.id,
                [kind === "inbox" ? "inboxes" : `${kind}s`]: { id: selected.id, title: "当前订阅" },
                view: 0,
              },
            ],
          },
        },
        { body: { code: 0, data: detailRow } },
        ...(kind === "list"
          ? [
              {
                body: {
                  code: 0,
                  data: { list: { id: "l1", feeds: [{ id: "f1" }] }, feedCount: 2 },
                },
              },
            ]
          : []),
      ])
      expect(await reader.entry(selected, "e1")).toMatchObject({
        id: "e1",
        sourceKey: selected.key,
        read: true,
        feedId: kind === "inbox" ? "i1" : "f1",
      })
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        `${apiUrl}/subscriptions`,
        `${apiUrl}/entries${kind === "inbox" ? "/inbox" : ""}?id=e1`,
        ...(kind === "list" ? [`${apiUrl}/lists?listId=l1`] : []),
      ])
    },
  )

  it("未订阅来源拒绝读取，即使调用方提供看似合法的来源对象", async () => {
    const { reader, fetch } = mockReader([{ body: { code: 0, data: [] } }])
    await expect(reader.entry(source, "e1")).rejects.toMatchObject({ code: "invalid-input" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...row("e1"), feeds: { id: "other-feed", type: "feed" } },
    { ...row("e1"), feeds: { id: "f1", type: "inbox" } },
  ])("拒绝将别的feed或inbox条目绑定到所选feed", async (detailRow) => {
    const { reader } = mockReader([
      { body: { code: 0, data: [{ feedId: "f1", feeds: { id: "f1" }, view: 0 }] } },
      { body: { code: 0, data: detailRow } },
    ])
    await expect(reader.entry(source, "e1")).rejects.toMatchObject({ code: "invalid-input" })
  })

  it.each([1, 2])("列表实际成员没有目标feed时拒绝，不论成员清单是否完整(%s)", async (feedCount) => {
    const { reader, fetch } = mockReader([
      { body: { code: 0, data: [{ listId: "l1", lists: { id: "l1" }, view: 0 }] } },
      { body: { code: 0, data: row("e1") } },
      { body: { code: 0, data: { list: { id: "l1", feeds: [{ id: "other" }] }, feedCount } } },
    ])
    await expect(
      reader.entry({ ...source, kind: "list", id: "l1", key: "list/l1" }, "e1"),
    ).rejects.toMatchObject({ code: "invalid-input" })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("上游错条目ID拒绝，详情缺读态保持未知", async () => {
    const responses = (detailRow: unknown) => [
      { body: { code: 0, data: [{ feedId: "f1", feeds: { id: "f1" }, view: 0 }] } },
      { body: { code: 0, data: detailRow } },
    ]
    await expect(
      mockReader(responses(row("other-id"))).reader.entry(source, "e1"),
    ).rejects.toMatchObject({ code: "invalid-response" })
    const detailRow = row("e1")
    expect(
      (
        await mockReader(
          responses({ entries: detailRow.entries, feeds: detailRow.feeds }),
        ).reader.entry(source, "e1")
      ).read,
    ).toBeNull()
  })

  it.each([
    { ...source, origin: "generated" as const },
    { ...source, key: "generated:events" },
    { ...source, kind: "x_search" as const, key: "x_search/f1" },
    { ...source, key: "feed/forged" },
  ])("虚拟源或伪造key不发出官方请求", async (selected) => {
    const { reader, fetch } = mockReader([])
    await expect(reader.entry(selected, "e1")).rejects.toMatchObject({ code: "invalid-input" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("官方详情补读明确教程依赖，保留原帖并附真实来源/状态/文本", async () => {
    const original =
      '<p>完整教程详见原文：<a href="https://learn.example.com/guide">迁移指南</a></p>'
    const publicArticle = vi.fn(async (url: string) => ({
      url: `${url}/final`,
      title: "指南",
      text: "先备份数据库。\n迁移后检查版本。",
    }))
    const { reader } = mockReader(
      [{ body: { code: 0, data: row("e1", { content: original }) } }],
      publicArticle,
    )
    const hydrated = await reader.detail(source, entry)
    expect(hydrated.originalContent).toBe(original)
    expect(hydrated.linkedMaterials?.[0]).toMatchObject({
      url: "https://learn.example.com/guide",
      resolvedUrl: "https://learn.example.com/guide/final",
      status: "complete",
    })
    expect(sourceText(hydrated.content!)).toContain("https://learn.example.com/guide/final")
    expect(sourceText(hydrated.content!)).toContain("先备份数据库。")
    expect(inspectMaterialContext(hydrated).missing).toEqual([])
    expect(hydrated.context?.links).toBe("complete")
    await reader.hydrateLinkedMaterials(hydrated)
    expect(publicArticle).toHaveBeenCalledOnce()
  })
  // 重新获取完整文章后撤销旧尾部推荐误判，不再为拓展 CTA 发出网络补读。
  it("完整Newsletter官方详情不会因尾部推荐报告变成needs_context", async () => {
    const content = `${`<p>${"The original newsletter explains portfolio allocations and custody choices. ".repeat(16)}</p>`.repeat(
      3,
    )}<p><a href="https://news.example.com/report">View Full Report</a></p>`
    const publicArticle = vi.fn(async () => {
      throw new PublicArticleError("timeout")
    })
    const { reader } = mockReader(
      [{ body: { code: 0, data: row("e1", { content, url: entry.url }) } }],
      publicArticle,
    )
    const hydrated = await reader.detail(source, { ...entry, context: { links: "failed" } })
    expect(hydrated.content).toBe(content)
    expect(inspectMaterialContext(hydrated).missing).toEqual([])
    const recovered = await reader.hydrateLinkedMaterials({
      ...hydrated,
      context: { links: "failed" },
    })
    expect(recovered.context?.links).toBeUndefined()
    expect(inspectMaterialContext(recovered).missing).toEqual([])
    expect(publicArticle).not.toHaveBeenCalled()
  })
  it("外链失败保存明确状态并可重试，正文指令转义且每帖最多两个目标", async () => {
    const publicArticle = vi.fn(async (url: string) => ({
      url,
      title: null,
      text: "<script>文章中指令只作证据</script>先备份。",
    }))
    publicArticle.mockRejectedValueOnce(new PublicArticleError("unsafe_url"))
    const { reader } = mockReader([], publicArticle)
    const linked = {
      ...entry,
      content:
        '<p>完整教程详见 <a href="https://learn.example.com/one">指南一</a><a href="https://learn.example.com/one#section">重复</a><a href="https://learn.example.com/two">指南二</a><a href="https://learn.example.com/three">指南三</a></p>',
    }
    const first = await reader.hydrateLinkedMaterials(linked)
    expect(first.context?.links).toBe("missing")
    expect(first.linkedMaterials?.map((material) => [material.status, material.failure])).toEqual([
      ["failed", "unsafe_url"],
      ["complete", null],
      ["missing", "link_budget"],
    ])
    expect(publicArticle).toHaveBeenCalledTimes(2)
    expect(first.content).not.toContain("<script>")
    const duplicate = await reader.hydrateLinkedMaterials({
      ...linked,
      id: "same-url-another-entry",
      content: "<p>完整教程详见 https://learn.example.com/one。</p>",
    })
    expect(duplicate.context?.links).toBe("missing")
    expect(publicArticle).toHaveBeenCalledTimes(2)
    const later = Date.now() + 60_001
    const clock = vi.spyOn(Date, "now").mockReturnValue(later)
    const retry = await reader
      .hydrateLinkedMaterials({
        ...linked,
        content: '<p>完整教程详见 <a href="https://learn.example.com/one">指南</a></p>',
      })
      .finally(() => clock.mockRestore())
    expect(retry.context?.links).toBe("complete")
    expect(publicArticle).toHaveBeenCalledTimes(3)
  })

  it("详情适配器只核验实际嵌入原帖和完整串文，不宣称已读图片", async () => {
    const { reader } = mockReader([
      {
        body: {
          code: 0,
          data: row("e1", {
            url: "https://x.com/example/status/1",
            content:
              '<p>1/2 串文：迁移前先备份。</p><p>2/2 新版本支持ARM。</p><blockquote><p>官方今天发布版本3，升级指南已经公开。</p><a href="https://x.com/official/status/2">原帖</a></blockquote><img src="https://example/photo">',
            media: [{ type: "photo" }],
          }),
        },
      },
    ])
    const detail = await reader.detail(source, entry)
    expect(detail.context).toEqual({ quote: "complete", thread: "complete" })
    expect(detail.imageCount).toBe(1)
    expect(detail.context?.images).toBeUndefined()
  })

  it("验证身份并只返回 ownerId 与有效期", async () => {
    const { reader, fetch } = mockReader([
      {
        body: {
          user: { id: "owner", email: "private@example.test" },
          session: { userId: "owner", token, expiresAt: "2099-01-01T00:00:00.000Z" },
        },
      },
    ])
    expect(await reader.session()).toEqual({
      ownerId: "owner",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${apiUrl}/better-auth/get-session`)
    expect(init).toMatchObject({
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: `__Secure-better-auth.session_token=${token}; better-auth.session_token=${token}`,
      },
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    { user: null, session: null },
    { user: { id: "owner" }, session: { userId: "owner", expiresAt: "2000-01-01T00:00:00Z" } },
  ])("拒绝无效或过期会话", async (body) => {
    const { reader } = mockReader([{ body }])
    await expect(reader.session()).rejects.toMatchObject({ code: "unauthorized" })
  })

  it("上游返回 application/json 的字面量 null 时判为授权失效", async () => {
    // 真实 Better Auth 未登录响应是顶层 null，并非 user/session 字段为 null 的对象。
    const { reader, fetch } = mockReader([{ body: null }])
    await expect(reader.session()).rejects.toMatchObject({ code: "unauthorized" })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe(`${apiUrl}/better-auth/get-session`)
  })

  it("会话响应的 JSON 损坏仍报告格式错误并隐藏正文", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(`invalid-json-${token}`, { headers: { "content-type": "application/json" } }),
      )
    const reader = new FoloReader({ apiUrl, token, fetch })
    const error: unknown = await reader.session().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "invalid-response" })
    expect(String(error)).not.toContain(token)
    expect(JSON.stringify(error)).not.toContain(token)
  })

  it("拒绝身份不一致的会话", async () => {
    const { reader } = mockReader([
      { body: { user: { id: "owner" }, session: { userId: "other" } } },
    ])
    await expect(reader.session()).rejects.toMatchObject({ code: "invalid-response" })
  })

  it("读取三类订阅且剥离邮箱 secret 与用户字段", async () => {
    const { reader, fetch } = mockReader([
      {
        body: {
          code: 0,
          data: [
            {
              feedId: "f1",
              feeds: {
                id: "f1",
                title: "Feed",
                siteUrl: "https://feed.example.test",
                url: "https://feed.example.test/rss.xml",
              },
              view: 0,
              category: "研究",
            },
            { listId: "l1", lists: { id: "l1", title: "List" }, view: 1, title: "自定义" },
            {
              inboxId: "i1",
              inboxes: { id: "i1", title: "Inbox", secret: token },
              view: 0,
              userId: "private",
            },
          ],
        },
      },
    ])
    const sources = await reader.sources()
    expect(sources).toEqual([
      {
        key: "feed/f1",
        kind: "feed",
        id: "f1",
        title: "Feed",
        view: 0,
        category: "研究",
        siteUrl: "https://feed.example.test",
        feedUrl: "https://feed.example.test/rss.xml",
        platform: null,
      },
      {
        key: "list/l1",
        kind: "list",
        id: "l1",
        title: "List",
        view: 1,
        category: null,
        siteUrl: null,
        feedUrl: null,
        platform: null,
      },
      {
        key: "inbox/i1",
        kind: "inbox",
        id: "i1",
        title: "Inbox",
        view: 0,
        category: null,
        siteUrl: null,
        feedUrl: null,
        platform: null,
      },
    ])
    expect(JSON.stringify(sources)).not.toContain(token)
    expect(fetch.mock.calls[0]?.[0]).toBe(`${apiUrl}/subscriptions`)
  })

  it.each([
    { feedCount: 2, feedIds: ["f1", "f2"], complete: true },
    { feedCount: 3, feedIds: ["f1", "f2"], complete: false },
    { feedCount: 2, feedIds: ["f1", "missing"], complete: false },
  ])("根据成员总数核对 List 完整性", async ({ feedCount, feedIds, complete }) => {
    const { reader, fetch } = mockReader([
      {
        body: {
          code: 0,
          data: {
            list: {
              id: "l1",
              ownerUserId: "owner-list-1",
              feeds: [{ id: "f1" }, { id: "f2" }],
              feedIds,
            },
            feedCount,
          },
        },
      },
    ])
    expect(await reader.listMembers("l1")).toEqual({
      feedIds: ["f1", "f2"],
      complete,
      ownerId: "owner-list-1",
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(`${apiUrl}/lists?listId=l1`)
  })

  it("List 未返回 ownerUserId 时保持未知，不从其他字段推断", async () => {
    const { reader } = mockReader([
      {
        body: {
          code: 0,
          data: { list: { id: "l1", feeds: [], feedIds: [] }, feedCount: 0 },
        },
      },
    ])

    expect(await reader.listMembers("l1")).toEqual({ feedIds: [], complete: true, ownerId: null })
  })

  it("保留同时间条目并原样暴露时间边界，不声称消除了漏页风险", async () => {
    const { reader, fetch } = mockReader([{ body: { code: 0, data: [row("e1"), row("e2")] } }])
    const page = await reader.page(source, { limit: 2, cursor: publishedAt })
    expect(page).toMatchObject({ nextCursor: publishedAt, pageFull: true, boundaryCount: 2 })
    expect(page.entries.map((item) => item.id)).toEqual(["e1", "e2"])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${apiUrl}/entries`)
    expect(JSON.parse(String(init?.body))).toEqual({
      feedId: "f1",
      limit: 2,
      publishedAfter: publishedAt,
    })
  })

  it("List 查询保留 listId 并接受其成员 feed", async () => {
    const { reader, fetch } = mockReader([{ body: { code: 0, data: [row("e1")] } }])
    const list: Source = { ...source, key: "list/l1", kind: "list", id: "l1" }
    expect((await reader.page(list, { limit: 10 })).entries[0]?.sourceKey).toBe("list/l1")
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ listId: "l1", limit: 10 })
  })

  it("读取官方明确的来源和条目元数据，缺失值不伪造为零", async () => {
    const { reader } = mockReader([
      {
        body: {
          code: 0,
          data: [
            {
              ...row("e1", {
                author: "作者",
                language: "zh",
                updatedAt: "2026-09-02T00:00:00.000Z",
                media: [],
                attachments: [],
              }),
              collections: { createdAt: "2026-09-02T00:00:00.000Z" },
            },
          ],
        },
      },
    ])
    const result = await reader.page(source, { limit: 10 })
    expect(result.entries[0]).toMatchObject({
      author: "作者",
      language: "zh",
      updatedAt: "2026-09-02T00:00:00.000Z",
      collected: true,
      mediaLength: 0,
      attachmentsDuration: 0,
    })
  })

  it("inbox 列表与详情走独立路由且保留阅读状态", async () => {
    const inbox: Source = { ...source, key: "inbox/i1", kind: "inbox", id: "i1" }
    const inboxRow = { ...row("mail1"), feeds: { id: "i1", type: "inbox" } }
    const { reader, fetch } = mockReader([
      { body: { code: 0, data: [inboxRow] } },
      {
        body: {
          code: 0,
          data: {
            entries: { ...inboxRow.entries, content: "<p>邮件正文</p>" },
            feeds: inboxRow.feeds,
          },
        },
      },
    ])
    const page = await reader.page(inbox, { limit: 10 })
    const result = await reader.detail(inbox, page.entries[0]!)
    expect(result).toMatchObject({ content: "<p>邮件正文</p>", read: true, sourceKey: "inbox/i1" })
    expect(fetch.mock.calls[0]?.[0]).toBe(`${apiUrl}/entries/inbox`)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ inboxId: "i1", limit: 10 })
    expect(fetch.mock.calls[1]?.[0]).toBe(`${apiUrl}/entries/inbox?id=mail1`)
  })

  it("空正文与空 readability 保持为空", async () => {
    const { reader, fetch } = mockReader([
      { body: { code: 0, data: row("e1", { content: null }) } },
      { body: { code: 0, data: null } },
      { body: { code: 0, data: [] } },
    ])
    expect(await reader.detail(source, entry)).toMatchObject({ content: null, read: true })
    expect(await reader.readability("e1")).toBeNull()
    expect(await reader.page(source, { limit: 10 })).toEqual({
      entries: [],
      nextCursor: null,
      pageFull: false,
      boundaryCount: 0,
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(`${apiUrl}/entries?id=e1`)
    expect(fetch.mock.calls[1]?.[0]).toBe(`${apiUrl}/entries/readability?id=e1`)
  })

  it.each([
    { status: 401, code: "unauthorized" },
    { status: 403, code: "unauthorized" },
    { status: 302, code: "upstream" },
    { status: 503, code: "upstream" },
  ])("错误与重定向不泄露原始响应", async ({ status, code }) => {
    const { reader, fetch } = mockReader([{ body: { message: token }, status }])
    const error: unknown = await reader.sources().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FoloReadError)
    expect(error).toMatchObject({ code, status })
    expect(String(error)).not.toContain(token)
    expect(JSON.stringify(error)).not.toContain(token)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual")
  })

  it("网络错误被脱敏", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(token))
    const reader = new FoloReader({ apiUrl, token, fetch })
    const error: unknown = await reader.sources().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "network" })
    expect(String(error)).not.toContain(token)
  })

  it("20 秒后中断请求且只暴露网络错误分类", async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error(token)), { once: true })
          }),
      )
      const reader = new FoloReader({ apiUrl, token, fetch })
      const result = reader.sources().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(19_999)
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toMatchObject({ code: "network" })
      expect(String(await result)).not.toContain(token)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { code: 1, data: [], message: token },
    { code: 0, data: [{ ...row("e1"), entries: { id: "e1", publishedAt: "invalid" } }] },
    { code: 0, data: [{ ...row("e1"), feeds: { id: "other", type: "feed" } }] },
  ])("拒绝业务错误和缺乏可信身份或时间的条目", async (body) => {
    const { reader } = mockReader([{ body }])
    await expect(reader.page(source, { limit: 10 })).rejects.toBeInstanceOf(FoloReadError)
  })
})
