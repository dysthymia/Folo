import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ProcessingServiceDetail } from "./processing-service-detail"
import type { UnifiedRuleRow } from "./unified-action-list"
import { UnifiedActionList } from "./unified-action-list"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

// ProcessingServiceDetail 复用既有编辑面板；测试不可用分支时无需真正挂载它。
vi.mock("./processing-setting", () => ({
  ProcessingSetting: () => <div data-testid="processing-setting">processing-setting</div>,
}))

const cloudLocalProcessingRows: UnifiedRuleRow[] = [
  {
    id: "cloud:0",
    scope: "cloud",
    name: "Cloud Rule",
    conditionSummary: "actions.action_card.all",
    actionSummary: "actions.action_card.summary.no_actions",
    enabled: true,
  },
  {
    id: "local:0",
    scope: "local",
    name: "Local Rule",
    conditionSummary: "actions.action_card.all",
    actionSummary: "actions.action_card.summary.no_actions",
    enabled: false,
  },
  {
    id: "processing_service:r1",
    scope: "processing_service",
    name: "Processing Rule",
    conditionSummary: "actions.action_card.all",
    actionSummary: "processing.type.ai_transform",
    enabled: true,
    enableBlocked: true,
  },
]

describe("UnifiedActionList", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it("同列渲染来自三个执行位置的规则，并显示执行位置徽标", async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root!.render(
        <UnifiedActionList
          rules={cloudLocalProcessingRows}
          selectedId={null}
          onSelect={onSelect}
        />,
      )
    })

    // 三个执行位置的规则名都出现
    expect(container!.textContent).toContain("Cloud Rule")
    expect(container!.textContent).toContain("Local Rule")
    expect(container!.textContent).toContain("Processing Rule")
    // 执行位置作为标识出现（徽标文案为既有 i18n key）
    expect(container!.textContent).toContain("actions.scope.cloud")
    expect(container!.textContent).toContain("actions.scope.local")
    expect(container!.textContent).toContain("processing.scope")
  })

  it("处理服务不可用时，对应规则行给出受限提示而不隐藏入口", async () => {
    await act(async () => {
      root!.render(
        <UnifiedActionList
          rules={cloudLocalProcessingRows}
          selectedId="processing_service:r1"
          onSelect={vi.fn()}
        />,
      )
    })

    expect(container!.textContent).toContain("automation.processing_unavailable_short")
    // 入口仍可见（规则名仍在列表里）
    expect(container!.textContent).toContain("Processing Rule")
  })

  it("点击某一行触发选中回调并带出执行位置标识", async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root!.render(
        <UnifiedActionList
          rules={cloudLocalProcessingRows}
          selectedId={null}
          onSelect={onSelect}
        />,
      )
    })

    const buttons = Array.from(container!.querySelectorAll("button"))
    const processingRow = buttons.find((button) => button.textContent?.includes("Processing Rule"))!
    await act(async () => processingRow.click())

    expect(onSelect).toHaveBeenCalledWith("processing_service:r1")
  })
})

describe("ProcessingServiceDetail 不可用分支", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it("处理服务不可用时，详情内写明原因与前提，且不渲染可编辑面板", async () => {
    await act(async () => {
      root!.render(<ProcessingServiceDetail available={false} onDirty={vi.fn()} />)
    })

    expect(container!.textContent).toContain("automation.processing_unavailable_title")
    expect(container!.textContent).toContain("automation.processing_unavailable_reason")
    expect(container!.textContent).toContain("automation.processing_unavailable_prerequisite")
    // 不渲染编辑面板（避免误导用户以为可在此启用/运行）
    expect(container!.querySelector('[data-testid="processing-setting"]')).toBeNull()
  })
})
