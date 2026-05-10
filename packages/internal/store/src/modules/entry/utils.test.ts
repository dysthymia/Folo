import { describe, expect, it } from "vitest"

import { compareEntriesByInsertedAtDesc } from "./utils"

describe("compareEntriesByInsertedAtDesc", () => {
  it("prioritizes inserted time over published time", () => {
    const sorted = [
      {
        id: "newer-published-older-inserted",
        insertedAt: "2026-05-10T00:00:00.000Z",
        publishedAt: "2026-05-10T09:00:00.000Z",
      },
      {
        id: "older-published-newer-inserted",
        insertedAt: "2026-05-10T01:00:00.000Z",
        publishedAt: "2026-05-09T09:00:00.000Z",
      },
    ].sort(compareEntriesByInsertedAtDesc)

    expect(sorted.map((entry) => entry.id)).toEqual([
      "older-published-newer-inserted",
      "newer-published-older-inserted",
    ])
  })

  it("falls back to published time and id for stable ties", () => {
    const sorted = [
      {
        id: "c",
        insertedAt: "2026-05-10T00:00:00.000Z",
        publishedAt: "2026-05-10T07:00:00.000Z",
      },
      {
        id: "a",
        insertedAt: "2026-05-10T00:00:00.000Z",
        publishedAt: "2026-05-10T07:00:00.000Z",
      },
      {
        id: "b",
        insertedAt: "2026-05-10T00:00:00.000Z",
        publishedAt: "2026-05-10T08:00:00.000Z",
      },
    ].sort(compareEntriesByInsertedAtDesc)

    expect(sorted.map((entry) => entry.id)).toEqual(["b", "a", "c"])
  })
})
