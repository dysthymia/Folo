import { describe, expect, it } from "vitest"

import { createPostHogBeforeSend, POSTHOG_SAMPLE_RATE } from "./posthog"

describe("PostHogAdapter", () => {
  it("uses a 5% PostHog sample rate", () => {
    expect(POSTHOG_SAMPLE_RATE).toBe(0.05)
  })

  it("drops PostHog events when outside the configured sample rate", () => {
    const beforeSend = createPostHogBeforeSend(0.05, () => 0.5)

    expect(beforeSend({ event: "app init" })).toBeNull()
  })

  it("keeps PostHog events when inside the configured sample rate", () => {
    const beforeSend = createPostHogBeforeSend(0.05, () => 0.04)
    const event = { event: "app init" }

    expect(beforeSend(event)).toBe(event)
  })
})
