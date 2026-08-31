import { describe, expect, it } from "vitest"

import { sanitizeErrorMessage } from "./error-message"

describe("sanitizeErrorMessage", () => {
  it("removes Follow API request context from display messages", () => {
    const message = [
      "RSSHub feed subscription limit exceeded",
      "Request: POST /subscriptions (original: /subscriptions)",
      "Args: {",
      '  "headers": {',
      '    "cookie": "session=secret"',
      "  }",
      "}",
    ].join("\n")

    expect(sanitizeErrorMessage(message)).toBe("RSSHub feed subscription limit exceeded")
  })

  it("supports CRLF request context", () => {
    expect(
      sanitizeErrorMessage("Subscription limit exceeded\r\nRequest: POST /subscriptions"),
    ).toBe("Subscription limit exceeded")
  })

  it("preserves ordinary error messages", () => {
    expect(sanitizeErrorMessage("Unable to follow this feed")).toBe("Unable to follow this feed")
  })
})
