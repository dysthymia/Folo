// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

import { BackendDedupeSection } from "./BackendDedupeSection"

const mocks = vi.hoisted(() => ({
  setSetting: vi.fn(),
  client: {
    loadEffective: vi.fn(),
    loadAutomationStatus: vi.fn(),
    loadModelSettings: vi.fn(),
    loadRuns: vi.fn(),
  },
}))
vi.mock("~/atoms/settings/ai", () => ({
  useAISettingSelector: (selector: (settings: { semanticDedupeDebugPanel: boolean }) => unknown) =>
    selector({ semanticDedupeDebugPanel: false }),
  setAISetting: mocks.setSetting,
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: "owner" }) }))
vi.mock("~/modules/ai-chat/local-provider", () => ({ getOneTimeToken: vi.fn() }))
vi.mock("~/modules/action/processing-client", () => ({
  createProcessingClient: () => mocks.client,
}))

describe("后台去重设置", () => {
  it("读取实际配置并保留未启用状态，不显示旧开关或模型输入", async () => {
    mocks.client.loadEffective.mockResolvedValue({ config: { ownerId: "owner", rules: [] } })
    mocks.client.loadAutomationStatus.mockResolvedValue({
      scheduleEnabled: false,
      sourceInventory: { available: 7 },
      rules: [],
    })
    mocks.client.loadModelSettings.mockResolvedValue({ provider: "qianwen", model: "actual" })
    mocks.client.loadRuns.mockResolvedValue({ runs: [], reports: [] })
    const host = document.createElement("div")
    const root = createRoot(host)
    await act(async () => root.render(<BackendDedupeSection />))
    expect(host.textContent).toContain("automation.dedupe.inactive")
    expect(host.textContent).toContain("automation.dedupe.no_report")
    expect(host.querySelector('input[type="text"]')).toBeNull()
    // 新开关只控制整套自动化的调试浮窗，不改变后台去重规则。
    expect(host.textContent).toContain("automation.debug.enabled")
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(mocks.setSetting).toHaveBeenCalledWith("semanticDedupeDebugPanel", true)
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/action?scope=processing_service&dedupe=1",
    )
    expect(mocks.client.loadEffective).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })
})
