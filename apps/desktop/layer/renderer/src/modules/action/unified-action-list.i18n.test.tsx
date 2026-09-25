import appZhCN from "@locales/app/zh-CN.json"
import settingsZhCN from "@locales/settings/zh-CN.json"
import i18next from "i18next"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { UnifiedRuleRow } from "./unified-action-list"
import { buildProcessingConditionSummary, UnifiedActionList } from "./unified-action-list"

// 语言包源文件是**扁平点号键**（`"processing.scope": "处理服务"`），构建产物是**嵌套对象**；
// i18next 用 `keySeparator: "."` 查嵌套路径，所以这里按构建期的同一变换还原成嵌套，
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
    ns: ["settings", "app"],
    defaultNS: "app",
    resources: {
      "zh-CN": {
        app: nest(appZhCN as Record<string, string>),
        settings: nest(settingsZhCN as Record<string, string>),
      },
    },
  })
  return instance
}

const APP_SCOPE = (appZhCN as Record<string, string>)["processing.scope"]!
const SETTINGS_ALL = (settingsZhCN as Record<string, string>)["actions.action_card.all"]!
const SETTINGS_DISABLED = (settingsZhCN as Record<string, string>)[
  "actions.action_card.summary.disabled"
]!
const APP_UNAVAILABLE_SHORT = (appZhCN as Record<string, string>)[
  "automation.processing_unavailable_short"
]!

const rows: UnifiedRuleRow[] = [
  {
    id: "processing_service:r1",
    scope: "processing_service",
    name: "Processing Rule",
    conditionSummary: "condition",
    actionSummary: "action",
    enabled: true,
    enableBlocked: true,
  },
  {
    id: "processing_service:r2",
    scope: "processing_service",
    name: "Disabled Rule",
    conditionSummary: "condition",
    actionSummary: "action",
    enabled: false,
  },
  {
    id: "cloud:0",
    scope: "cloud",
    name: "Cloud Rule",
    conditionSummary: "condition",
    actionSummary: "action",
    enabled: true,
  },
]

// 反向对照：不带 nsMode 时 react-i18next 只用数组第一个命名空间绑定 t。
const Probe = () => {
  const { t: tFallback } = useTranslation(["settings", "app"], { nsMode: "fallback" })
  const { t: tDefault } = useTranslation(["settings", "app"])
  // 应用的资源增强让 `t` 只接受带命名空间前缀的键（`app:processing.scope`）。
  // 这里要故意用**不带前缀**的键做正反对照，所以显式绕开键的字面量收窄。
  const loose = (t: unknown) => t as (key: string) => string
  return (
    <div>
      <span data-testid="fallback-scope">{loose(tFallback)("processing.scope")}</span>
      <span data-testid="default-scope">{loose(tDefault)("processing.scope")}</span>
      <span data-testid="fallback-condition">
        {buildProcessingConditionSummary({ all: true }, (key) => tFallback(key as never))}
      </span>
      <span data-testid="default-condition">
        {buildProcessingConditionSummary({ all: true }, (key) => tDefault(key as never))}
      </span>
    </div>
  )
}

describe("统一规则列表的跨命名空间解析", () => {
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

  // 这条就是本轮线上缺陷的守护：徽标文案在 app、停用提示在 settings，同一个列表项里混用两个命名空间。
  it("列表项同时解析 app 与 settings 两个命名空间的文案，不出现 raw key", async () => {
    await act(async () => {
      root!.render(
        <I18nextProvider i18n={i18n!}>
          <UnifiedActionList rules={rows} selectedId={null} onSelect={() => {}} />
        </I18nextProvider>,
      )
    })

    const text = container!.textContent ?? ""
    // 三个来源都渲染成译文
    expect(text).toContain(APP_SCOPE) // app: processing.scope
    expect(text).toContain(SETTINGS_DISABLED) // settings: actions.action_card.summary.disabled
    expect(text).toContain(APP_UNAVAILABLE_SHORT) // app: automation.processing_unavailable_short
    // 一个 raw key 都不许漏出来
    expect(text).not.toContain("processing.scope")
    expect(text).not.toContain("actions.action_card.summary.disabled")
    expect(text).not.toContain("automation.processing_unavailable_short")
  })

  it("命名空间绑定的正反对照：只有 nsMode=fallback 才能跨命名空间回退", async () => {
    await act(async () => {
      root!.render(
        <I18nextProvider i18n={i18n!}>
          <Probe />
        </I18nextProvider>,
      )
    })

    const read = (id: string) => container!.querySelector(`[data-testid="${id}"]`)!.textContent

    // 正向：fallback 模式下 app 与 settings 的键都能查到
    expect(read("fallback-scope")).toBe(APP_SCOPE)
    expect(read("fallback-condition")).toBe(SETTINGS_ALL)

    // 反向：默认模式只用 ns[0]（数组第一个 = settings）。settings 侧的键照样解析，
    // 但 app 侧的键会原样返回 —— 这正是线上徽标显示 `PROCESSING.SCOPE` 的原因。
    // 这条断言把「为什么必须写 nsMode」固定在测试里，避免以后有人顺手删掉。
    expect(read("default-scope")).toBe("processing.scope")
    expect(read("default-condition")).toBe(SETTINGS_ALL)
  })
})
