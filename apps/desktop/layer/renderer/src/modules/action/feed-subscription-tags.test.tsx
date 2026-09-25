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
  createTag: vi.fn(),
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
const TAGS_PLACEHOLDER = FLAT["processing.tags_form_placeholder"]!
const ERROR_AUTHORIZATION = FLAT["processing.error.authorization"]!
const ERROR_CONFLICT = FLAT["processing.error.conflict"]!
const ERROR_REQUEST = FLAT["processing.error.request"]!

const TAG_A = "11111111-1111-4111-8111-111111111111"
const TAG_B = "22222222-2222-4222-8222-222222222222"
const TAG_NEW = "33333333-3333-4333-8333-333333333333"
const ISO = "2026-09-25T00:00:00.000Z"

const makeTag = (id: string, name: string) => ({ id, name, createdAt: ISO, updatedAt: ISO })

const snapshot = (
  tagIds: string[],
  tags = [makeTag(TAG_A, "金融"), makeTag(TAG_B, "AI")],
  revision = 7,
) => ({
  subscriptionTags: { formatVersion: 1 as const, revision, tags },
  sourceTags: [{ sourceKey: "feed/abc", tagIds }],
})

/** React 受控 input：先走原生 setter 再派发 input，否则 onChange 收不到新值。 */
const typeInto = (element: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

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
    processingClientMock.createTag.mockReset()
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

  const one = <T extends Element>(testid: string) =>
    container!.querySelector<T>(`[data-testid="${testid}"]`)
  const all = <T extends Element>(testid: string) => [
    ...container!.querySelectorAll<T>(`[data-testid="${testid}"]`),
  ]

  const input = () => one<HTMLInputElement>("feed-form-processing-tags-input")!
  const chips = () => all<HTMLElement>("feed-form-processing-tag-chip")
  const options = () => all<HTMLButtonElement>("feed-form-processing-tags-option")
  const createOption = () => one<HTMLButtonElement>("feed-form-processing-tags-create")

  const focusInput = async () => {
    await act(async () => {
      input().focus()
      input().dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    })
  }

  const click = async (element: Element) => {
    await act(async () => {
      ;(element as HTMLElement).click()
      // createTag → bindTags → read 是一条 promise 链，一轮微任务不够走完。
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
  }

  it("官方站（非 local.folo.is）不渲染标签控件，也不去碰信息服务", async () => {
    vi.mocked(isLocalFoloHost).mockReturnValue(false)
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)

    await mount()

    expect(one("feed-form-processing-tags")).toBeNull()
    expect(processingClientMock.load).not.toHaveBeenCalled()
  })

  it("已绑定的标签渲染成 chip，标题/提示/占位都解析成译文", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([TAG_B]) as never)

    await mount()

    expect(chips()).toHaveLength(1)
    expect(chips()[0]!.textContent).toContain("AI")
    // 有 chip 时不再显示占位文案（腾出空间给 chip），空态才显示
    expect(input().getAttribute("placeholder")).toBe("")

    const text = container!.textContent ?? ""
    expect(text).toContain(TAGS_TITLE)
    expect(text).toContain(TAGS_HINT)
    expect(text).not.toContain("processing.tags_form")
  })

  it("没有绑定任何标签时输入框显示「选择或创建标签」占位", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)

    await mount()

    expect(chips()).toHaveLength(0)
    expect(input().getAttribute("placeholder")).toBe(TAGS_PLACEHOLDER)
  })

  it("展开下拉后可看到全部标签，点未选中项写 add", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([TAG_B]) as never)
    processingClientMock.bindTags.mockResolvedValue({ revision: 8, changedBindings: 1 } as never)

    await mount()
    await focusInput()

    // 下拉列全部标签（已选的那条带勾），而不是只列未选的
    expect(options()).toHaveLength(2)
    expect(options().map((el) => el.dataset.checked)).toEqual(["false", "true"])

    await click(options()[0]!)

    expect(processingClientMock.bindTags).toHaveBeenCalledTimes(1)
    expect(processingClientMock.bindTags.mock.calls[0]!.slice(0, 4)).toEqual([
      ["feed/abc"],
      [TAG_A],
      "add",
      7,
    ])
    expect(processingClientMock.bindTags.mock.calls[0]![4]).toBeInstanceOf(AbortSignal)
  })

  it("点已选中项写 remove，chip 上的 × 也能解绑", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([TAG_A]) as never)
    processingClientMock.bindTags.mockResolvedValue({ revision: 9, changedBindings: 1 } as never)

    await mount()
    await focusInput()
    await click(options()[0]!)

    expect(processingClientMock.bindTags.mock.calls[0]!.slice(0, 4)).toEqual([
      ["feed/abc"],
      [TAG_A],
      "remove",
      7,
    ])

    // chip 上的关闭按钮是另一条路径，同样要能解绑
    await click(chips()[0]!.querySelector("button")!)

    expect(processingClientMock.bindTags).toHaveBeenCalledTimes(2)
    expect(processingClientMock.bindTags.mock.calls[1]!.slice(0, 4)).toEqual([
      ["feed/abc"],
      [TAG_A],
      "remove",
      7,
    ])
  })

  it("输入新名称时出现「创建」项：先 createTag，再用返回的新 revision 绑定", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)
    // createTag 返回的是**标签快照**（tagSnapshotSchema），不是 editor 结构。
    processingClientMock.createTag.mockResolvedValue({
      formatVersion: 1,
      revision: 8,
      tags: [makeTag(TAG_A, "金融"), makeTag(TAG_B, "AI"), makeTag(TAG_NEW, "新标签")],
    } as never)
    processingClientMock.bindTags.mockResolvedValue({ revision: 9, changedBindings: 1 } as never)

    await mount()
    await focusInput()

    expect(createOption()).toBeNull()
    await act(async () => typeInto(input(), "新标签"))

    const createButton = createOption()!
    expect(createButton.textContent).toContain("新标签")
    // 名称匹配不到既有标签，所以两条既有标签都不在下拉里
    expect(options()).toHaveLength(0)

    await click(createButton)

    expect(processingClientMock.createTag).toHaveBeenCalledTimes(1)
    expect(processingClientMock.createTag.mock.calls[0]!.slice(0, 2)).toEqual(["新标签", 7])
    expect(processingClientMock.bindTags).toHaveBeenCalledTimes(1)
    // 用的是 createTag 返回的 revision=8，不是旧值 7
    expect(processingClientMock.bindTags.mock.calls[0]!.slice(0, 4)).toEqual([
      ["feed/abc"],
      [TAG_NEW],
      "add",
      8,
    ])
  })

  it("createTag 一返回就先画出 chip，不等绑定与重读快照", async () => {
    let release: (() => void) | undefined
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)
    processingClientMock.createTag.mockResolvedValue({
      formatVersion: 1,
      revision: 8,
      tags: [makeTag(TAG_NEW, "新标签")],
    } as never)
    // 绑定挂在半路：此刻界面该已经有 chip，而不是对着禁用的输入框等下去。
    processingClientMock.bindTags.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ revision: 9, changedBindings: 1 } as never)
        }) as never,
    )

    await mount()
    await focusInput()
    await act(async () => typeInto(input(), "新标签"))
    await click(createOption()!)

    expect(processingClientMock.bindTags).toHaveBeenCalledTimes(1)
    expect(chips()).toHaveLength(1)
    expect(chips()[0]!.textContent).toContain("新标签")

    await act(async () => {
      release?.()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
  })

  it("创建接口自己失败时不留乐观 chip", async () => {
    const { ProcessingRequestError } = await import("./processing-client")
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)
    processingClientMock.createTag.mockRejectedValue(new ProcessingRequestError("conflict"))

    await mount()
    await focusInput()
    await act(async () => typeInto(input(), "新标签"))
    await click(createOption()!)

    expect(processingClientMock.bindTags).not.toHaveBeenCalled()
    expect(chips()).toHaveLength(0)
    expect(container!.textContent ?? "").toContain(ERROR_CONFLICT)
  })

  it("创建与绑定都成功、只是随后重读快照失败时，不回滚刚建好的 chip", async () => {
    const { ProcessingRequestError } = await import("./processing-client")
    // 第一次读取是挂载时那次；写入成功后的重读才失败。
    processingClientMock.load.mockResolvedValueOnce(snapshot([]) as never)
    processingClientMock.load.mockRejectedValueOnce(new ProcessingRequestError("request"))
    processingClientMock.createTag.mockResolvedValue({
      formatVersion: 1,
      revision: 8,
      tags: [makeTag(TAG_NEW, "新标签")],
    } as never)
    processingClientMock.bindTags.mockResolvedValue({ revision: 9, changedBindings: 1 } as never)

    await mount()
    await focusInput()
    await act(async () => typeInto(input(), "新标签"))
    await click(createOption()!)

    // 写入已经落库，回滚会把用户刚建好的标签藏起来，所以保留 chip 并提示重试。
    expect(chips()).toHaveLength(1)
    expect(chips()[0]!.textContent).toContain("新标签")
    expect(container!.textContent ?? "").toContain(ERROR_REQUEST)
  })

  it("名称与已有标签同名时不给「创建」项，只过滤既有标签", async () => {
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)

    await mount()
    await focusInput()
    await act(async () => typeInto(input(), "金融"))

    expect(createOption()).toBeNull()
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain("金融")
  })

  it("读取失败露出可读错误而不是空白", async () => {
    const { ProcessingRequestError } = await import("./processing-client")
    processingClientMock.load.mockRejectedValue(new ProcessingRequestError("authorization"))

    await mount()

    expect(container!.textContent ?? "").toContain(ERROR_AUTHORIZATION)
  })

  it("写入失败回滚 chip 并提示冲突", async () => {
    const { ProcessingRequestError } = await import("./processing-client")
    processingClientMock.load.mockResolvedValue(snapshot([]) as never)
    processingClientMock.bindTags.mockRejectedValue(new ProcessingRequestError("conflict"))

    await mount()
    await focusInput()
    expect(chips()).toHaveLength(0)

    await click(options()[0]!)

    expect(chips()).toHaveLength(0)
    expect(container!.textContent ?? "").toContain(ERROR_CONFLICT)
  })
})
