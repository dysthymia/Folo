import { describe, expect, it, vi } from "vitest"

import { isPublicAddress, readPublicArticle } from "./public-article"
import { isFakeIpResolution, resolveTrustedPublicDns } from "./public-dns"

const hostname = "guide.python.org"
const fake = [
  { address: "198.18.0.93", family: 4 },
  { address: "2001:2::5b", family: 6 },
]
function response(url: URL, ttl = 60) {
  const type = Number(url.searchParams.get("type"))
  return {
    Status: 0,
    TC: false,
    Question: [{ name: `${hostname}.`, type }],
    Answer: [
      {
        name: `${hostname}.`,
        type,
        TTL: ttl,
        data: type === 1 ? "93.184.216.34" : "2606:4700:4700::1111",
      },
    ],
  }
}

describe("仅Fake-IP公开域名的可信DoH回退", () => {
  // 所有DNS/网页传输都为桩，不会测试连接私网或发出真实DoH请求。
  it("只有全部benchmark地址可回退，真实私网/混合地址与内网名称拒绝", async () => {
    expect(isFakeIpResolution(hostname, fake)).toBe(true)
    for (const name of [
      "localhost",
      "printer",
      "api.internal",
      "private.internal.example.com",
      "foo.test",
      "198.18.0.1",
    ])
      expect(isFakeIpResolution(name, fake)).toBe(false)
    for (const address of ["127.0.0.1", "10.0.0.1", "192.168.0.1", "93.184.216.34"])
      expect(isFakeIpResolution(hostname, [...fake, { address, family: 4 }])).toBe(false)
    const query = vi.fn(async (url: URL) => response(url))
    await expect(
      resolveTrustedPublicDns("api.internal", new AbortController().signal, isPublicAddress, query),
    ).rejects.toMatchObject({ code: "unsafe_address" })
    expect(query).not.toHaveBeenCalled()
  })
  it("并行A/AAAA核对Question并返回全部公开地址，用官方HTTPS端点且不传凭据", async () => {
    const query = vi.fn(async (url: URL) => response(url))
    const addresses = await resolveTrustedPublicDns(
      hostname,
      new AbortController().signal,
      isPublicAddress,
      query,
    )
    expect(addresses).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ])
    expect(
      query.mock.calls.map(([url]) => [
        url.origin,
        url.pathname,
        url.searchParams.get("name"),
        url.searchParams.get("type"),
      ]),
    ).toEqual([
      ["https://cloudflare-dns.com", "/dns-query", hostname, "1"],
      ["https://cloudflare-dns.com", "/dns-query", hostname, "28"],
    ])
  })
  it("最短TTL过期才重新查，调用方修改结果不能污染缓存", async () => {
    const query = vi.fn(async (url: URL) => response(url, 1)),
      signal = new AbortController().signal
    const first = await resolveTrustedPublicDns(hostname, signal, isPublicAddress, query)
    first[0]!.address = "127.0.0.1"
    expect(
      (await resolveTrustedPublicDns(hostname, signal, isPublicAddress, query))[0]?.address,
    ).toBe("93.184.216.34")
    expect(query).toHaveBeenCalledTimes(2)
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1001)
    try {
      await resolveTrustedPublicDns(hostname, signal, isPublicAddress, query)
    } finally {
      clock.mockRestore()
    }
    expect(query).toHaveBeenCalledTimes(4)
  })
  it.each(["private", "fake", "wrong-question", "truncated", "nx-domain"])(
    "不可信DoH响应不进入缓存(%s)",
    async (kind) => {
      const query = vi.fn(async (url: URL) => {
        const answer = response(url)
        if (kind === "private" && url.searchParams.get("type") === "28")
          answer.Answer[0]!.data = "::1"
        if (kind === "fake") answer.Answer[0]!.data = "198.18.0.1"
        if (kind === "wrong-question") answer.Question[0]!.name = "other.example.com."
        if (kind === "truncated") answer.TC = true
        if (kind === "nx-domain") answer.Status = 3
        return answer
      })
      const run = () =>
        resolveTrustedPublicDns(hostname, new AbortController().signal, isPublicAddress, query)
      await expect(run()).rejects.toMatchObject({
        code: ["private", "fake"].includes(kind) ? "unsafe_address" : "invalid_response",
      })
      await expect(run()).rejects.toBeInstanceOf(Error)
      expect(query).toHaveBeenCalledTimes(4)
    },
  )
  it("Fake-IP回退后固定新的公开目标地址；真实私网拒绝且不查询DoH", async () => {
    const trustedResolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }])
    const load = vi.fn(async (_url: URL, _address: { address: string; family: number }) => ({
      status: 200,
      location: null,
      contentType: "text/plain",
      body: "公开教程的完整步骤。",
    }))
    const options = { resolve: async () => fake, trustedResolve, load }
    expect((await readPublicArticle("https://guide.python.org/", options)).text).toBe(
      "公开教程的完整步骤。",
    )
    expect(trustedResolve).toHaveBeenCalledOnce()
    expect(load.mock.calls[0]?.[1].address).toBe("93.184.216.34")
    trustedResolve.mockClear()
    load.mockClear()
    await expect(
      readPublicArticle("https://guide.python.org/", {
        ...options,
        resolve: async () => [{ address: "10.0.0.1", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "unsafe_url" })
    expect(trustedResolve).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })
})
