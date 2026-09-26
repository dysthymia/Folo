import settingsZhCN from "@locales/settings/zh-CN.json"
import i18next from "i18next"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { I18nextProvider, initReactI18next } from "react-i18next"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ProcessingTagManager } from "./feeds-processing-tags"

// 组件的 client 在模块作用域构造，所以 mock 必须覆盖 `createProcessingClient` 本身。
const processingClientMock = vi.hoisted(() => ({
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}))

const askMock = vi.hoisted(() => vi.fn())

vi.mock("~/modules/ai-chat/local-provider", () => ({
  getOneTimeToken: vi.fn(async () => "one-time-token"),
}))

vi.mock("~/modules/action/processing-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/action/processing-client")>()
  return {
    ...actual,
    createProcessingClient: () => processingClientMock,
  }
})

vi.mock("~/components/ui/modal/stacked/hooks", () => ({
  useDialog: () => ({ ask: askMock }),
}))

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
    ns: ["settings"],
    defaultNS: "settings",
    resources: { "zh-CN": { settings: nest(settingsZhCN as Record<string, string>) } },
  })
  return instance
}

const FLAT = settingsZhCN as Record<string, string>
const CREATE = FLAT["feeds.processing_tags.create"]!
const RENAME = FLAT["feeds.processing_tags.rename"]!
const DELETE = FLAT["feeds.processing_tags.delete"]!
const EMPTY = FLAT["feeds.processing_tags.empty"]!
const WRITE_FAILED = FLAT["feeds.processing_tags.write_failed"]!

const TAG_A = "11111111-1111-4111-8111-111111111111"
const TAG_B = "22222222-2222-4222-8222-222222222222"
const ISO = "2026-09-26T00:00:00.000Z"

const makeTag = (id: string, name: string) => ({ id, name, createdAt: ISO, updatedAt: ISO })

const data = (tags = [makeTag(TAG_A, "金融"), makeTag(TAG_B, "AI")], revision = 7) => ({
  subscriptionTags: { formatVersion: 1 as const, revision, tags },
})

