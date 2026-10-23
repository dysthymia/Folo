import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { InboxSecret } from "./InboxSecret"

const mocks = vi.hoisted(() => ({
  getInboxSecret: vi.fn(),
  toastError: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock("@follow/store/inbox/store", () => ({
  inboxSyncService: {
    getInboxSecret: mocks.getInboxSecret,
  },
}))

vi.mock("~/components/ui/button/AnimatedCommandButton", () => ({
  AnimatedCommandButton: ({
    onClick,
  }: {
    onClick?: React.MouseEventHandler<HTMLButtonElement>
  }) => (
    <button type="button" onClick={onClick}>
      Copy
    </button>
  ),
}))

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}))

const waitForCopy = async () => {
  for (let index = 0; index < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe("InboxSecret", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mocks.writeText,
      },
    })
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }

    container?.remove()
    document.body.innerHTML = ""
    root = null
    container = null
  })

  test("keeps the secret masked while copying the resolved value", async () => {
    mocks.getInboxSecret.mockResolvedValue("server-secret")
    mocks.writeText.mockResolvedValue(undefined)

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<InboxSecret id="test-inbox" />)
    })

    expect(container.textContent).toContain("****")

    await act(async () => {
      container?.querySelector("button")?.click()
      await waitForCopy()
    })

    expect(mocks.getInboxSecret).toHaveBeenCalledWith("test-inbox")
    expect(mocks.writeText).toHaveBeenCalledWith("server-secret")
  })

  test("does not clear the clipboard when the secret cannot be loaded", async () => {
    mocks.getInboxSecret.mockRejectedValue(new Error("Inbox secret is unavailable"))

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<InboxSecret id="test-inbox" />)
    })

    await act(async () => {
      container?.querySelector("button")?.click()
      await waitForCopy()
    })

    expect(mocks.writeText).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledOnce()
  })
})
