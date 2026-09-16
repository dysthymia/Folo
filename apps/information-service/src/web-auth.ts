import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"

import { dirname } from "pathe"
import { z } from "zod"

import { FoloReader, FoloReadError } from "./folo"
import type { Store } from "./store"

export class WebAuthError extends Error {
  constructor(
    public readonly status: 401 | 403 | 502,
    public readonly code: string,
  ) {
    // 仅返回固定分类，不能泄露一次性凭据、Cookie 或上游错误正文。
    super(code)
  }
}

export function createWebAuthenticator(store: Store, credentialPath: string, fetcher = fetch) {
  return async (oneTimeToken: string) => {
    const apiUrl = "https://api.folo.is"
    try {
      // 复用主站已有的凭据交换接口；认证只发往固定官方地址，禁止重定向。
      const response = await fetcher(`${apiUrl}/better-auth/one-time-token/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: oneTimeToken }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      })
      if ([400, 401, 403].includes(response.status)) throw new WebAuthError(401, "authorization")
      if (!response.ok) throw new WebAuthError(502, "upstream")
      const cookieToken = response.headers
        .getSetCookie()
        .map((cookie) => cookie.match(/^(?:__Secure-)?better-auth\.session_token=([^;]+)/)?.[1])
        .find(Boolean)
      const body = z
        .object({ session: z.object({ token: z.string().min(1) }) })
        .safeParse(await response.json().catch(() => null))
      const token = cookieToken ?? (body.success ? body.data.session.token : undefined)
      if (!token) throw new WebAuthError(502, "invalid_response")
      const reader = new FoloReader({ apiUrl, token, fetch: fetcher })
      const session = await reader.session()
      // 以官方核验的账号为准；绝不信任浏览器传入的账号 ID，也不展示其他账号的数据。
      if (store.ownerId && store.ownerId !== session.ownerId) {
        throw new WebAuthError(403, "account_mismatch")
      }
      const sources = store.sources().length ? null : await reader.sources()
      store.bindOwner(session.ownerId)
      if (sources) store.replaceSources(sources)
      // 后台凭据单独原子保存，关闭页面后仍可运行；不改写用户的 CLI 配置。
      await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 })
      const temporary = `${credentialPath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ apiUrl, token }), { mode: 0o600, flag: "wx" })
        await rename(temporary, credentialPath)
      } finally {
        await rm(temporary, { force: true })
      }
    } catch (error) {
      if (error instanceof WebAuthError) throw error
      if (error instanceof FoloReadError && error.code === "unauthorized") {
        throw new WebAuthError(401, "authorization")
      }
      throw new WebAuthError(502, "upstream")
    }
  }
}
