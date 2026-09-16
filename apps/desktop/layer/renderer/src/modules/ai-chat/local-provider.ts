import { z } from "zod"

import { oneTimeToken } from "~/lib/auth"

const localAISettingsSchema = z.object({
  provider: z.enum(["qianwen", "codex"]),
  model: z.string().min(1),
  hasApiKey: z.boolean(),
})

const oneTimeTokenSchema = z.union([
  z.object({ token: z.string().min(1) }),
  z.object({ data: z.object({ token: z.string().min(1) }) }),
])

export type LocalAISettings = z.infer<typeof localAISettingsSchema>

export const isLocalFoloHost = (hostname = window.location.hostname) => hostname === "local.folo.is"

export const getOneTimeTokenFromResult = (result: unknown) => {
  const parsed = oneTimeTokenSchema.parse(result)
  return "token" in parsed ? parsed.token : parsed.data.token
}

export const getOneTimeToken = async () => {
  // 仅使用主站签发的一次性凭据，避免将长期登录信息交给本地服务。
  return getOneTimeTokenFromResult(await oneTimeToken.generate())
}

export const requestLocalAISettings = async (
  generate = getOneTimeToken,
  fetcher = fetch,
): Promise<LocalAISettings> => {
  const token = await generate()
  const response = await fetcher("/information/api/settings", {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Folo-One-Time-Token": token },
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error(`Failed to load local AI settings: ${response.status}`)
  }

  return localAISettingsSchema.parse(await response.json())
}

export const loadLocalAISettings = () => requestLocalAISettings()
