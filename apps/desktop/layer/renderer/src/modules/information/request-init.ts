// HTTP 同源读取在非安全上下文不会稳定附带 Sec-Fetch-Site；改为受服务端严格限定的空体 POST。
export function informationRequestInit(init: RequestInit): RequestInit {
  if ((init.method ?? "GET").toUpperCase() !== "GET") return init
  if (init.body !== undefined && init.body !== null)
    throw new Error("information_read_request_must_not_have_body")
  const headers = new Headers(init.headers)
  headers.set("X-Folo-Read", "1")
  const { body: _body, ...rest } = init
  return { ...rest, method: "POST", headers }
}
