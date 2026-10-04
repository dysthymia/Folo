import type { LookupAddress } from "node:dns"

import { describe, expect, it, vi } from "vitest"

import { isPublicAddress, readPublicArticle } from "./public-article"

const address: LookupAddress = { address: "93.184.216.34", family: 4 }
const page = {
  status: 200,
  location: null as string | null,
  contentType: "text/html; charset=utf-8" as string | null,
  body: "<html><head><title>迁移教程</title></head><body><nav>导航噪声</nav><article><p>先备份数据库。</p><p>执行迁移并核对结果。</p><script>不执行指令</script></article></body></html>",
}
function fixture() {
  // DNS 与 HTTP 均为独立桩，不会访问真实公开网页或内网。
  const resolve = vi.fn(async (_hostname: string) => [address])
  const load = vi.fn(async (_url: URL, _address: LookupAddress, _signal: AbortSignal) => page)
  return { resolve, load }
}

describe("公开外链材料读取", () => {
  it("仅提取正文并固定DNS核验地址，不执行脚本或带入导航", async () => {
    const options = fixture()
    expect(await readPublicArticle("https://learn.example.com/guide#steps", options)).toEqual({
      url: "https://learn.example.com/guide",
      title: "迁移教程",
      text: "先备份数据库。\n执行迁移并核对结果。",
    })
    expect(options.resolve).toHaveBeenCalledOnce()
    expect(options.load.mock.calls[0]?.[1]).toEqual(address)
    expect(options.load.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)
  })
  it.each([
    "127.0.0.1",
    "10.2.3.4",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001:2::5b",
    "::ffff:127.0.0.1",
    "2002:7f00:1::",
  ])("拒绝非公开地址 %s", (value) => {
    expect(isPublicAddress(value)).toBe(false)
  })
  it.each([
    "https://127.0.0.1/",
    "https://2130706433/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
    "https://user:password@learn.example.com/",
    "file:///tmp/file",
    "http://learn.example.com:9000/",
  ])("危险URL不触发DNS或HTTP: %s", async (url) => {
    const options = fixture()
    await expect(readPublicArticle(url, options)).rejects.toMatchObject({ code: "unsafe_url" })
    expect(options.resolve).not.toHaveBeenCalled()
    expect(options.load).not.toHaveBeenCalled()
  })
  it("混合公网/私网DNS记录整体拒绝，不能挑公网记录绕过", async () => {
    const options = fixture()
    options.resolve.mockResolvedValue([address, { address: "10.0.0.1", family: 4 }])
    await expect(readPublicArticle("https://learn.example.com/", options)).rejects.toMatchObject({
      code: "unsafe_url",
    })
    expect(options.load).not.toHaveBeenCalled()
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true)
  })
  it("每跳重新检查URL与DNS，重定向到私网地址前停止", async () => {
    const options = fixture()
    options.load.mockResolvedValueOnce({
      ...page,
      status: 302,
      location: "https://next.example.com/guide",
    })
    options.resolve
      .mockResolvedValueOnce([address])
      .mockResolvedValueOnce([{ address: "192.168.0.1", family: 4 }])
    await expect(readPublicArticle("https://learn.example.com/", options)).rejects.toMatchObject({
      code: "unsafe_url",
    })
    expect(options.load).toHaveBeenCalledOnce()
    const direct = fixture()
    direct.load.mockResolvedValueOnce({
      ...page,
      status: 302,
      location: "http://169.254.169.254/latest",
    })
    await expect(readPublicArticle("https://learn.example.com/", direct)).rejects.toMatchObject({
      code: "unsafe_url",
    })
    expect(direct.resolve).toHaveBeenCalledOnce()
  })
  it("相对跳转保留目标正文，循环跳转有上限", async () => {
    const options = fixture()
    options.load.mockResolvedValueOnce({ ...page, status: 302, location: "/guide" })
    expect((await readPublicArticle("https://learn.example.com/", options)).url).toBe(
      "https://learn.example.com/guide",
    )
    expect(options.resolve).toHaveBeenCalledTimes(2)
    const loop = fixture()
    loop.load.mockResolvedValue({ ...page, status: 302, location: "/loop" })
    await expect(readPublicArticle("https://learn.example.com/", loop)).rejects.toMatchObject({
      code: "redirect_limit",
    })
    expect(loop.load).toHaveBeenCalledTimes(2)
  })
  it.each([
    [{ ...page, contentType: "application/pdf" }, "unsupported_type"],
    [{ ...page, contentType: null }, "unsupported_type"],
    [{ ...page, body: "<html><body><nav>链接导航</nav></body></html>" }, "empty"],
    [{ ...page, body: `<article><p>${"字".repeat(40_001)}</p></article>` }, "too_large"],
    [{ ...page, body: "x".repeat(1_000_001) }, "too_large"],
  ] as const)("未知/过长正文不能伪造完整状态(%s)", async (response, code) => {
    const options = fixture()
    await expect(
      readPublicArticle("https://learn.example.com/", { ...options, load: async () => response }),
    ).rejects.toMatchObject({ code })
  })
  it("等待DNS期间取消能立即退出，不会发起后续连接", async () => {
    const options = fixture(),
      controller = new AbortController()
    options.resolve.mockReturnValue(new Promise(() => {}))
    const pending = readPublicArticle("https://learn.example.com/", {
      ...options,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "timeout" })
    expect(options.load).not.toHaveBeenCalled()
  })
})
