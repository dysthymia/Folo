import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SemanticDedupeProvider } from "./semantic-dedupe-provider"

const mocks = vi.hoisted(() => ({
  backend: false,
  settings: {
    semanticDedupeDebugPanel: false,
    semanticDedupeEnabled: true,
    semanticDedupeModel: "legacy-model",
    semanticDedupeReasoningEffort: "low",
  },
  register: vi.fn(() => vi.fn()),
  setAllowed: vi.fn(),
  hydrate: vi.fn(),
}))
vi.mock("@follow/store/entry/semantic-dedupe", () => ({
  registerSemanticDuplicateEvaluator: mocks.register,
  SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD: 0.85,
  semanticDedupeActions: {},
  useSemanticDedupeHydration: mocks.hydrate,
  useSemanticDedupeStore: vi.fn(),
}))
vi.mock("@follow/store/entry/processing-role", () => ({
  entryProcessingRoleActions: { setLocalDedupeAllowed: mocks.setAllowed },
}))
vi.mock("@follow/store/user/hooks", () => ({ useWhoami: () => ({ id: "owner" }) }))
vi.mock("~/atoms/settings/ai", () => ({
  useAISettingSelector: (selector: (settings: typeof mocks.settings) => unknown) =>
    selector(mocks.settings),
}))
vi.mock("~/lib/client", () => ({
  ipcServices: { semanticDedupe: { evaluateCandidates: vi.fn() } },
}))
vi.mock("~/modules/ai-chat/local-provider", () => ({ isLocalFoloHost: () => mocks.backend }))

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.backend = false
  mocks.settings.semanticDedupeEnabled = true
  mocks.settings.semanticDedupeDebugPanel = false
  Object.defineProperty(window, "electron", { configurable: true, value: undefined })
})
afterEach(async () => {
  await act(() => root.render(null))
  vi.unstubAllEnvs()
  Object.defineProperty(window, "electron", { configurable: true, value: undefined })
})

// 真实 Provider 同时控制旧执行器和旧缓存资格，不能只停模型却继续隐藏条目。
describe("后台与旧去重执行器隔离", () => {
  it("后台接管时即使开发执行器可用也不注册旧模型，并保留缓存审计加载", async () => {
    mocks.backend = true
    mocks.settings.semanticDedupeDebugPanel = true
    vi.stubEnv("DEV", true)
    await act(() => root.render(<SemanticDedupeProvider />))
    expect(mocks.register).toHaveBeenCalledWith(null)
    expect(mocks.setAllowed).toHaveBeenCalledWith(false)
    expect(mocks.hydrate).toHaveBeenCalledWith("owner")
    expect(host.innerHTML).toBe("")
  })

  it("独立桌面仍可运行旧去重，关闭开关后执行器和默认缓存读取同步停用", async () => {
    Object.defineProperty(window, "electron", { configurable: true, value: {} })
    await act(() => root.render(<SemanticDedupeProvider />))
    expect(mocks.register).toHaveBeenCalledWith(expect.any(Function), "electron")
    expect(mocks.setAllowed).toHaveBeenLastCalledWith(true)
    mocks.settings.semanticDedupeEnabled = false
    await act(() => root.render(<SemanticDedupeProvider />))
    expect(mocks.register).toHaveBeenLastCalledWith(null)
    expect(mocks.setAllowed).toHaveBeenLastCalledWith(false)
  })

  it("没有执行器的生产浏览器不使用旧缓存隐藏内容", async () => {
    vi.stubEnv("DEV", false)
    await act(() => root.render(<SemanticDedupeProvider />))
    expect(mocks.register).toHaveBeenCalledWith(null)
    expect(mocks.setAllowed).toHaveBeenCalledWith(false)
  })
})
