import { GlobalFocusableContext } from "@follow/components/common/Focusable/context.js"
import { EnhanceSet } from "@follow/utils"
import { atom } from "jotai"
import type { ButtonHTMLAttributes, PropsWithChildren } from "react"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NativeStoryHeader } from "./NativeStoryHeader"

const mocks = vi.hoisted(() => ({
  reader: {
    mutationTarget: { kind: "story", storyId: "private-story" },
    selectedRead: false,
    selectedCollected: false,
    mutateItem: vi.fn(),
  },
}))
vi.mock("./native-reader-context", () => ({ useNativeReader: () => mocks.reader }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("~/components/ui/button/CommandActionButton", () => ({
  CommandActionButton: ({ onClick }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} />
  ),
}))
vi.mock("@follow/components/ui/button/index.js", () => ({
  ActionButton: ({
    tooltip,
    onClick,
    children,
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    tooltip?: string
  }) => (
    <button aria-label={tooltip} onClick={onClick}>
      {children}
    </button>
  ),
}))
vi.mock("~/modules/command/hooks/use-command-binding", () => ({
  useCommandShortcuts: () => ({}),
}))
vi.mock("~/modules/entry-content/components/entry-header/internal/context", () => ({
  EntryHeaderFrame: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
const focusScopes = atom(EnhanceSet.of<string>())
afterEach(async () => {
  await act(() => root.render(null))
  vi.clearAllMocks()
})

function HeaderRoute() {
  const location = useLocation()
  return location.search ? <NativeStoryHeader /> : <div data-closed />
}

// 使用真实焦点 atom；仅模拟业务数据，确保工具栏更新后路由过渡仍能提交。
describe("Story 工具栏焦点订阅", () => {
  it("读态更新不会创建订阅循环，关闭正文能提交新路由", async () => {
    const renderHeader = () => (
      <GlobalFocusableContext value={focusScopes}>
        <MemoryRouter initialEntries={["/events?story=private-story"]}>
          <Routes>
            <Route path="/events" element={<HeaderRoute />} />
          </Routes>
        </MemoryRouter>
      </GlobalFocusableContext>
    )
    await act(() => root.render(renderHeader()))
    expect(host.querySelector("nav")).not.toBeNull()
    mocks.reader.selectedRead = true
    await act(() => root.render(renderHeader()))
    await act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="processing.reader.close"]')?.click()
    })
    expect(host.querySelector("[data-closed]")).not.toBeNull()
    expect(host.querySelector("nav")).toBeNull()
  })
})
