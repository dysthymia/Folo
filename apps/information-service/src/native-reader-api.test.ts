import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import { FoloReader } from "./folo"
import type { GeneratedFeedPage } from "./generated-feeds"
import { nativeReaderApi } from "./native-reader-api"
import { Store } from "./store"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const collectionRow = (index: number) => ({
  entries: {
    id: `entry-${index}`,
    title: `收藏 ${index}`,
    publishedAt: "2020-01-01T00:00:00.000Z",
  },
  feeds: { id: "unsubscribed", type: "feed" },
  view: 1,
  read: false,
  collections: { createdAt: new Date(Date.UTC(2026, 9, 4, 0, 200 - index)).toISOString() },
})
const setup = (responses: unknown[]) => {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  const fetcher = vi.fn<typeof fetch>(async () => {
    const body = responses.shift()
    if (!body) throw new Error("offline")
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  })
  const reader = new FoloReader({
    apiUrl: "https://api.example.test",
    token: "test-token",
    fetch: fetcher,
  })
  const api = nativeReaderApi({
    store,
    getReader: async () => reader,
    aiConfig: new AIConfigStore("/unused-test-model-config"),
  })
  return { api, store, fetcher }
}
const session = { user: { id: "owner" }, session: { userId: "owner" } }
const query = { mode: "collections", limit: 30, refresh: true }

describe("原生收藏采集 API", () => {
  it("按收藏时间采集完整官方分页，不受文章年代或 AI 输入范围限制", async () => {
    const { api, store, fetcher } = setup([
      session,
      { code: 0, data: Array.from({ length: 100 }, (_, index) => collectionRow(index)) },
      {
        code: 0,
        data: [
          collectionRow(99),
          { ...collectionRow(100), collections: collectionRow(99).collections },
        ],
      },
    ])
    const page = (await api.handle(
      "POST",
      "/processing/generated-feed/items",
      query,
    )) as GeneratedFeedPage
    expect(page.total).toBe(101)
    expect(page.items).toHaveLength(30)
    expect(page.items.slice(0, 3).map((item) => item.id)).toEqual(["entry-0", "entry-1", "entry-2"])
    expect(store.automation.inputs()).toHaveLength(0)
    const lastRequest = JSON.parse(String(fetcher.mock.calls[2]![1]?.body)) as {
      publishedAfter: string
      isCollection: boolean
    }
    expect(lastRequest.publishedAfter).toBe(
      new Date(Date.parse(collectionRow(99).collections.createdAt) + 1).toISOString(),
    )
    expect(lastRequest.isCollection).toBe(true)
    expect(page).toMatchObject({ collectionSync: { status: "complete", failure: null } })
    const next = (await api.handle("POST", "/processing/generated-feed/items", {
      ...query,
      snapshotId: page.snapshotId,
      cursor: page.nextCursor,
    })) as GeneratedFeedPage
    expect(next.snapshotId).toBe(page.snapshotId)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it("有完整缓存时离线明确标过期，无缓存失败不伪装为空收藏", async () => {
    const { api, fetcher } = setup([session, { code: 0, data: [collectionRow(0)] }])
    await api.handle("POST", "/processing/generated-feed/items", query)
    const stale = await api.handle("POST", "/processing/generated-feed/items", query)
    expect(stale).toMatchObject({ total: 1, collectionSync: { status: "stale" } })
    expect(fetcher).toHaveBeenCalledTimes(3)
    const empty = setup([])
    await expect(
      empty.api.handle("POST", "/processing/generated-feed/items", query),
    ).rejects.toThrow()
  })

  it("凭据账号与缓存账号不一致时拒绝，不返回旧账号缓存", async () => {
    const { api } = setup([
      session,
      { code: 0, data: [collectionRow(0)] },
      { user: { id: "other" }, session: { userId: "other" } },
    ])
    await api.handle("POST", "/processing/generated-feed/items", query)
    await expect(
      api.handle("POST", "/processing/generated-feed/items", query),
    ).rejects.toMatchObject({ code: "unauthorized" })
  })

  it("时间游标无法前进时拒绝将不完整清单当作完整缓存", async () => {
    const { api, store } = setup([
      session,
      {
        code: 0,
        data: Array.from({ length: 100 }, (_, index) => ({
          ...collectionRow(index),
          collections: { createdAt: "2026-10-04T00:00:00.000Z" },
        })),
      },
    ])
    await expect(
      api.handle("POST", "/processing/generated-feed/items", query),
    ).rejects.toMatchObject({ code: "invalid-response" })
    expect(store.reading.officialCollectionsSyncedAt()).toBeNull()
  })
})

it("模型设置与目录沿用现有认证路由，公开自定义地址而不暴露密钥或读取来源", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-model-api-"))
  const store = new Store(":memory:")
  try {
    store.bindOwner("owner")
    const config = new AIConfigStore(join(directory, "ai.json"))
    const getReader = vi.fn(async () => {
      throw new Error("unexpected_source_read")
    })
    const catalog = {
      models: [
        {
          id: "test-model",
          displayName: "测试",
          description: "本机CLI支持目录",
          reasoningEfforts: ["low"],
          defaultReasoningEffort: "low",
        },
      ],
      source: "rpc" as const,
      fetchedAt: "2026-10-04T00:00:00Z",
      stale: false,
      available: true,
    }
    const modelCatalog = vi.fn(async () => catalog)
    const api = nativeReaderApi({ store, getReader, aiConfig: config, modelCatalog })
    const saved = await api.handle("PUT", "/processing/model-settings", {
      provider: "openai-compatible",
      model: "gateway-model",
      baseUrl: "https://gateway.test/v1",
      apiKey: "private-test-key",
    })
    expect(saved).toEqual({
      provider: "openai-compatible",
      model: "gateway-model",
      baseUrl: "https://gateway.test/v1",
      hasApiKey: true,
    })
    expect(await api.handle("GET", "/processing/model-settings", undefined)).toEqual(saved)
    expect(JSON.stringify(saved)).not.toContain("private-test-key")
    const signal = new AbortController().signal
    expect(await api.handle("GET", "/processing/model-catalog", undefined, signal)).toEqual(catalog)
    expect(modelCatalog).toHaveBeenCalledWith({ signal })
    expect(getReader).not.toHaveBeenCalled()
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