/** React 受控 input：先走原生 setter 再派发 input，否则 onChange 收不到新值。 */
const typeInto = (element: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("订阅源设置页的标签管理", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null
  let i18n: Awaited<ReturnType<typeof createI18n>> | null = null
  // 显式给出签名：裸 `vi.fn()` 推断成 `Mock<Procedure | Constructable>`，与组件的
  // `(signal: AbortSignal) => Promise<void>` 不兼容。
  let reload: ReturnType<typeof vi.fn<(signal: AbortSignal) => Promise<void>>>

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(async () => {
    processingClientMock.createTag.mockReset()
    processingClientMock.renameTag.mockReset()
    processingClientMock.deleteTag.mockReset()
    askMock.mockReset()
    reload = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => {})
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

  const mount = async (value: ReturnType<typeof data> | null) => {
    await act(async () => {
      root!.render(
        <I18nextProvider i18n={i18n!}>
          <ProcessingTagManager data={value} reload={reload} />
        </I18nextProvider>,
      )
    })
  }

  const one = <T extends Element>(testid: string) =>
    container!.querySelector<T>(`[data-testid="${testid}"]`)

  const click = async (element: Element | null) => {
    expect(element).not.toBeNull()
    await act(async () => {
      ;(element as HTMLElement).click()
      // 写入 → 重读是一条 promise 链，一轮微任务不够走完。
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
  }

  const type = async (element: HTMLInputElement, value: string) => {
    await act(async () => typeInto(element, value))
  }

  it("读不到标签快照时整块不渲染", async () => {
    await mount(null)

    expect(one("feeds-tag-manager")).toBeNull()
  })

  it("列出全部标签，并提示标签总数", async () => {
    await mount(data())

    expect(one(`feeds-tag-row-${TAG_A}`)).not.toBeNull()
    expect(one(`feeds-tag-row-${TAG_B}`)).not.toBeNull()
    expect(one<HTMLInputElement>(`feeds-tag-rename-input-${TAG_A}`)!.value).toBe("金融")
    expect(container!.textContent).toContain("管理标签（2）")
    // 还没输入名字时不给建
    expect(one<HTMLButtonElement>("feeds-tag-create")!.disabled).toBe(true)
  })

  it("一个标签都没有时显示空态而不是禁用按钮阵", async () => {
    await mount(data([]))

    expect(container!.textContent).toContain(EMPTY)
    expect(container!.querySelectorAll("[data-testid^='feeds-tag-row-']")).toHaveLength(0)
  })

  it("新建标签：用当前 revision 写入，成功后清空输入并重读快照", async () => {
    processingClientMock.createTag.mockResolvedValue({ formatVersion: 1, revision: 8, tags: [] })
    await mount(data())

    const input = one<HTMLInputElement>("feeds-tag-create-input")!
    await type(input, "  播客  ")

    await click(one("feeds-tag-create"))

    expect(processingClientMock.createTag).toHaveBeenCalledTimes(1)
    expect(processingClientMock.createTag.mock.calls[0]!.slice(0, 2)).toEqual(["播客", 7])
    expect(processingClientMock.createTag.mock.calls[0]![2]).toBeInstanceOf(AbortSignal)
    expect(one<HTMLInputElement>("feeds-tag-create-input")!.value).toBe("")
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("新建失败时保留用户输入的名字，并露出可读错误", async () => {
    const { ProcessingRequestError } = await import("~/modules/action/processing-client")
    processingClientMock.createTag.mockRejectedValue(new ProcessingRequestError("conflict"))
    await mount(data())

    await type(one<HTMLInputElement>("feeds-tag-create-input")!, "播客")
    await click(one("feeds-tag-create"))

    expect(one<HTMLInputElement>("feeds-tag-create-input")!.value).toBe("播客")
    expect(container!.textContent).toContain(WRITE_FAILED)
    expect(reload).not.toHaveBeenCalled()
  })

  it("改名：名称没变时按钮禁用，改名后按 id 写入", async () => {
    processingClientMock.renameTag.mockResolvedValue({ revision: 8, changedTags: 1 })
    await mount(data())

    const rename = () => one<HTMLButtonElement>(`feeds-tag-rename-${TAG_A}`)!
    expect(rename().textContent).toBe(RENAME)
    expect(rename().disabled).toBe(true)

    const input = one<HTMLInputElement>(`feeds-tag-rename-input-${TAG_A}`)!
    await type(input, "财经")
    expect(rename().disabled).toBe(false)

    await click(rename())

    expect(processingClientMock.renameTag.mock.calls[0]!.slice(0, 3)).toEqual([TAG_A, "财经", 7])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("删除要走二次确认，确认后才写入", async () => {
    processingClientMock.deleteTag.mockResolvedValue({ revision: 8, removedTags: 1 })
    await mount(data())

    await click(one(`feeds-tag-delete-${TAG_A}`))

    expect(askMock).toHaveBeenCalledTimes(1)
    const options = askMock.mock.calls[0]![0] as {
      variant?: string
      title?: string
      onConfirm?: () => void
    }
    expect(options.variant).toBe("danger")
    expect(options.title).toContain("金融")
    // 还没确认，不能已经写了
    expect(processingClientMock.deleteTag).not.toHaveBeenCalled()

    await act(async () => {
      options.onConfirm?.()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(processingClientMock.deleteTag.mock.calls[0]!.slice(0, 2)).toEqual([TAG_A, 7])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("删除按钮的文字与确认文案不是同一个 key 也能各自翻译", async () => {
    await mount(data())

    expect(one<HTMLButtonElement>(`feeds-tag-delete-${TAG_A}`)!.textContent).toBe(DELETE)
    expect(container!.textContent).toContain(CREATE)
    expect(container!.textContent).not.toContain("feeds.processing_tags")
  })
})
