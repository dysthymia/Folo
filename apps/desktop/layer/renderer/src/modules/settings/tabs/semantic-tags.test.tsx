// @vitest-environment jsdom
import { semanticTagDefinitions } from "@follow/information-core"
import settingsEn from "@locales/settings/en.json"
import settingsJa from "@locales/settings/ja.json"
import settingsZh from "@locales/settings/zh-CN.json"
import i18next from "i18next"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { loadSemanticTagCatalog } from "~/modules/information/processing-semantic-client"

import { SemanticTagCatalog } from "./semantic-tags"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      [key, ...Object.values(values ?? {})].join(" "),
  }),
}))
vi.mock("~/modules/information/processing-semantic-client", () => ({
  loadSemanticTagCatalog: vi.fn(),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: "owner" }) }))
vi.mock("~/modules/ai-chat/local-provider", () => ({ isLocalFoloHost: () => true }))

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren()
  vi.resetAllMocks()
})
const show = async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<SemanticTagCatalog />))
  return container
}

describe("标签定义设置", () => {
  it("展示服务端当前定义、版本、正反例和上级标签，按类别筛选无需再请求", async () => {
    vi.mocked(loadSemanticTagCatalog).mockResolvedValue({
      definitions: [...semanticTagDefinitions],
    })
    const container = await show()
    expect(container.querySelectorAll("article")).toHaveLength(22)
    const product = Array.from(container.querySelectorAll("article")).find((article) =>
      article.textContent?.includes("semantic.tag.topic:product"),
    )!
    expect(product.textContent).toContain("tags.version 2")
    expect(product.textContent).toContain(
      semanticTagDefinitions.find((tag) => tag.id === "topic:product")!.description,
    )
    expect(product.textContent).toContain("某机构设立子公司")
    expect(container.textContent).toContain("tags.parent：semantic.tag.topic:blockchain")
    const select = container.querySelector("select")!
    await act(async () => {
      select.value = "event"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(container.querySelectorAll("article")).toHaveLength(7)
    expect(container.textContent).not.toContain("semantic.tag.topic:product")
    expect(loadSemanticTagCatalog).toHaveBeenCalledTimes(1)
  })

  it("搜索别名和判断边界，未匹配显示空状态", async () => {
    vi.mocked(loadSemanticTagCatalog).mockResolvedValue({
      definitions: [...semanticTagDefinitions],
    })
    const container = await show()
    const input = container.querySelector("input")!
    // 使用原生 setter 触发 React 输入，验证实际搜索状态而非复制筛选实现。
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    await act(async () => {
      setValue.call(input, "  ＤｅＦｉ  ")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(container.textContent).toContain("semantic.tag.topic:defi")
    expect(container.querySelectorAll("article")).toHaveLength(2)
    await act(async () => {
      setValue.call(input, "没有这个标签")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(container.querySelectorAll("article")).toHaveLength(0)
    expect(container.textContent).toContain("tags.empty")
    expect(loadSemanticTagCatalog).toHaveBeenCalledTimes(1)
  })

  it("本地读取失败显示重试，卸载时取消请求", async () => {
    vi.mocked(loadSemanticTagCatalog)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ definitions: [...semanticTagDefinitions] })
    const container = await show()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("tags.load_failed")
    await act(async () => container.querySelector("button")!.click())
    expect(container.querySelectorAll("article")).toHaveLength(22)
    const signal = vi.mocked(loadSemanticTagCatalog).mock.calls[1]![0]
    await act(async () => roots.pop()!.unmount())
    expect(signal.aborted).toBe(true)
  })
})

// 构建产物把点号键转换为嵌套对象，使用真实语言包验证叶子键不会被子键覆盖。
it.each([settingsZh, settingsEn, settingsJa])(
  "标签设置语言包可按线上形状正确读取",
  async (flat) => {
    const resources: Record<string, unknown> = {}
    const entries = Object.entries(flat).filter(
      ([key]) => key.startsWith("tags.") || key === "titles.tags",
    )
    for (const [key, value] of entries) {
      const parts = key.split(".")
      let cursor = resources
      for (const part of parts.slice(0, -1)) {
        if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {}
        cursor = cursor[part] as Record<string, unknown>
      }
      cursor[parts.at(-1)!] = value
    }
    const instance = i18next.createInstance()
    await instance.init({
      lng: "test",
      resources: { test: { settings: resources } },
      defaultNS: "settings",
    })
    for (const [key, value] of entries) {
      expect(
        instance.t(key as keyof typeof settingsEn, {
          ns: "settings",
          visible: 22,
          total: 22,
          version: 2,
        }),
      ).toBe(
        value.replace("{{visible}}", "22").replace("{{total}}", "22").replace("{{version}}", "2"),
      )
    }
  },
)
