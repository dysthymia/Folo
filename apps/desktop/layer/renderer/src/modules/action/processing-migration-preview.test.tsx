import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { selectJsonFile } from "~/lib/export"

import { ProcessingMigrationPreview } from "./processing-migration-preview"

vi.mock("~/lib/export", () => ({ selectJsonFile: vi.fn() }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 测试保留翻译 key，确保导入按钮和不可迁移原因可被稳定断言。
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ""}`,
  }),
}))

const oldExport = JSON.stringify({
  version: "1.0",
  rules: [
    {
      name: "保留条件",
      condition: [[{ field: "entry_title", operator: "contains", value: "AI" }]],
      result: { actions: [{ type: "ai_transform", prompt: "提取事实" }] },
    },
    {
      name: "旧 Webhook",
      condition: [],
      result: { webhooks: ["https://example.test/hook"] },
    },
  ],
})

describe("ProcessingMigrationPreview", () => {
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

  it("只预览不导入，明确点击导入后才写入支持规则", async () => {
    vi.mocked(selectJsonFile).mockResolvedValue(oldExport)
    const onImport = vi.fn()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<ProcessingMigrationPreview onImport={onImport} />)
    })

    const choose = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("processing.migration.choose_file"),
    )!
    await act(async () => choose.click())
    expect(container.textContent).toContain("保留条件")
    expect(container.textContent).toContain("processing.migration.status.supported")
    expect(container.textContent).toContain("processing.migration.status.unsupported")
    expect(container.textContent).toContain("processing.migration.issue.external_side_effect")
    expect(container.textContent).toContain("processing.migration.new_condition")
    expect(container.textContent).toContain("processing.migration.new_action")
    expect(container.textContent).toContain("processing.migration.cloud_readonly")
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(onImport).not.toHaveBeenCalled()

    const importButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("processing.migration.import"),
    )!
    await act(async () => importButton.click())
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport.mock.calls[0]?.[0]).toMatchObject({
      entries: [
        {
          rule: {
            name: "保留条件",
            when: { anyOf: [{ allOf: [{ field: "entry_title" }] }] },
          },
        },
      ],
    })
    expect(importButton.disabled).toBe(true)
    await act(async () => importButton.click())
    expect(onImport).toHaveBeenCalledTimes(1)
  })

  it("local 默认仅复制，用户勾选后才携带发布后停用目标", async () => {
    vi.mocked(selectJsonFile).mockResolvedValue(
      JSON.stringify({
        version: "1.0",
        type: "folo-local-actions",
        rules: [
          {
            index: 0,
            name: "本地规则",
            condition: [],
            result: { actions: [{ type: "ai_transform", prompt: "提取事实" }] },
          },
        ],
      }),
    )
    const onImport = vi.fn()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProcessingMigrationPreview onImport={onImport} />))
    await act(async () => container!.querySelector<HTMLButtonElement>("button")!.click())

    expect(container.textContent).toContain("processing.migration.location.local")
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.checked).toBe(false)
    await act(async () => checkbox.click())
    const importButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("processing.migration.import"),
    )!
    await act(async () => importButton.click())

    expect(onImport.mock.calls[0]?.[0]).toMatchObject({
      entries: [
        {
          localSwitchTarget: {
            index: 0,
            name: "本地规则",
            condition: [],
            result: { actions: [{ type: "ai_transform", prompt: "提取事实" }] },
          },
        },
      ],
    })
  })

  it("文件解析失败时显示错误且不声称已导入", async () => {
    vi.mocked(selectJsonFile).mockResolvedValue("not-json")
    const onImport = vi.fn()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProcessingMigrationPreview onImport={onImport} />))
    const choose = container.querySelector("button")!
    await act(async () => choose.click())
    expect(container.textContent).toContain("processing.migration.invalid_file")
    expect(container.textContent).not.toContain("processing.migration.imported")
    expect(onImport).not.toHaveBeenCalled()
  })
})
