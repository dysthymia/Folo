export const informationReleaseMismatchEvent = "folo:information-release-mismatch"

export class InformationReleaseMismatch extends Error {
  constructor() {
    super("local_release_mismatch")
  }
}

function localReleaseId() {
  // 只有统一构建的本机页面携带发布号，官方站点与开发服务器继续沿用原协议。
  return typeof window !== "undefined" &&
    ["local.folo.is", "localhost", "127.0.0.1"].includes(window.location.hostname)
    ? import.meta.env.VITE_FOLO_LOCAL_RELEASE_ID
    : undefined
}

export function verifyInformationRelease(response: Response) {
  const expected = localReleaseId()
  if (expected && response.headers.get("X-Folo-Local-Release") !== expected) {
    // 子面板的读写也通知页面统一显示刷新入口，不依赖每个面板分别解释错误。
    window.dispatchEvent(new Event(informationReleaseMismatchEvent))
    throw new InformationReleaseMismatch()
  }
}

// HTTP 同源读取在非安全上下文不会稳定附带 Sec-Fetch-Site；改为受服务端严格限定的空体 POST。
export function informationRequestInit(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers)
  const releaseId = localReleaseId()
  if (releaseId) headers.set("X-Folo-Local-Release", releaseId)
  if ((init.method ?? "GET").toUpperCase() !== "GET") return releaseId ? { ...init, headers } : init
  if (init.body !== undefined && init.body !== null)
    throw new Error("information_read_request_must_not_have_body")
  headers.set("X-Folo-Read", "1")
  const { body: _body, ...rest } = init
  return { ...rest, method: "POST", headers }
}
