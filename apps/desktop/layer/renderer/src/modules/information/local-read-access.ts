import { isLocalInformationRead } from "@follow/information-core"
import { z } from "zod"

import { informationRequestInit } from "./request-init"

const sessionSchema = z.object({
  ownerId: z.string().min(1),
  token: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.number().finite(),
})
type LocalSession = z.infer<typeof sessionSchema>
type LocalFetcher = (input: string, init: RequestInit) => Promise<Response>
type ReadContext = { scope: string; ownerId: string | null; generation: number }

export class LocalInformationReadError extends Error {
  constructor(readonly kind: "authorization" | "account_mismatch" | "request" | "invalid") {
    super(kind)
  }
}

let generation = 0
let currentScope: string | null = null
let session: LocalSession | null = null
let pending: Promise<LocalSession> | null = null
let nativeOwner: (() => string | null) | null = null
let nativeOwnerReady: Promise<void> | null = null

function revokeSession() {
  generation++
  session = null
  pending = null
}

function localSurface() {
  if (typeof window === "undefined" || typeof document === "undefined") return null
  const standalone = document.documentElement.hasAttribute("data-information-page")
  const { hostname, origin } = window.location
  if (
    hostname !== "local.folo.is" &&
    !(standalone && ["localhost", "127.0.0.1"].includes(hostname))
  )
    return null
  return { standalone, origin }
}

async function readContext(): Promise<ReadContext | null> {
  const surface = localSurface()
  if (!surface) return null
  if (!surface.standalone && !nativeOwner) {
    // 原生界面只读已缓存身份；独立工作台不加载完整主站 store，也不查询官方会话。
    nativeOwnerReady ??= (async () => {
      const [{ whoami }, { useUserStore }] = await Promise.all([
        import("@follow/store/user/getters"),
        import("@follow/store/user/store"),
      ])
      nativeOwner = () => whoami()?.id ?? null
      useUserStore.subscribe((next, previous) => {
        // 注销后再登录同一账号也撤销旧凭据，避免只按字符串 id 判断漏掉中间状态。
        if (next.whoami?.id !== previous.whoami?.id) revokeSession()
      })
    })()
    await nativeOwnerReady
  }
  const ownerId = surface.standalone ? null : nativeOwner!()
  const scope = `${surface.origin}:${surface.standalone ? "workspace" : "native"}:${ownerId ?? ""}`
  if (currentScope !== scope) {
    revokeSession()
    currentScope = scope
  }
  if (!surface.standalone && !ownerId) throw new LocalInformationReadError("authorization")
  return { scope, ownerId, generation }
}

async function verifyContext(context: ReadContext) {
  const current = await readContext()
  if (!current || current.scope !== context.scope || current.generation !== context.generation) {
    revokeSession()
    throw new LocalInformationReadError("account_mismatch")
  }
}

async function bootstrap(context: ReadContext, fetcher: LocalFetcher) {
  if (session && session.expiresAt > Date.now()) return session
  if (pending) return pending
  const request = (async () => {
    // 短时读取令牌仅保存在模块内存中，不发送或持久化任何官方 token。
    const response = await fetcher("/information/api/local-read-session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: context.ownerId }),
    })
    await verifyContext(context)
    if (response.status === 401) throw new LocalInformationReadError("authorization")
    if (response.status === 403) throw new LocalInformationReadError("account_mismatch")
    if (!response.ok) throw new LocalInformationReadError("request")
    const parsed = sessionSchema.safeParse(await response.json())
    if (!parsed.success || parsed.data.expiresAt <= Date.now())
      throw new LocalInformationReadError("invalid")
    await verifyContext(context)
    if (context.ownerId !== null && parsed.data.ownerId !== context.ownerId)
      throw new LocalInformationReadError("account_mismatch")
    session = parsed.data
    return parsed.data
  })()
  pending = request
  try {
    return await request
  } finally {
    if (pending === request) pending = null
  }
}

export async function tryLocalInformationRead(
  path: string,
  method: string,
  signal: AbortSignal,
  body?: unknown,
  fetcher: LocalFetcher = (input, init) => globalThis.fetch(input, init),
): Promise<Response | null> {
  if (!isLocalInformationRead(method, path, body)) return null
  const context = await readContext()
  if (!context) return null
  const url = path.startsWith("/information/") ? path : `/information/v1/${path}`
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted()
    await verifyContext(context)
    let access: LocalSession
    try {
      access = await bootstrap(context, fetcher)
    } catch (error) {
      // 服务重启后的 401 最多重新建立一次会话；账号不符和其它错误绝不回退官方授权。
      if (
        attempt === 0 &&
        error instanceof LocalInformationReadError &&
        error.kind === "authorization"
      ) {
        session = null
        continue
      }
      throw error
    }
    signal.throwIfAborted()
    await verifyContext(context)
    const response = await fetcher(
      url,
      informationRequestInit({
        method,
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "X-Folo-Local-Read-Token": access.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    await verifyContext(context)
    signal.throwIfAborted()
    if (response.status === 403) {
      revokeSession()
      throw new LocalInformationReadError("account_mismatch")
    }
    if (response.status !== 401 || attempt === 1) return response
    if (session?.token === access.token) session = null
  }
  throw new LocalInformationReadError("authorization")
}
