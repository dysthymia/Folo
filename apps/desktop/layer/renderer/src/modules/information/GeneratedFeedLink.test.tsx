// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GeneratedFeedLink } from "./GeneratedFeedLink"

const mocks = vi.hoisted(() => ({
  owner: "owner",
  stats: vi.fn(),
  effective: vi.fn(),
  menu: vi.fn(),
  navigate: vi.fn(),
  path: "/events",
  search: "?story=story-1",
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: mocks.path, search: mocks.search, hash: "" }),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: mocks.owner }) }))
vi.mock("@follow/components/ui/typography/index.js", () => ({
  EllipsisHorizontalTextWithTooltip: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}))
vi.mock("~/modules/subscription-column/UnreadNumber", () => ({
  UnreadNumber: ({ unread }: { unread?: number }) => <span data-unread>{unread}</span>,
}))
vi.mock("~/modules/ai-chat/local-provider", () => ({
  isLocalFoloHost: () => true,
  getOneTimeToken: vi.fn(),
}))
vi.mock("~/modules/action/processing-client", () => ({
  createProcessingClient: () => ({ loadEffective: mocks.effective }),
}))
vi.mock("./generated-feed-client", () => ({ loadGeneratedFeedStats: mocks.stats }))
vi.mock("~/hooks/common/useContextMenu", () => ({ useContextMenu: (value: unknown) => value }))
vi.mock("~/atoms/context-menu", () => ({
  MenuItemSeparator: class {
    static default = {}
  },
  MenuItemText: class {
    constructor(value: object) {
      Object.assign(this, value)
    }
  },
  useShowContextMenu: () => mocks.menu,
}))
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const rules = [
  { id: "aggregate-1", name: "综述一", enabled: true, actions: [{ type: "ai_aggregate" }] },
  { id: "aggregate-2", name: "综述二", enabled: true, actions: [{ type: "ai_aggregate" }] },
  { id: "transform", name: "单篇", enabled: true, actions: [{ type: "ai_transform" }] },
]
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  mocks.owner = "owner"
  mocks.path = "/events"
  mocks.stats.mockResolvedValue({ feedId: "generated:events", total: 4, unread: 3, collected: 1 })
  mocks.effective.mockResolvedValue({ config: { rules }, sources: [{ category: "X" }] })
  mocks.menu.mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const render = () => act(async () => root.render(<GeneratedFeedLink />))
const openMenu = async () => {
  await act(async () =>
    container
      .querySelector('[data-source-origin="generated"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  )
  return mocks.menu.mock.calls.at(-1)![0] as {
    label: string
    click?: () => void
    submenu?: { label: string; click: () => void }[]
  }[]
}
describe("原生私人生成来源行", () => {
  it("展示真实未读和选中态，读态事件只刷新统计且没有官方feed身份", async () => {
    await render()
    expect(container.querySelector('[aria-current="page"]')).toBeTruthy()
    expect(container.querySelector("[data-unread]")?.textContent).toBe("3")
    expect(container.querySelector("[data-feed-id]")).toBeNull()
    expect(container.textContent).toContain("processing.generated.private")
    mocks.stats.mockResolvedValue({ feedId: "generated:events", total: 4, unread: 2, collected: 1 })
    await act(async () => window.dispatchEvent(new Event("processing-story-state-changed")))
    expect(container.querySelector("[data-unread]")?.textContent).toBe("2")
    expect(mocks.effective).toHaveBeenCalledTimes(1)
  })
  it("右键提供多条有效综述规则选择，返回原阅读路径且不伪造原文条件", async () => {
    await render()
    const menu = await openMenu()
    const ruleMenu = menu.find((item) => item.label === "processing.generated.rules")!
    expect(ruleMenu.submenu?.map((item) => item.label)).toEqual(["综述一", "综述二"])
    await act(async () => ruleMenu.submenu![1]!.click())
    const url = new URL(mocks.navigate.mock.calls.at(-1)![0], "https://local.folo.is")
    expect(url.searchParams.get("ruleId")).toBe("aggregate-2")
    expect(url.searchParams.get("returnTo")).toBe("/events?story=story-1")
    expect(url.searchParams.has("sourceId")).toBe(false)
  })
  it("分组隐藏只改变本地偏好，隐藏后有显示入口且账号隔离", async () => {
    await render()
    let menu = await openMenu()
    await act(async () =>
      menu
        .find((item) => item.label === "processing.generated.group")!
        .submenu!.find((item) => item.label === "X")!
        .click(),
    )
    expect(container.querySelector('[data-generated-source-group="X"]')).toBeTruthy()
    menu = await openMenu()
    await act(async () => menu.find((item) => item.label === "processing.generated.hide")!.click!())
    expect(container.querySelector('[data-source-origin="generated"]')).toBeNull()
    expect(container.textContent).toContain("processing.generated.show")
    mocks.owner = "other-owner"
    await render()
    expect(container.querySelector('[data-source-origin="generated"]')).toBeTruthy()
    expect(container.querySelector('[data-generated-source-group="X"]')).toBeNull()
  })
  it("统计不可用不把未知计数显示成零", async () => {
    mocks.stats.mockRejectedValue(new Error("offline"))
    await render()
    expect(container.querySelector('[title="processing.generated.stats_error"]')).toBeTruthy()
    expect(container.querySelector("[data-unread]")).toBeNull()
  })
})
