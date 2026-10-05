import type { AIConfigStore } from "./ai-config"
import type { FoloReader, SourceEntry } from "./folo"
import { FoloReadError } from "./folo"
import { generatedFeedQuerySchema } from "./generated-feeds"
import { readModelCatalog } from "./model-catalog"
import type { Store } from "./store"

// 原生收藏首次打开时采集完整官方清单，再与私人 Story 组成单一冻结分页。
export function nativeReaderApi(options: {
  store: Store
  getReader: () => Promise<FoloReader>
  aiConfig: AIConfigStore
  modelCatalog?: typeof readModelCatalog
}) {
  let collectionSync: Promise<void> | null = null
  const syncCollections = async (signal?: AbortSignal) => {
    const owner = options.store.ownerId
    const reader = await options.getReader()
    if (!owner || (await reader.session()).ownerId !== owner)
      throw new FoloReadError("unauthorized")
    const entries = new Map<string, SourceEntry>()
    let cursor: string | undefined
    // 官方收藏的 publishedAfter 使用 collections.createdAt，不能用文章发布时间漏掉旧文新收藏。
    for (;;) {
      signal?.throwIfAborted()
      const page = await reader.collectionPage({ cursor, limit: 100 })
      const previousCount = entries.size
      for (const entry of page.entries) entries.set(entry.id, entry)
      if (!page.pageFull) break
      // 上游只有时间游标时，整页同刻或游标不前进无法证明完整，保留旧缓存并明确报错。
      if (
        !page.nextCursor ||
        (cursor && entries.size === previousCount) ||
        page.boundaryCount === 100
      )
        throw new FoloReadError("invalid-response")
      // 时间游标下一页重叠边界一毫秒，按 ID 去重，避免同刻收藏被分页切断后遗漏。
      cursor = new Date(Date.parse(page.nextCursor) + 1).toISOString()
    }
    signal?.throwIfAborted()
    if (options.store.ownerId !== owner) throw new FoloReadError("unauthorized")
    options.store.reading.replaceOfficialCollections([...entries.values()])
  }
  return {
    async handle(
      method: string,
      path: string,
      body: unknown,
      signal?: AbortSignal,
    ): Promise<object | undefined> {
      if (path === "/processing/model-catalog" && method === "GET")
        return (options.modelCatalog ?? readModelCatalog)({ signal })
      if (path === "/processing/model-settings") {
        if (method === "GET") return options.aiConfig.publicSettings()
        if (method === "PUT") return options.aiConfig.save(body)
      }
      if (path !== "/processing/generated-feed/items" || !["GET", "POST"].includes(method)) return
      const query = generatedFeedQuerySchema.parse(body ?? {})
      if (query.mode !== "collections") return
      const syncedAt = options.store.reading.officialCollectionsSyncedAt()
      let failure: string | null = null
      // 后续页仅消费冻结列表；刷新或一分钟后的首次页才重查官方收藏。
      if (
        !query.snapshotId &&
        !query.cursor &&
        (query.refresh || !syncedAt || Date.now() - Date.parse(syncedAt) > 60_000)
      ) {
        if (!collectionSync)
          collectionSync = syncCollections(signal).finally(() => {
            collectionSync = null
          })
        try {
          await collectionSync
        } catch (error) {
          // 无完整缓存时绝不返回伪装为空的成功；已有账号内缓存可离线阅读并显示过期状态。
          if (!syncedAt || (error instanceof FoloReadError && error.code === "unauthorized"))
            throw error
          failure = error instanceof FoloReadError ? error.code : "network"
        }
      }
      return {
        ...options.store.reading.generatedPage(query),
        collectionSync: {
          status: failure ? "stale" : "complete",
          syncedAt: options.store.reading.officialCollectionsSyncedAt(),
          failure,
        },
      }
    },
  }
}
