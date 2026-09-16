import { z } from "zod"

import { publicXConfig, readXConfig, saveXConfig } from "./x-config"
import type { XQueryStore } from "./x-query-store"
import type { XSearchClient } from "./x-sync"
import { syncXSavedQueries } from "./x-sync"

// 由主服务把已认证的 store.saveEntry 与 Folo 原帖索引注入；此层不自行执行后台扫描。
export function createXApi(input: {
  configPath: string
  queries: XQueryStore
  client(config: NonNullable<ReturnType<typeof readXConfig>>): XSearchClient
  saveEntry(
    entry: Parameters<typeof syncXSavedQueries>[0]["saveEntry"] extends (entry: infer T) => void
      ? T
      : never,
  ): void
  subscribedFoloSource(postId: string): string | null
}) {
  return {
    async handle(method: string, path: string, body?: unknown): Promise<object | undefined> {
      if (method === "GET" && path === "/x/settings")
        return publicXConfig(readXConfig(input.configPath))
      if (method === "PUT" && path === "/x/settings") return saveXConfig(input.configPath, body)
      if (method === "GET" && path === "/x/queries")
        return {
          queries: input.queries
            .list()
            .map((query) => ({ ...query, state: input.queries.state(query.id) })),
          sources: input.queries.sources(),
        }
      if (method === "POST" && path === "/x/queries") return input.queries.create(body as never)
      const match = /^\/x\/queries\/([^/]+)$/u.exec(path)
      if (match && method === "PUT") return input.queries.update(match[1]!, body as never)
      if (match && method === "DELETE") {
        input.queries.delete(match[1]!)
        return { deleted: true }
      }
      if (method === "POST" && path === "/x/sync") {
        z.object({}).strict().parse(body)
        const config = readXConfig(input.configPath)
        return {
          results: await syncXSavedQueries({
            config,
            queries: input.queries,
            client: config
              ? input.client(config)
              : {
                  search: async () => {
                    throw new Error("unconfigured")
                  },
                },
            saveEntry: input.saveEntry,
            subscribedFoloSource: input.subscribedFoloSource,
          }),
        }
      }
      return undefined
    },
  }
}
