import { describe, expect, it } from "vitest"

import { informationRequestInit } from "./request-init"

describe("信息服务读取请求初始化", () => {
  it("仅将空体 GET 映射为带读取标记的 POST，并保留鉴权请求选项", () => {
    const signal = new AbortController().signal
    const result = informationRequestInit({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "X-Folo-One-Time-Token": "fresh-token" },
    })

    expect(result).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    })
    expect(result.body).toBeUndefined()
    expect(new Headers(result.headers).get("X-Folo-One-Time-Token")).toBe("fresh-token")
    expect(new Headers(result.headers).get("X-Folo-Read")).toBe("1")
  })

  it("不改变写入请求，也拒绝伪装成读取的请求体", () => {
    const write: RequestInit = { method: "PUT", body: "{}", headers: { "X-Test": "1" } }
    expect(informationRequestInit(write)).toBe(write)
    expect(() => informationRequestInit({ method: "GET", body: "{}" })).toThrow(
      "information_read_request_must_not_have_body",
    )
  })
})
