import { z } from "zod"

import { LocalInformationReadError, tryLocalInformationRead } from "./local-read-access"
import { informationSnapshotSchema } from "./snapshot"

const informationAISettingsSchema = z.object({
  // 兼容页也读取自定义模型的公开地址，不接收任何密钥字段。
  provider: z.enum(["qianwen", "codex", "openai-compatible"]),
  model: z.string().min(1),
  hasApiKey: z.boolean(),
  baseUrl: z.string().optional(),
  reasoningEffort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .optional(),
})

const informationAISettingsInputSchema = z.object({
  // 地址只在用户保存配置时提交，读取状态不会触发模型请求。
  provider: z.enum(["qianwen", "codex", "openai-compatible"]),
  model: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
  reasoningEffort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .optional(),
})

export type InformationAISettings = z.infer<typeof informationAISettingsSchema>
export type InformationAISettingsInput = z.infer<typeof informationAISettingsInputSchema>
export type InformationFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const defaultInformationFetcher: InformationFetcher = (input, init) => globalThis.fetch(input, init)

export class InformationLoadError extends Error {
  constructor(public readonly kind: "authorization" | "account_mismatch" | "request" | "invalid") {
    super(kind)
  }
}

export const getOneTimeToken = (generated: unknown) => {
  const tokenSchema = z.object({ token: z.string().min(1) })
  const parsed = z.union([tokenSchema, z.object({ data: tokenSchema })]).safeParse(generated)
  if (!parsed.success) {
    const failure = z.object({ error: z.object({ status: z.number() }) }).safeParse(generated)
    throw new InformationLoadError(
      failure.success && [401, 403].includes(failure.data.error.status)
        ? "authorization"
        : "request",
    )
  }
  return "token" in parsed.data ? parsed.data.token : parsed.data.data.token
}

export async function loadInformationSnapshot(
  generate: () => Promise<unknown>,
  signal: AbortSignal,
  fetcher: InformationFetcher = defaultInformationFetcher,
) {
  // 兼容页读取与原生入口共享本地短时会话，失效时不回退官方凭据。
  const localResponse = await tryLocalInformationRead(
    "/information/api/snapshot",
    "GET",
    signal,
    undefined,
    fetcher,
  ).catch((error: unknown) => {
    throw new InformationLoadError(
      error instanceof LocalInformationReadError ? error.kind : "request",
    )
  })
  const response =
    localResponse ??
    (await (async () => {
      // 只交换主站签发的一次性凭据，不从 localStorage 复制长期 Token。
      const generated = await generate()
      signal.throwIfAborted()
      const token = getOneTimeToken(generated)
      return fetcher("/information/api/snapshot", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Folo-One-Time-Token": token },
        cache: "no-store",
        signal,
      })
    })())
  if (response.status === 401) throw new InformationLoadError("authorization")
  if (response.status === 403) {
    const body = z.object({ error: z.string() }).safeParse(await response.json())
    throw new InformationLoadError(
      body.success && body.data.error === "account_mismatch" ? "account_mismatch" : "request",
    )
  }
  if (!response.ok) throw new InformationLoadError("request")
  const snapshot = informationSnapshotSchema.safeParse(await response.json())
  signal.throwIfAborted()
  if (!snapshot.success) throw new InformationLoadError("invalid")
  return snapshot.data
}

export async function loadInformationAISettings(
  generate: () => Promise<unknown>,
  signal: AbortSignal,
  fetcher: InformationFetcher = defaultInformationFetcher,
): Promise<InformationAISettings> {
  // 兼容页读取与原生入口共享本地短时会话，失效时不回退官方凭据。
  const localResponse = await tryLocalInformationRead(
    "/information/api/settings",
    "GET",
    signal,
    undefined,
    fetcher,
  ).catch((error: unknown) => {
    throw new InformationLoadError(
      error instanceof LocalInformationReadError ? error.kind : "request",
    )
  })
  const response =
    localResponse ??
    (await (async () => {
      const token = getOneTimeToken(await generate())
      signal.throwIfAborted()
      return fetcher("/information/api/settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Folo-One-Time-Token": token },
        cache: "no-store",
        signal,
      })
    })())
  if (!response.ok)
    throw new InformationLoadError(response.status === 401 ? "authorization" : "request")
  const settings = informationAISettingsSchema.safeParse(await response.json())
  if (!settings.success) throw new InformationLoadError("invalid")
  return settings.data
}

export async function saveInformationAISettings(
  input: InformationAISettingsInput,
  generate: () => Promise<unknown>,
  fetcher: InformationFetcher = defaultInformationFetcher,
): Promise<InformationAISettings> {
  // 密钥仅在本次请求序列化后发送，不返回给界面也不写入任何持久化状态。
  const token = getOneTimeToken(await generate())
  const response = await fetcher("/information/api/settings", {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Folo-One-Time-Token": token,
    },
    cache: "no-store",
    body: JSON.stringify(informationAISettingsInputSchema.parse(input)),
  })
  if (!response.ok)
    throw new InformationLoadError(response.status === 401 ? "authorization" : "request")
  const settings = informationAISettingsSchema.safeParse(await response.json())
  if (!settings.success) throw new InformationLoadError("invalid")
  return settings.data
}
