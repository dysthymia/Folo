import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { XSearchPanel } from "./XSearchPanel"

const mocks = vi.hoisted(() => ({
  createXQuery: vi.fn(),
  deleteXQuery: vi.fn(),
  loadX: vi.fn(),
  saveXSettings: vi.fn(),
  syncX: vi.fn(),
  updateXQuery: vi.fn(),
}))

vi.mock("./x-search-client", () => ({
  ...mocks,
  XRequestError: class XRequestError extends Error {
    constructor(readonly kind: "authorization" | "request") {
      super(kind)
    }
  },
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}))

const id = "11111111-1111-4111-8111-111111111111"
const now = "2026-09-12T00:00:00.000Z"
const settings = {
  enabled: true,
  configured: true,
  access: "recent_search" as const,
  billingNotice: "Billed by X usage",
}
const savedQuery = {
  id,
  sourceKey: `x/search/${id}`,
  query: "from:follow_app",
  title: "Folo posts",
  view: 3,
  category: "Product",
  enabled: true,
  createdAt: now,
  updatedAt: now,
  state: {
    queryId: id,
    nextToken: null,
    scanSinceId: null,
    candidateHighWaterId: null,
    highWaterId: null,
    pending: false,
    status: "idle" as const,
    failure: null,
    retryAt: null,
    updatedAt: now,
  },
}

const emptyData = { queries: [], sources: [] }

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const renderPanel = async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<XSearchPanel />)
    await flush()
  })
  return { container, root }
}

const setValue = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
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
    await flush()
  })
}

const button = (container: HTMLElement, text: string) => {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  )
  expect(match).toBeDefined()
  return match as HTMLButtonElement
}

describe("XSearchPanel", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    mocks.loadX.mockResolvedValue([settings, emptyData])
    mocks.createXQuery.mockResolvedValue(savedQuery)
    mocks.updateXQuery.mockResolvedValue(savedQuery)
    mocks.deleteXQuery.mockResolvedValue({ deleted: true })
    mocks.saveXSettings.mockResolvedValue(settings)
    mocks.syncX.mockResolvedValue({ results: [] })
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    document.body.innerHTML = ""
    root = null
    container = null
    vi.clearAllMocks()
  })

  it("未配置时不触发同步并明确禁用原因", async () => {
    mocks.loadX.mockResolvedValue([{ ...settings, enabled: false, configured: false }, emptyData])
    ;({ container, root } = await renderPanel())

    const sync = button(container, "information.x.sync")
    expect(sync.disabled).toBe(true)
    expect(container.textContent).toContain("information.x.sync_disabled.disabled")
    await click(sync)
    expect(mocks.syncX).not.toHaveBeenCalled()
  })

  it("创建、编辑和删除保存查询时发送精确字段", async () => {
    mocks.loadX.mockResolvedValue([settings, { queries: [savedQuery], sources: [] }])
    ;({ container, root } = await renderPanel())

    await setValue(container.querySelector('[name="x-query"]') as HTMLInputElement, "  AI  ")
    await setValue(
      container.querySelector('[name="x-query-title"]') as HTMLInputElement,
      "  AI news  ",
    )
    await setValue(container.querySelector('[name="x-query-view"]') as HTMLInputElement, "4")
    await setValue(
      container.querySelector('[name="x-query-category"]') as HTMLInputElement,
      "  Tech  ",
    )
    await click(button(container, "information.x.query.create"))
    expect(mocks.createXQuery).toHaveBeenCalledWith(
      { query: "AI", title: "AI news", view: 4, category: "Tech", enabled: true },
      expect.any(AbortSignal),
    )

    await click(button(container, "information.x.query.edit"))
    await setValue(
      container.querySelector('[name="x-query-title"]') as HTMLInputElement,
      "Edited title",
    )
    await click(button(container, "information.x.query.update"))
    expect(mocks.updateXQuery).toHaveBeenCalledWith(
      id,
      {
        query: savedQuery.query,
        title: "Edited title",
        view: savedQuery.view,
        category: savedQuery.category,
        enabled: true,
      },
      expect.any(AbortSignal),
    )

    await click(button(container, "information.x.query.delete"))
    expect(mocks.deleteXQuery).toHaveBeenCalledWith(id, expect.any(AbortSignal))
  })

  it("分页中状态不会显示成已完成", async () => {
    mocks.loadX.mockResolvedValue([
      settings,
      {
        queries: [
          {
            ...savedQuery,
            state: { ...savedQuery.state, pending: true, status: "pending", nextToken: "next" },
          },
        ],
        sources: [],
      },
    ])
    ;({ container, root } = await renderPanel())

    expect(container.textContent).toContain("information.x.status.pending")
    expect(container.textContent).toContain("information.x.pagination_pending")
    expect(container.textContent).not.toContain("information.x.status.complete")
  })

  it("失败与限流重试时间保持可见", async () => {
    mocks.loadX.mockResolvedValue([
      settings,
      {
        queries: [
          {
            ...savedQuery,
            state: {
              ...savedQuery.state,
              pending: true,
              status: "rate_limited",
              failure: "rate_limited",
              retryAt: "2026-09-12T01:00:00.000Z",
            },
          },
        ],
        sources: [],
      },
    ])
    ;({ container, root } = await renderPanel())

    expect(container.textContent).toContain("information.x.status.rate_limited")
    expect(container.textContent).toContain("information.x.failure")
    expect(container.textContent).toContain("information.x.retry_at")
  })

  it("Bearer 输入不回显，并在保存完成后清空", async () => {
    ;({ container, root } = await renderPanel())
    const token = container.querySelector('[name="x-bearer-token"]') as HTMLInputElement
    expect(token.type).toBe("password")
    expect(token.value).toBe("")
    await setValue(token, "secret-token")
    await click(button(container, "information.x.save"))

    expect(mocks.saveXSettings).toHaveBeenCalledWith(
      { enabled: true, access: "recent_search", bearerToken: "secret-token" },
      expect.any(AbortSignal),
    )
    expect(token.value).toBe("")
    expect(container.textContent).not.toContain("secret-token")
  })
})
