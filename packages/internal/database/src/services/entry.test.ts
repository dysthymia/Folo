import type { SQL } from "drizzle-orm"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { EntryService } from "./entry"

const databaseMocks = vi.hoisted(() => ({
  deletedBatches: [] as string[][],
  entryFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
}))

vi.mock("../db", () => ({
  db: {
    query: {
      entriesTable: { findMany: databaseMocks.entryFindMany },
      subscriptionsTable: { findMany: databaseMocks.subscriptionFindMany },
    },
    delete: vi.fn(() => ({
      where: (condition: SQL) => ({
        execute: async () => {
          const query = new SQLiteSyncDialect().sqlToQuery(condition)
          databaseMocks.deletedBatches.push(query.params.map(String))
        },
      }),
    })),
  },
}))

beforeEach(() => {
  databaseMocks.deletedBatches.length = 0
  databaseMocks.entryFindMany.mockReset()
  databaseMocks.subscriptionFindMany.mockReset()
})

describe("EntryService 大列表删除", () => {
  it("hydrate 清理分批删除全部超额条目，并保留原来的每订阅 20 条范围", async () => {
    const entryIds = Array.from({ length: 1221 }, (_, index) => `entry-${index}`)
    databaseMocks.entryFindMany.mockResolvedValue(
      entryIds.map((id) => ({ id, feedId: "feed-1", inboxHandle: null, sources: null })),
    )
    databaseMocks.subscriptionFindMany.mockResolvedValue([
      { feedId: "feed-1", inboxId: null, listId: null },
    ])

    const hydrated = await EntryService.getEntriesToHydrate()
    const deletedIds = databaseMocks.deletedBatches.flat()

    expect(hydrated.map((entry) => entry.id)).toEqual(entryIds.slice(0, 20))
    expect(deletedIds).toEqual(entryIds.slice(20))
    expect(databaseMocks.deletedBatches.map((batch) => batch.length)).toEqual([500, 500, 201])
  })

  it("deleteMany 对大列表使用相同分批边界", async () => {
    const entryIds = Array.from({ length: 1001 }, (_, index) => `delete-${index}`)

    await EntryService.deleteMany(entryIds)

    expect(databaseMocks.deletedBatches.flat()).toEqual(entryIds)
    expect(databaseMocks.deletedBatches.map((batch) => batch.length)).toEqual([500, 500, 1])
  })
})
