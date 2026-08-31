import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { SharePanel } from "./SharePanel"

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  dismissPopover: vi.fn(),
  getEntry: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@follow/store/entry/getter", () => ({
  getEntry: mocks.getEntry,
}))

vi.mock("~/atoms/popover", () => ({
  dismissPopover: mocks.dismissPopover,
}))

vi.mock("~/lib/client", () => ({
  ipcServices: undefined,
}))

vi.mock("~/lib/clipboard", () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}))

const waitForShareAction = async () => {
  for (let index = 0; index < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const renderSharePanel = async () => {
  const container = document.createElement("div")
  document.body.append(container)

  const root = createRoot(container)
  await act(async () => {
    root.render(<SharePanel entryId="entry-1" />)
  })

  return { container, root }
}

const clickAction = async (container: HTMLElement, label: string) => {
  const button = Array.from(container.querySelectorAll("button")).find((element) =>
    element.textContent?.includes(label),
  )
  expect(button).not.toBeUndefined()

  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await waitForShareAction()
  })
}

describe("SharePanel", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    mocks.getEntry.mockReturnValue({
      description: "Example description",
      id: "entry-1",
      title: "Example entry",
      url: "https://example.com/article",
    })
    mocks.copyToClipboard.mockResolvedValue(undefined)
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
    Reflect.deleteProperty(navigator, "share")
    vi.clearAllMocks()
  })

  test("dismisses after copying the link", async () => {
    ;({ container, root } = await renderSharePanel())

    await clickAction(container, "share.copy_link")

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("https://example.com/article")
    expect(mocks.toastSuccess).toHaveBeenCalledWith("share.link_copied")
    expect(mocks.dismissPopover).toHaveBeenCalledOnce()
  })

  test("keeps the panel open when copying the link fails", async () => {
    mocks.copyToClipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"))
    ;({ container, root } = await renderSharePanel())

    await clickAction(container, "share.copy_link")

    expect(mocks.toastError).toHaveBeenCalledWith("share.copy_failed")
    expect(mocks.dismissPopover).not.toHaveBeenCalled()
  })

  test("dismisses after system sharing completes", async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    })
    ;({ container, root } = await renderSharePanel())

    await clickAction(container, "share.system_share")

    expect(share).toHaveBeenCalledWith({
      text: "Example description | share.discover_more",
      title: "Example entry - Folo",
      url: "https://example.com/article",
    })
    expect(mocks.dismissPopover).toHaveBeenCalledOnce()
  })
})
