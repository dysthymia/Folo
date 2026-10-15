import * as React from "react"
import { act, useEffect } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ReaderContentPanel } from "./ReaderContentPanel"

const mocks = vi.hoisted(() => ({
  enabled: true,
  ownerId: "owner",
  started: vi.fn(),
  stopped: vi.fn(),
}))
vi.mock("~/modules/action/use-automation-debug", () => ({
  useAutomationDebugEnabled: () => mocks.enabled,
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.ownerId }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("~/providers/automation-debug-panel", () => ({
  AutomationDebugPanel: ({ ownerId }: { ownerId?: string }) => {
    useEffect(() => {
      mocks.started(ownerId)
      return () => mocks.stopped(ownerId)
    }, [ownerId])
    return <section data-debug-owner={ownerId}>调试内容</section>
  },
}))

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  mocks.enabled = true
  mocks.ownerId = "owner"
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const render = (enabled = true) =>
  act(async () =>
    root.render(
      <ReaderContentPanel enabled={enabled}>
        <div data-article-scroll>
          <input defaultValue="文章备注" />
        </div>
      </ReaderContentPanel>,
    ),
  )
const selectTab = (value: string) =>
  act(async () => {
    host
      .querySelector<HTMLButtonElement>(`[role="tab"][data-state][id$="trigger-${value}"]`)!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  })

// 使用真实 Tabs 和 Activity 验证正文保留及隐藏页清理，避免只验证标签文案。
describe("正文与调试标签页", () => {
  it("默认显示文章，调试与文章互斥；切回后保留正文 DOM、滚动和输入状态", async () => {
    await render()
    const article = host.querySelector<HTMLDivElement>("[data-article-scroll]")!
    const input = article.querySelector("input")!
    article.scrollTop = 240
    input.value = "保留的文章备注"
    expect(mocks.started).not.toHaveBeenCalled()
    await selectTab("debug")
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "automation.debug.debug_tab",
    )
    expect(article.closest<HTMLElement>('[role="tabpanel"]')!.style.display).toBe("none")
    expect(mocks.started).toHaveBeenCalledWith("owner")
    await selectTab("article")
    expect(mocks.stopped).toHaveBeenCalledWith("owner")
    expect(host.querySelector("[data-article-scroll]")).toBe(article)
    expect(article.scrollTop).toBe(240)
    expect(input.value).toBe("保留的文章备注")
    expect(article.closest<HTMLElement>('[role="tabpanel"]')!.style.display).not.toBe("none")
  })

  it("关闭调试或显示固定 AI 面板时不插入正文标签", async () => {
    mocks.enabled = false
    await render()
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    mocks.enabled = true
    await render(false)
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(mocks.started).not.toHaveBeenCalled()
  })

  it("账号切换后回到文章并移除上一账号的调试内容", async () => {
    await render()
    await selectTab("debug")
    mocks.ownerId = "another-owner"
    await render()
    expect(host.querySelector('[data-debug-owner="owner"]')).toBeNull()
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "automation.debug.article_tab",
    )
    expect(mocks.started).not.toHaveBeenCalledWith("another-owner")
  })
})
