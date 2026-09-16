import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import { afterEach, expect, it } from "vitest"

import { createXApi } from "./x-api"
import { XQueryStore } from "./x-query-store"

const dirs: string[] = []
const dbs: DatabaseSync[] = []
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  dbs.splice(0).forEach((db) => db.close())
})
it("配置和 CRUD 路由不配置时不会联网，且要求 owner", async () => {
  const db = new DatabaseSync(":memory:")
  dbs.push(db)
  const queries = new XQueryStore(db, () => "owner")
  const dir = mkdtempSync(`${tmpdir()}/x-api-`)
  dirs.push(dir)
  let calls = 0
  const api = createXApi({
    configPath: `${dir}/x-config.json`,
    queries,
    client: () => ({
      search: async () => {
        calls++
        throw new Error("no")
      },
    }),
    saveEntry: () => undefined,
    subscribedFoloSource: () => null,
  })
  expect(await api.handle("GET", "/x/settings")).toMatchObject({ configured: false })
  const created = (await api.handle("POST", "/x/queries", {
    query: "folo",
    title: "Folo",
    view: 0,
    category: null,
  })) as { id: string }
  expect(await api.handle("GET", "/x/queries")).toMatchObject({
    queries: [expect.objectContaining({ id: created.id })],
  })
  expect(await api.handle("POST", "/x/sync", {})).toMatchObject({
    results: [expect.objectContaining({ status: "unconfigured" })],
  })
  expect(calls).toBe(0)
  await api.handle("DELETE", `/x/queries/${created.id}`)
  expect(await api.handle("GET", "/x/queries")).toMatchObject({ queries: [] })
  expect(() =>
    new XQueryStore(new DatabaseSync(":memory:"), () => null).create({
      query: "x",
      title: "x",
      view: 0,
      category: null,
    }),
  ).toThrow("owner_required")
})

it("不同 owner 看不到彼此查询，修改 query 会清空水位", () => {
  const db = new DatabaseSync(":memory:")
  dbs.push(db)
  let owner = "a"
  const queries = new XQueryStore(db, () => owner)
  const query = queries.create({ query: "old", title: "Old", view: 0, category: null })
  queries.begin(query.id)
  queries.savePage({
    queryId: query.id,
    newestId: "9",
    nextToken: null,
    now: "2026-01-01T00:00:00Z",
  })
  owner = "b"
  expect(queries.list()).toEqual([])
  expect(queries.get(query.id)).toBeNull()
  owner = "a"
  queries.update(query.id, { query: "new", title: "New", view: 0, category: null })
  expect(queries.state(query.id)).toMatchObject({
    highWaterId: null,
    nextToken: null,
    status: "idle",
  })
})
