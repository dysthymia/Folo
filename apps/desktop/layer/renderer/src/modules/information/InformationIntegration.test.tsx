import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { InformationIntegration } from "./InformationIntegration"

const mocks = vi.hoisted(() => ({
  confirmExport: vi.fn(),
  loadIntegrationSettings: vi.fn(),
  prepareExport: vi.fn(),
  reconcileExport: vi.fn(),
  saveIntegrationSettings: vi.fn(),
}))

vi.mock("./information-integration-client", () => ({
  confirmExport: mocks.confirmExport,
  IntegrationRequestError: class IntegrationRequestError extends Error {
    constructor(readonly kind: "authorization" | "conflict" | "request") {
      super(kind)
    }
  },
  loadIntegrationSettings: mocks.loadIntegrationSettings,
  prepareExport: mocks.prepareExport,
  reconcileExport: mocks.reconcileExport,
  saveIntegrationSettings: mocks.saveIntegrationSettings,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const settings = { integrations: { notion: { enabled: true, parentPageId: "parent-1" } } }
const exportRecord = {
  id: "export-1",
  storyId: "story-1",
  revision: 2,
  destinationId: "parent-1",
  contentHash: "hash-1",
  status: "prepared" as const,
  notionPageId: null,
  retryAfter: null,
  error: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
}
const preview = {
  storyId: "story-1",
  revision: 2,
  title: "冻结标题",
  markdown: "# 冻结正文",
  references: [],
}

const render = async (storyId?: string) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<InformationIntegration {...(storyId ? { storyId } : {})} />)
    await Promise.resolve()
  })
  return { container, root }
}

const setValue = async (element: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  expect(setter).toBeDefined()
  await act(async () => {
    setter!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

describe("InformationIntegration", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    document.body.innerHTML = ""
    root = null
    container = null
    vi.clearAllMocks()
    mocks.loadIntegrationSettings.mockResolvedValue(settings)
  })

  it("does not load a token into the password input and omits an empty token on save", async () => {
    mocks.loadIntegrationSettings.mockResolvedValue(settings)
    mocks.saveIntegrationSettings.mockResolvedValue(settings)
    ;({ container, root } = await render())
    const inputs = container.querySelectorAll("input")
    expect((inputs[2] as HTMLInputElement).type).toBe("password")
    expect((inputs[2] as HTMLInputElement).value).toBe("")
    await setValue(inputs[1] as HTMLInputElement, "parent-2")
    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("information.integration.save"),
    ) as HTMLButtonElement
    await click(saveButton)
    expect(mocks.saveIntegrationSettings).toHaveBeenCalledWith(
      { notion: { enabled: true, parentPageId: "parent-2" } },
      expect.any(AbortSignal),
    )
    expect(container.textContent).not.toContain("secret")
  })

  it("prepares a frozen preview before confirmation", async () => {
    mocks.loadIntegrationSettings.mockResolvedValue(settings)
    mocks.prepareExport.mockResolvedValue({ export: exportRecord, preview })
    ;({ container, root } = await render("story-1"))
    const destination = container.querySelector("input") as HTMLInputElement
    await setValue(destination, "page-1")
    const prepareButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("information.integration.preview"),
    ) as HTMLButtonElement
    await click(prepareButton)
    expect(mocks.prepareExport).toHaveBeenCalledWith("story-1", "page-1", expect.any(AbortSignal))
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("# 冻结正文")
    expect(mocks.confirmExport).not.toHaveBeenCalled()
  })

  it("confirms only after the user clicks confirm", async () => {
    mocks.loadIntegrationSettings.mockResolvedValue(settings)
    mocks.prepareExport.mockResolvedValue({ export: exportRecord, preview })
    mocks.confirmExport.mockResolvedValue({ export: { ...exportRecord, status: "succeeded" } })
    ;({ container, root } = await render("story-1"))
    await setValue(container.querySelector("input") as HTMLInputElement, "page-1")
    const prepareButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("information.integration.preview"),
    ) as HTMLButtonElement
    await click(prepareButton)
    const confirmButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("information.integration.confirm"),
    ) as HTMLButtonElement
    await click(confirmButton)
    expect(mocks.confirmExport).toHaveBeenCalledWith("export-1", expect.any(AbortSignal))
    expect(container.textContent).toContain("information.integration.status.succeeded")
  })

  it("offers reconciliation for unknown results and no retry or confirm", async () => {
    mocks.loadIntegrationSettings.mockResolvedValue(settings)
    mocks.prepareExport.mockResolvedValue({
      export: { ...exportRecord, status: "unknown" },
      preview,
    })
    mocks.reconcileExport.mockResolvedValue({ export: { ...exportRecord, status: "succeeded" } })
    ;({ container, root } = await render("story-1"))
    await setValue(container.querySelector("input") as HTMLInputElement, "page-1")
    await click(
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("information.integration.preview"),
      ) as HTMLButtonElement,
    )
    expect(container.textContent).toContain("information.integration.unknown_hint")
    expect(container.textContent).toContain("information.integration.reconcile")
    expect(container.textContent).not.toContain("information.integration.confirm")
    await click(
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("information.integration.reconcile"),
      ) as HTMLButtonElement,
    )
    expect(mocks.reconcileExport).toHaveBeenCalledWith("export-1", expect.any(AbortSignal))
  })

  it("does not show success when preparing fails", async () => {
    mocks.loadIntegrationSettings.mockResolvedValue(settings)
    mocks.prepareExport.mockRejectedValue(new Error("offline"))
    ;({ container, root } = await render("story-1"))
    await setValue(container.querySelector("input") as HTMLInputElement, "page-1")
    await click(
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("information.integration.preview"),
      ) as HTMLButtonElement,
    )
    expect(container.textContent).toContain("information.integration.error.request")
    expect(container.textContent).not.toContain("information.integration.status.succeeded")
  })
})
