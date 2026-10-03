import { describe, expect, it } from "vitest"

import type { ProcessingEntryResult } from "./processing-entry-result-match"
import { resolveProcessingEntryResult } from "./processing-entry-result-match"

const result = (
  sourceKey: string,
  sourceId: string | null,
  inputSeq: number,
): ProcessingEntryResult => ({
  itemId: "entry-1",
  sourceKey,
  sourceId,
  inputSeq,
  decisionId: `decision-${inputSeq}`,
  contentVersion: "v1",
  releaseVersion: 1,
})

describe("resolveProcessingEntryResult", () => {
  it("prefers a direct source decision over a List context for the same entry", () => {
    expect(
      resolveProcessingEntryResult(
        [result("list/one", "feed/a", 1), result("feed/a", "feed/a", 2)],
        "entry-1",
        ["feed/a"],
      )?.inputSeq,
    ).toBe(2)
  })

  it("does not guess when source identity is missing or List contexts conflict", () => {
    expect(
      resolveProcessingEntryResult([result("list/one", null, 1)], "entry-1", ["feed/a"]),
    ).toBeNull()
    expect(
      resolveProcessingEntryResult(
        [result("list/one", "feed/a", 1), result("list/two", "feed/a", 2)],
        "entry-1",
        ["feed/a"],
      ),
    ).toBeNull()
    expect(
      resolveProcessingEntryResult([result("feed/b", "feed/b", 1)], "entry-1", ["feed/a"]),
    ).toBeNull()
  })
})
