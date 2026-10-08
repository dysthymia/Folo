import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { oneTimeToken } from "~/lib/auth"

import type { GeneratedReaderItem } from "./generated-feed-client"
import {
  appendGeneratedPage,
  generatedItemKey,
  loadGeneratedFeedPage,
} from "./generated-feed-client"
import { loadStoryDigest, readingRequest, storyDigestSchema } from "./processing-reader-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))
const story = (revision = 1): GeneratedReaderItem => ({
  id: "s1",
  storyId: "s1",
  kind: "story",
  origin: "generated",
  generatedFeedId: "generated:events",
  title: "事件",
  summary: "事实",
  publishedAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
  read: false,
  collected: false,
  materialCount: 2,
  topics: ["AI"],
  sourceKeys: ["feed/1"],
  revision,
  substantiveRevision: 1,
  hasImportantUpdate: false,
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
const token = () =>
  vi
    .mocked(oneTimeToken.generate)
    .mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
describe("生成阅读客户端", () => {
  it("新差异契约保留引用，兼容旧服务缺失字段，不接受不完整比较范围", () => {
    const legacy = {
      status: "ready",
      storyId: "s1",
      revision: 4,
      title: "综述",
      body: "完整正文",
      updatedAt: "2026-10-03T00:00:00Z",
      sourceCount: 2,
      sources: [],
      sentences: [],
      uncitedSentenceCount: 0,
    }
    expect(storyDigestSchema.safeParse(legacy).success).toBe(true)
    const delta = {
      scope: "since_read",
      fromRevision: 1,
      toRevision: 4,
      currentRevision: 4,
      fromSubstantiveRevision: 1,
      toSubstantiveRevision: 4,
      substantiveUpdateCount: 3,
      added: [
        {
          id: "f1",
          text: "新增反证",
          kind: "source_claim",
          dependencies: [],
          citations: [
            {
              id: "c1",
              quote: "原文",
              sourceKey: "feed/1",
              sourceTitle: "来源",
              sourceUrl: "https://example.com/source",
            },
          ],
        },
      ],
      removed: [],
      revised: [],
    }
    expect(storyDigestSchema.parse({ ...legacy, readDelta: delta })).toMatchObject({
      readDelta: delta,
    })
    expect(
      storyDigestSchema.safeParse({ ...legacy, readDelta: { scope: "since_read" } }).success,
    ).toBe(false)
  })
  it("按稳定身份去重分页及页内重复，不以修订号另建条目", () => {
    expect(generatedItemKey(story(1))).toBe(generatedItemKey(story(2)))
    expect(appendGeneratedPage([], [story(1), story(2)])).toEqual([story(1)])
    expect(appendGeneratedPage([story(1)], [story(2)])).toEqual([story(1)])
  })
  it("把视图和分页范围保留在普通POST正文中", async () => {
    token()
    const result = {
      feed: { id: "generated:events", origin: "generated", title: "事件综述", private: true },
      snapshotId: "123e4567-e89b-42d3-a456-426614174000",
      latestAvailable: false,
      total: 1,
      nextCursor: null,
      items: [story()],
      counts: { pending: 0, failed: 0, needsContext: 0 },
    }
    const fetcher = vi.fn(
      async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(result)),
    )
    vi.stubGlobal("fetch", fetcher)
    const query = {
      mode: "smart" as const,
      view: 0,
      search: "AI",
      unreadOnly: true,
      snapshotId: result.snapshotId,
      cursor: "cursor",
    }
    expect(await loadGeneratedFeedPage(query, new AbortController().signal)).toEqual(result)
    const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).has("X-Folo-Read")).toBe(false)
    expect(JSON.parse(String(init?.body))).toEqual(query)
  })
  it("指定正文版本不会走丢弃body的只读包装；查询不触发人工失效事件", async () => {
    token()
    const fetcher = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            status: "missing",
            storyId: "s1",
            revision: null,
            title: null,
            body: null,
            updatedAt: null,
            sourceCount: 0,
            sources: [],
            sentences: [],
            uncitedSentenceCount: 0,
          }),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    const invalidated = vi.fn()
    window.addEventListener("processing-reading-invalidated", invalidated)
    await loadStoryDigest("s1", new AbortController().signal, 3)
    const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.body).toBe('{"revision":3}')
    expect(invalidated).not.toHaveBeenCalled()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"ok":true}')),
    )
    await readingRequest(
      "processing/entries/1/override",
      z.object({ ok: z.boolean() }),
      new AbortController().signal,
      { mode: "hide" },
    )
    expect(invalidated).toHaveBeenCalledOnce()
    window.removeEventListener("processing-reading-invalidated", invalidated)
  })
})
