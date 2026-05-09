import { describe, expect, it } from "vitest"

import { getEntrySourceColor, getEntrySourceColorStyle } from "./source-color"

describe("entry source colors", () => {
  it("returns stable colors for the same source", () => {
    expect(getEntrySourceColor("feed-36kr")).toEqual(getEntrySourceColor("feed-36kr"))
  })

  it("varies colors across source keys", () => {
    expect(getEntrySourceColor("feed-36kr")).not.toEqual(getEntrySourceColor("feed-hacker-news"))
  })

  it("returns no style for empty source keys", () => {
    expect(getEntrySourceColorStyle("")).toBeUndefined()
    expect(getEntrySourceColorStyle(null)).toBeUndefined()
  })

  it("exposes list background variables", () => {
    expect(getEntrySourceColorStyle("feed-36kr")).toMatchObject({
      "--entry-source-background": expect.stringMatching(/^hsl\(\d+, \d+%, 80%\)$/),
      "--entry-source-background-hover": expect.stringMatching(/^hsl\(\d+, \d+%, 85%\)$/),
      "--entry-source-background-read": expect.stringMatching(/^hsl\(\d+, \d+%, 90%\)$/),
      "--entry-source-background-read-hover": expect.stringMatching(/^hsl\(\d+, \d+%, 95%\)$/),
    })
  })
})
