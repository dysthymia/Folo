import { ScrollArea } from "@follow/components/ui/scroll-area/ScrollArea.js"
import * as React from "react"
import { act, startTransition, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
afterEach(async () => {
  await act(() => root.render(null))
})

function TransitionRow() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    startTransition(() => setReady(true))
  }, [])
  return <span data-ready={ready}>{ready ? "已就绪" : "等待"}</span>
}

describe("滚动视口 handle 生命周期", () => {
  it("子内容更新不重复清空稳定ref，过渡中的列表行能提交", async () => {
    const ref = vi.fn()
    await act(() => root.render(<ScrollArea ref={ref}>初始内容</ScrollArea>))
    const viewport = host.querySelector("[data-radix-scroll-area-viewport]")
    expect(viewport).not.toBeNull()
    expect(ref).toHaveBeenLastCalledWith(viewport)
    ref.mockClear()
    await act(() =>
      root.render(
        <ScrollArea ref={ref}>
          <TransitionRow />
        </ScrollArea>,
      ),
    )
    expect(host.querySelector('[data-ready="true"]')).not.toBeNull()
    expect(ref).not.toHaveBeenCalled()
  })
  it("更换ref和卸载仍分别通知旧、新调用方", async () => {
    const previous = vi.fn()
    const next = vi.fn()
    await act(() => root.render(<ScrollArea ref={previous}>内容</ScrollArea>))
    previous.mockClear()
    await act(() => root.render(<ScrollArea ref={next}>内容</ScrollArea>))
    expect(previous).toHaveBeenCalledWith(null)
    expect(next).toHaveBeenLastCalledWith(host.querySelector("[data-radix-scroll-area-viewport]"))
    await act(() => root.render(null))
    expect(next).toHaveBeenLastCalledWith(null)
  })
})
