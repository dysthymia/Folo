import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"

import { dirname } from "pathe"
import { z } from "zod"

const fields = {
  provider: z.enum(["qianwen", "codex"]),
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\w./:-]+$/),
  apiKey: z.string().trim().max(4096).optional(),
}
const configSchema = z.object(fields).strict()
export type AIConfig = z.infer<typeof configSchema>

export class AIConfigError extends Error {
  constructor(public readonly code: "invalid_ai_config" | "ai_key_required") {
    // 配置错误不携带输入值，防止密钥经错误信息回传。
    super(code)
  }
}

export class AIConfigStore {
  constructor(private readonly path: string) {}

  async read(): Promise<AIConfig> {
    try {
      return configSchema.parse(JSON.parse(await readFile(this.path, "utf8")))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { provider: "qianwen", model: "qwen3.8-flash" }
      throw new AIConfigError("invalid_ai_config")
    }
  }

  async publicSettings() {
    const { provider, model, apiKey } = await this.read()
    return { provider, model, hasApiKey: Boolean(apiKey) }
  }

  async save(input: unknown) {
    const parsed = configSchema.safeParse(input)
    if (!parsed.success) throw new AIConfigError("invalid_ai_config")
    const previous = await this.read()
    const config = { ...parsed.data, apiKey: parsed.data.apiKey || previous.apiKey }
    if (config.provider === "qianwen" && !config.apiKey) throw new AIConfigError("ai_key_required")
    // 空密码保留已有密钥；原子替换私有文件，浏览器只能获取密钥是否存在。
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(config), { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
    return { provider: config.provider, model: config.model, hasApiKey: Boolean(config.apiKey) }
  }

  async execution(provider?: AIConfig["provider"]) {
    const config = await this.read()
    if ((provider ?? config.provider) === "codex") return undefined
    if (!config.apiKey) throw new AIConfigError("ai_key_required")
    return { apiKey: config.apiKey }
  }
}
