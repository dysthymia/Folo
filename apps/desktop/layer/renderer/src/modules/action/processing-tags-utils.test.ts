import { describe, expect, it } from "vitest"

import {
  buildProcessingTagSelectionScopes,
  filterFeedIdsByProcessingTag,
  processingTagNames,
} from "./processing-tags-utils"

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

  it("marks an unavailable List membership as unknown instead of empty", () => {
    const scopes = buildProcessingTagSelectionScopes(
      [
        { key: "feed/1", id: "1", kind: "feed", title: "Feed", view: 0, category: "A" },
        { key: "list/l1", id: "l1", kind: "list", title: "List", view: 0, category: null },
      ],
      [],
    )

    expect(scopes.categories[0]).toMatchObject({ sourceKeys: ["feed/1"] })
    expect(scopes.lists[0]).toMatchObject({ sourceKeys: null, ownerId: null })
  })

  it("only exposes persisted complete List memberships", () => {
    const sources = [
      { key: "list/l1", id: "l1", kind: "list" as const, title: "List", view: 0, category: null },
    ]
    const complete = buildProcessingTagSelectionScopes(sources, [
      {
        listKey: "list/l1",
        ownerId: "owner-list-1",
        feedIds: ["2", "1"],
        complete: true,
        status: "complete",
        revision: 3,
        syncedAt: "2026-09-19T00:00:00.000Z",
      },
    ])
    const unknown = buildProcessingTagSelectionScopes(sources, [
      {
        listKey: "list/l1",
        ownerId: null,
        feedIds: ["1"],
        complete: true,
        status: "unknown",
        revision: 4,
        syncedAt: "2026-09-19T00:00:00.000Z",
      },
    ])

    expect(complete.lists[0]).toMatchObject({
      sourceKeys: ["feed/2", "feed/1"],
      ownerId: "owner-list-1",
      status: "complete",
      revision: 3,
    })
    expect(unknown.lists[0]).toMatchObject({
      sourceKeys: null,
      ownerId: null,
      status: "unknown",
      revision: 4,
    })
  })
})
