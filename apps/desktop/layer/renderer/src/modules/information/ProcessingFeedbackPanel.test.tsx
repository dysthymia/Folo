import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { ProcessingFeedbackPanel } from "./ProcessingFeedbackPanel"

const mocks = vi.hoisted(() => ({ saveProcessingFeedback: vi.fn() }))

vi.mock("./processing-feedback-client", () => ({
  FeedbackRequestError: class FeedbackRequestError extends Error {
    constructor(readonly kind: "authorization" | "conflict" | "request") {
      super(kind)
    }
  },
  saveProcessingFeedback: mocks.saveProcessingFeedback,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ""}`,
  }),
}))

const renderPanel = async (
  target: Parameters<typeof ProcessingFeedbackPanel>[0]["target"] = {
    kind: "entry",
    inputSeq: 12,
    expectedDecisionId: "decision-12",
  },
) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProcessingFeedbackPanel target={target} />)
  })
  return { container, root }
}

const setValue = async (element: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  expect(setter).toBeDefined()
  await act(async () => {
    setter!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("ProcessingFeedbackPanel", () => {
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
  })

  it("submits the snapshot decision anchor and does not claim to change rules", async () => {
    mocks.saveProcessingFeedback.mockResolvedValue({ feedback: { id: "feedback-1" } })
    ;({ container, root } = await renderPanel())
    const currentContainer = container!
    await act(async () => {
      ;(currentContainer.querySelector("button") as HTMLButtonElement).click()
    })
    const textareas = currentContainer.querySelectorAll("textarea")
    await setValue(textareas[0]!, "当前决定不应保留")
    const saveButton = Array.from(currentContainer.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("information.feedback.save"),
    ) as HTMLButtonElement
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })
    expect(mocks.saveProcessingFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "entry", inputSeq: 12, expectedDecisionId: "decision-12" },
        explanation: "当前决定不应保留",
      }),
      expect.any(AbortSignal),
    )
    expect(currentContainer.textContent).toContain("information.feedback.review_only")
    expect(currentContainer.textContent).toContain("information.feedback.saved")
  })

  it("keeps explanation and suggestion when a stale target is rejected", async () => {
    const { FeedbackRequestError } = await import("./processing-feedback-client")
    mocks.saveProcessingFeedback.mockRejectedValue(new FeedbackRequestError("conflict"))
    ;({ container, root } = await renderPanel())
    const currentContainer = container!
    await act(async () => {
      ;(currentContainer.querySelector("button") as HTMLButtonElement).click()
    })
    const textareas = currentContainer.querySelectorAll("textarea")
    await setValue(textareas[0]!, "保留这段说明")
    await setValue(textareas[1]!, "建议人工审阅规则")
    const saveButton = Array.from(currentContainer.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("information.feedback.save"),
    ) as HTMLButtonElement
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })
    expect(currentContainer.textContent).toContain("information.feedback.error.conflict")
    expect((textareas[0] as HTMLTextAreaElement).value).toBe("保留这段说明")
    expect((textareas[1] as HTMLTextAreaElement).value).toBe("建议人工审阅规则")
  })

  it("submits a Story feedback target with its displayed revision", async () => {
    mocks.saveProcessingFeedback.mockResolvedValue({ feedback: { id: "feedback-2" } })
    ;({ container, root } = await renderPanel({
      kind: "story",
      storyId: "11111111-1111-4111-8111-111111111111",
      storyRevision: 8,
    }))
    const currentContainer = container!
    await act(async () => {
      ;(currentContainer.querySelector("button") as HTMLButtonElement).click()
    })
    const saveButton = Array.from(currentContainer.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("information.feedback.save"),
    ) as HTMLButtonElement
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })
    expect(mocks.saveProcessingFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: "story",
          storyId: "11111111-1111-4111-8111-111111111111",
          storyRevision: 8,
        },
        referenceIds: [],
      }),
      expect.any(AbortSignal),
    )
  })
})
