import { dedupeEntryIdsByTitle, getEntryTitleDedupeKey } from "@follow/store/entry/utils"
import { describe, expect, it } from "vitest"

describe("dedupeEntryIdsByTitle", () => {
  it("normalizes title whitespace and case", () => {
    expect(getEntryTitleDedupeKey("  Hello   World  ")).toBe("hello world")
  })

  it("keeps the first entry with the same normalized title", () => {
    const titles: Record<string, string | null | undefined> = {
      "entry-1": "Breaking News",
      "entry-2": "  breaking   news ",
      "entry-3": "Another Item",
    }

    expect(
      dedupeEntryIdsByTitle({
        entryIds: ["entry-1", "entry-2", "entry-3"],
        getTitle: (entryId) => titles[entryId],
      }),
    ).toEqual(["entry-1", "entry-3"])
  })

  it("does not dedupe blank or missing titles", () => {
    const titles: Record<string, string | null | undefined> = {
      "entry-1": "",
      "entry-2": "   ",
      "entry-3": undefined,
    }

    expect(
      dedupeEntryIdsByTitle({
        entryIds: ["entry-1", "entry-2", "entry-3"],
        getTitle: (entryId) => titles[entryId],
      }),
    ).toEqual(["entry-1", "entry-2", "entry-3"])
  })
})
