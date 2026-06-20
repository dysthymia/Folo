import { describe, expect, it } from "vitest"

import {
  addSelectedItemIdsWithinQuota,
  getInitialSelectedItemIds,
} from "./OpmlSelectionModal.utils"

const itemIds = (items: Set<string>) => [...items]

describe("OPML selection quota helpers", () => {
  it("selects only the remaining quota by default when an OPML file has more feeds", () => {
    expect(itemIds(getInitialSelectedItemIds(375, 74))).toHaveLength(74)
  })

  it("selects all feeds by default when the remaining quota can fit them", () => {
    expect(itemIds(getInitialSelectedItemIds(10, 74))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ])
  })

  it("does not select anything when no quota remains", () => {
    expect(itemIds(getInitialSelectedItemIds(10, 0))).toEqual([])
  })

  it("adds filtered items until the remaining quota is reached", () => {
    const currentItems = new Set(["0", "1", "2"])
    const nextItems = addSelectedItemIdsWithinQuota(currentItems, ["2", "3", "4", "5"], 5)

    expect(itemIds(nextItems)).toEqual(["0", "1", "2", "3", "4"])
  })

  it("does not mutate the current selection when adding within quota", () => {
    const currentItems = new Set(["0"])

    addSelectedItemIdsWithinQuota(currentItems, ["1"], 2)

    expect(itemIds(currentItems)).toEqual(["0"])
  })
})
