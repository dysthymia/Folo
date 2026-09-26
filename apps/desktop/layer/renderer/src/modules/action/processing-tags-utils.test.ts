import { describe, expect, it } from "vitest"

import { filterFeedIdsByProcessingTag, processingTagNames } from "./processing-tags-utils"

const tags = {
  subscriptionTags: {
    formatVersion: 1 as const,
    revision: 1,
    tags: [
      {
        id: "tag-1",
        name: "媒体",
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
      },
    ],
  },
  sourceTags: [{ sourceKey: "feed/1", tagIds: ["tag-1"] }],
}

describe("processing tag UI helpers", () => {
  it("filters feeds and resolves the canonical tag names", () => {
    expect(filterFeedIdsByProcessingTag(["1", "2"], tags.sourceTags, "tag-1")).toEqual(["1"])
    expect(processingTagNames("feed/1", tags)).toEqual(["媒体"])
  })

  it("keeps every feed when the filter is not a specific tag", () => {
    expect(filterFeedIdsByProcessingTag(["1", "2"], tags.sourceTags, "all")).toEqual(["1", "2"])
    // 还没读到绑定关系时不能把列表清空。
    expect(filterFeedIdsByProcessingTag(["1", "2"], undefined, "tag-1")).toEqual([])
  })

  it("drops tag ids that no longer resolve to a tag", () => {
    expect(processingTagNames("feed/1", { ...tags, sourceTags: [] })).toEqual([])
    expect(
      processingTagNames("feed/1", {
        ...tags,
        sourceTags: [{ sourceKey: "feed/1", tagIds: ["tag-1", "deleted-tag"] }],
      }),
    ).toEqual(["媒体"])
  })
})
