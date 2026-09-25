import appZhCN from "@locales/app/zh-CN.json"
import i18next from "i18next"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { I18nextProvider, initReactI18next } from "react-i18next"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { isLocalFoloHost } from "../ai-chat/local-provider"
import { FeedSubscriptionTags } from "./feed-subscription-tags"

// 组件的 client 在模块作用域构造，所以 mock 必须覆盖 `createProcessingClient` 本身。
const processingClientMock = vi.hoisted(() => ({
  load: vi.fn(),
  bindTags: vi.fn(),
}))

vi.mock("../ai-chat/local-provider", () => ({
  getOneTimeToken: vi.fn(async () => "one-time-token"),
  isLocalFoloHost: vi.fn(() => true),
}))

vi.mock("./processing-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./processing-client")>()
  return {
    ...actual,
    createProcessingClient: () => processingClientMock,
  }
})

// 语言包源文件是扁平点号键，i18next 按 `keySeparator: "."` 查嵌套；按构建期的同一变换还原，
// 免得测试资源形状与线上不一致而给出假绿。
const nest = (flat: Record<string, string>) => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".")
    let cursor = out
    for (const part of parts.slice(0, -1)) {
      if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {}
      cursor = cursor[part] as Record<string, unknown>
    }
    cursor[parts.at(-1)!] = value
  }
  return out
}

const createI18n = async () => {
  const instance = i18next.createInstance()
  await instance.use(initReactI18next).init({
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    ns: ["app"],
    defaultNS: "app",
    resources: { "zh-CN": { app: nest(appZhCN as Record<string, string>) } },
  })
  return instance
}

const FLAT = appZhCN as Record<string, string>
const TAGS_TITLE = FLAT["processing.tags"]!
const TAGS_HINT = FLAT["processing.tags_form_hint"]!
const TAGS_EMPTY = FLAT["processing.tags_form_empty"]!
const ERROR_AUTHORIZATION = FLAT["processing.error.authorization"]!
const ERROR_CONFLICT = FLAT["processing.error.conflict"]!

const TAG_A = "11111111-1111-4111-8111-111111111111"
const TAG_B = "22222222-2222-4222-8222-222222222222"
const ISO = "2026-09-25T00:00:00.000Z"

const snapshot = (tagIds: string[], revision = 7) => ({
  subscriptionTags: {
    formatVersion: 1 as const,
    revision,
    tags: [
      { id: TAG_A, name: "金融", createdAt: ISO, updatedAt: ISO },
      { id: TAG_B, name: "AI", createdAt: ISO, updatedAt: ISO },
    ],
  },
  sourceTags: [{ sourceKey: "feed/abc", tagIds }],
})

describe("编辑订阅弹窗里的私人订阅标签", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null
  let i18n: Awaited<ReturnType<typeof createI18n>> | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(async () => {
    processingClientMock.load.mockReset()
    processingClientMock.bindTags.mockReset()
    vi.mocked(isLocalFoloHost).mockReturnValue(true)
    i18n = await createI18n()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    root = null
    container = null
    i18n = null
  })

  const mount = async () => {
    await act(async () => {
      root!.render(
        <I18nextProvider i18n={i18n!}>
          <FeedSubscriptionTags feedId="abc" />
        </I18nextProvider>,
      )
    })
  }

  const checkboxes = () => [
    ...container!.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
  ]

  const clickTag = async (index: number) => {
    await act(async () => {
      checkboxes()[index]!.click()
      await Promise.resolve()
    })
  }

  it("官方站（非 local.folo.is）不渲染标签区块，也不去碰信息服务", async () => {
    vi.mocked(isLocalFoloHost).mockReturnValue(false)
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)

    await mount()

    expect(container!.querySelector('[data-testid="feed-form-processing-tags"]')).toBeNull()
    expect(processingClientMock.load).not.toHaveBeenCalled()
  })

  it("渲染标签清单、按服务端快照回显勾选，且不露出 raw key", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([TAG_B]) as never)

    await mount()

    const text = container!.textContent ?? ""
    expect(text).toContain(TAGS_TITLE)
    expect(text).toContain(TAGS_HINT)
    expect(text).toContain("金融")
    expect(text).toContain("AI")
    expect(text).not.toContain("processing.tags")

    const [first, second] = checkboxes()
    expect(first!.checked).toBe(false)
    expect(second!.checked).toBe(true)
  })

  it("勾选未绑定的标签写 add，带上服务端 revision 与中止信号，并以重读的快照为准", async () => {
    // 第一次读「没绑」，写入成功后再读「已绑」——模拟服务端真正落库。
    processingClientMock.load
      .mockResolvedValueOnce(snapshot([]) as never)
      .mockResolvedValue(snapshot([TAG_A]) as never)
    processingClientMock.bindTags.mockResolvedValue({ revision: 8, changedBindings: 1 } as never)

    await mount()
    expect(checkboxes()[0]!.checked).toBe(false)

    await clickTag(0)

    expect(processingClientMock.bindTags).toHaveBeenCalledTimes(1)
    expect(processingClientMock.bindTags.mock.calls[0]!.slice(0, 4)).toEqual([
      ["feed/abc"],
      [TAG_A],
      "add",
      7,
    ])
    expect(processingClientMock.bindTags.mock.calls[0]![4]).toBeInstanceOf(AbortSignal)
    // 写入后重新读服务端快照，前端不自己维护第二份真相。
    expect(processingClientMock.load).toHaveBeenCalledTimes(2)
    expect(checkboxes()[0]!.checked).toBe(true)
  })

  it("取消勾选已绑定的标签写 remove", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([TAG_A]) as never)
    processingClientMock.bindTags.mockResolvedValue({ revision: 9, changedBindings: 1 } as never)

    await mount()
    expect(checkboxes()[0]!.checked).toBe(true)

    await clickTag(0)

    expect(processingClientMock.bindTags).toHaveBeenCalledTimes(1)
    expect(processingClientMock.bindTags.mock.calls[0]!.slice(0, 4)).toEqual([
      ["feed/abc"],
      [TAG_A],
      "remove",
      7,
    ])
  })

  it("一个标签都没有时给出去哪创建的提示，而不是空区块", async () => {
    processingClientMock.load.mockResolvedValue({
      subscriptionTags: { formatVersion: 1, revision: 0, tags: [] },
      sourceTags: [],
    } as never)

    await mount()

    const text = container!.textContent ?? ""
    expect(text).toContain(TAGS_EMPTY)
    expect(text).not.toContain("processing.tags_form_empty")
    expect(checkboxes()).toHaveLength(0)
  })

  it("读取失败露出可读错误而不是空白", async () => {
    const { ProcessingRequestError } = await import("./processing-client")
    processingClientMock.load.mockRejectedValue(new ProcessingRequestError("authorization"))

    await mount()

    expect(container!.textContent ?? "").toContain(ERROR_AUTHORIZATION)
  })

  it("写入失败回滚本地勾选并提示冲突", async () => {
    const { ProcessingRequestError } = await import("./processing-client")
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)
    processingClientMock.bindTags.mockRejectedValue(new ProcessingRequestError("conflict"))

    await mount()
    expect(checkboxes()[0]!.checked).toBe(false)

    await clickTag(0)

    expect(checkboxes()[0]!.checked).toBe(false)
    expect(container!.textContent ?? "").toContain(ERROR_CONFLICT)
  })
})
