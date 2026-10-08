import type { AttentionSettings } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ProcessingAttentionSettings } from "./processing-attention-settings"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe("关注清单编辑", () => {
  it("首次打开清单为空，不预填项目或推测持仓", () => {
    const markup = renderToStaticMarkup(<ProcessingAttentionSettings onChange={vi.fn()} />)
    expect(markup).toContain("processing.attention.watch_empty")
    expect(markup).toContain('type="checkbox" checked=""')
    expect(markup).not.toContain("processing.attention.watch_name")
  })
  it("新增对象使用稳定身份，修改级别与删除对象只改变关注配置", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    let value: AttentionSettings | undefined
    const draw = () =>
      root.render(
        <ProcessingAttentionSettings
          value={value}
          onChange={(next) => {
            value = next
            draw()
          }}
        />,
      )
    try {
      await act(async () => draw())
      await act(async () => host.querySelector("button")!.click())
      expect(value?.watchlist).toEqual([{ id: expect.any(String), name: "", aliases: [] }])
      const id = value!.watchlist[0]!.id
      expect(host.textContent).toContain("processing.attention.watch_aliases")
      await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
      expect(value).toMatchObject({ enabled: false, watchlist: [{ id }] })
      await act(async () => host.querySelector("button")!.click())
      expect(value?.watchlist).toEqual([])
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
