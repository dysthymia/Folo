import { FollowAPIError } from "@follow-app/client-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { toastFetchError } from "./error-parser"

const mocks = vi.hoisted(() => ({
  isPaymentEnabled: false,
  showUpgradeRequiredDialog: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("i18next", () => ({
  t: (key: string) => {
    if (key === "errors:2012") {
      return "RSSHub feed subscription limit exceeded"
    }
    return key.replace(/^errors:/u, "")
  },
}))

vi.mock("@/src/atoms/server-configs", () => ({
  getIsPaymentEnabled: () => mocks.isPaymentEnabled,
}))

vi.mock("@/src/modules/dialogs/UpgradeRequiredDialog", () => ({
  showUpgradeRequiredDialog: mocks.showUpgradeRequiredDialog,
}))

vi.mock("./toast", () => ({
  toast: {
    error: mocks.toastError,
  },
}))

describe("toastFetchError", () => {
  beforeEach(() => {
    mocks.isPaymentEnabled = false
    mocks.showUpgradeRequiredDialog.mockClear()
    mocks.toastError.mockClear()
  })

  it("shows a concise upgrade dialog for RSSHub subscription limits", () => {
    mocks.isPaymentEnabled = true
    const error = new FollowAPIError(
      [
        "RSSHub feed subscription limit exceeded",
        "Request: POST /subscriptions (original: /subscriptions)",
        'Args: { "headers": { "cookie": "session=secret" } }',
      ].join("\n"),
      402,
      "2012",
    )

    toastFetchError(error)

    expect(mocks.showUpgradeRequiredDialog).toHaveBeenCalledWith({
      title: "RSSHub feed subscription limit exceeded",
      message: "settings:subscription.summary.free_description",
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("does not expose request context when an API error code has no translation", () => {
    const error = new FollowAPIError(
      [
        "Unable to follow this feed",
        "Request: POST /subscriptions (original: /subscriptions)",
        'Args: { "headers": { "cookie": "session=secret" } }',
      ].join("\n"),
      400,
      "29999",
    )

    toastFetchError(error)

    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith("Unable to follow this feed")
  })
})
