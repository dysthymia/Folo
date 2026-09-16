import { DatabaseSync } from "node:sqlite"

import { afterEach, expect, it } from "vitest"

import { XQueryStore } from "./x-query-store"
import type { XSearchClient } from "./x-sync"
import { syncXSavedQueries } from "./x-sync"

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  return new XQueryStore(db, () => "owner")
}
const config = {
  enabled: true,
  bearerToken: "test-only",
  access: "recent_search" as const,
  billingNotice: "configured",
}

it("分页完成前不推进水位，恢复时沿用同一 since_id 与 next_token", async () => {
  const queries = fixture()
  const query = queries.create({ query: "folo", title: "Folo", view: 0, category: "研究" })
  const calls: Array<{ sinceId: string | null; nextToken: string | null }> = []
  const client: XSearchClient = {
    search: async (value) => {
      calls.push({ sinceId: value.sinceId, nextToken: value.nextToken })
      return calls.length === 1
        ? {
            posts: [{ id: "101", text: "first", createdAt: "2026-09-12T00:00:00Z" }],
            newestId: "101",
            nextToken: "next",
          }
        : {
            posts: [{ id: "100", text: "second", createdAt: "2026-09-11T00:00:00Z" }],
            newestId: "100",
            nextToken: null,
          }
    },
  }
  const entries: string[] = []
  await syncXSavedQueries({
    config,
    queries,
    client,
    saveEntry: (entry) => entries.push(entry.id),
    subscribedFoloSource: () => null,
    pageBudget: 1,
  })
  expect(queries.state(query.id)).toMatchObject({
    pending: true,
    highWaterId: null,
    nextToken: "next",
    candidateHighWaterId: "101",
  })
  await syncXSavedQueries({
    config,
    queries,
    client,
    saveEntry: (entry) => entries.push(entry.id),
    subscribedFoloSource: () => null,
  })
  expect(calls).toEqual([
    { sinceId: null, nextToken: null },
    { sinceId: null, nextToken: "next" },
  ])
  expect(queries.state(query.id)).toMatchObject({
    pending: false,
    status: "complete",
    highWaterId: "101",
  })
  expect(entries).toEqual(["x:101", "x:100"])
})

it("未配置、Folo 已订阅原帖与跨查询重复都不生成双份输入", async () => {
  const queries = fixture()
  const first = queries.create({ query: "a", title: "A", view: 1, category: null })
  const second = queries.create({ query: "b", title: "B", view: 2, category: "X" })
  const client: XSearchClient = {
    search: async () => ({
      posts: [
        { id: "9", text: "post", createdAt: "2026-09-12T00:00:00Z" },
        { id: "8", text: "subscribed", createdAt: "2026-09-12T00:00:00Z" },
      ],
      newestId: "9",
      nextToken: null,
    }),
  }
  const saved: string[] = []
  const unconfigured = await syncXSavedQueries({
    config: null,
    queries,
    client,
    saveEntry: () => {
      throw new Error("must not request")
    },
    subscribedFoloSource: () => null,
  })
  expect(unconfigured.map((item) => item.status)).toEqual(["unconfigured", "unconfigured"])
  await syncXSavedQueries({
    config,
    queries,
    client,
    saveEntry: (entry) => saved.push(entry.id),
    subscribedFoloSource: (id) => (id === "8" ? "feed/x" : null),
  })
  expect(saved).toEqual(["x:9"])
  expect(queries.sources()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: first.sourceKey, view: 1, category: null }),
      expect.objectContaining({ key: second.sourceKey, view: 2, category: "X" }),
    ]),
  )
  expect(queries.postContexts("9")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ queryId: first.id, sourceKey: first.sourceKey, view: 1 }),
      expect.objectContaining({ queryId: second.id, sourceKey: second.sourceKey, view: 2 }),
    ]),
  )
})
