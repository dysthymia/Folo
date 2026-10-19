import { afterEach, describe, expect, it, vi } from "vitest"

import {
  InformationReleaseMismatch,
  informationRequestInit,
  verifyInformationRelease,
} from "./request-init"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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

  it("本机读写请求携带发布号，响应版本不符或缺失时要求刷新", () => {
    vi.stubGlobal("window", {
      location: new URL("http://local.folo.is/action"),
      dispatchEvent: vi.fn(),
    })
    vi.stubEnv("VITE_FOLO_LOCAL_RELEASE_ID", "current-release")
    for (const method of ["GET", "PUT"]) {
      const init = informationRequestInit({ method })
      expect(new Headers(init.headers).get("X-Folo-Local-Release")).toBe("current-release")
    }
    expect(() =>
      verifyInformationRelease(
        new Response(null, {
          headers: { "X-Folo-Local-Release": "current-release" },
        }),
      ),
    ).not.toThrow()
    for (const release of [null, "old-release"]) {
      expect(() =>
        verifyInformationRelease(
          new Response(null, {
            headers: release ? { "X-Folo-Local-Release": release } : {},
          }),
        ),
      ).toThrow(InformationReleaseMismatch)
    }
  })

  it("官方站点不携带或核对本机发布号", () => {
    vi.stubGlobal("window", { location: new URL("https://app.folo.is/action") })
    vi.stubEnv("VITE_FOLO_LOCAL_RELEASE_ID", "current-release")
    expect(
      new Headers(informationRequestInit({ method: "GET" }).headers).has("X-Folo-Local-Release"),
    ).toBe(false)
    expect(() => verifyInformationRelease(new Response())).not.toThrow()
  })
})
