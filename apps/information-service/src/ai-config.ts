import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"

import { dirname } from "pathe"
import { z } from "zod"

import { reasoningEffortSchema } from "./ai-reasoning"
import { readModelCatalog } from "./model-catalog"

export const QIANWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
export const aiProviderSchema = z.enum(["qianwen", "codex", "openai-compatible"])
export type AIProvider = z.infer<typeof aiProviderSchema>

// 只接收 Chat Completions 根地址，保留路径前缀，禁止凭据和参数混入公开设置。
export function normalizeAIBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("invalid")
    return url.toString().replace(/\/+$/u, "")
  } catch {
    throw new AIConfigError("invalid_ai_config")
  }
}
const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, context) => {
    try {
      return normalizeAIBaseUrl(value)
    } catch {
      context.addIssue({ code: "custom", message: "invalid_base_url" })
      return z.NEVER
    }
  })
const fields = {
  provider: aiProviderSchema,
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\w./:-]+$/),
  apiKey: z.string().trim().max(4096).optional(),
  baseUrl: baseUrlSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
}
const inputSchema = z
  .object(fields)
  .strict()
  .refine((input) => input.provider !== "openai-compatible" || Boolean(input.baseUrl))
// 私有文件记录密钥绑定端点；不接受浏览器伪造绑定信息，也不返回密钥及该内部字段。
const configSchema = z
  .object({ ...fields, apiKeyBaseUrl: baseUrlSchema.optional() })
  .strict()
  .refine((input) => input.provider !== "openai-compatible" || Boolean(input.baseUrl))
export type AIConfig = z.infer<typeof configSchema>
export type AIChatExecution = {
  apiKey: string
  baseUrl?: string
  provider?: Exclude<AIProvider, "codex">
}
export function aiEndpoint(config: Pick<AIConfig, "provider" | "baseUrl">) {
  return config.provider === "codex"
    ? undefined
    : config.provider === "qianwen"
      ? QIANWEN_BASE_URL
      : config.baseUrl
}
// 端点身份参与所有新模型缓存，密钥变化不进入公开快照或缓存指纹。
export function aiEndpointFingerprint(config: Pick<AIConfig, "provider" | "baseUrl">) {
  const endpoint = config.provider === "openai-compatible" ? config.baseUrl : undefined
  return endpoint ? createHash("sha256").update(endpoint).digest("hex") : undefined
}

export class AIConfigError extends Error {
  constructor(
    public readonly code:
      | "invalid_ai_config"
      | "ai_key_required"
      | "ai_config_changed"
      | "unsupported_reasoning_effort"
      | "model_catalog_unavailable",
  ) {
    // 配置错误不携带输入值，防止密钥经错误信息回传。
    super(code)
  }
}

export class AIConfigStore {
  constructor(
    private readonly path: string,
    private readonly modelCatalog = readModelCatalog,
  ) {}

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
    return this.publicView(await this.read())
  }

  private credentialEndpoint(config: AIConfig) {
    // 旧千问配置按固定 DashScope 解释；旧 Codex 配置里的保留密钥也只属于千问。
    return (
      config.apiKeyBaseUrl ??
      (config.provider === "openai-compatible" ? config.baseUrl : QIANWEN_BASE_URL)
    )
  }

  private publicView(config: AIConfig) {
    const endpoint = aiEndpoint(config)
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(config.provider === "openai-compatible" ? { baseUrl: config.baseUrl } : {}),
      hasApiKey: Boolean(
        config.apiKey && (endpoint === undefined || this.credentialEndpoint(config) === endpoint),
      ),
    }
  }

  async save(input: unknown) {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) throw new AIConfigError("invalid_ai_config")
    if (parsed.data.reasoningEffort !== undefined) {
      // 只对明确选择的强度查询动态能力；旧配置不自动采用目录里的默认强度。
      if (parsed.data.provider !== "codex") throw new AIConfigError("unsupported_reasoning_effort")
      const catalog = await this.modelCatalog()
      if (!catalog.available) throw new AIConfigError("model_catalog_unavailable")
      const model = catalog.models.find((model) => model.id === parsed.data.model)
      if (!model?.reasoningEfforts.includes(parsed.data.reasoningEffort))
        throw new AIConfigError("unsupported_reasoning_effort")
    }
    const previous = await this.read()
    const endpoint = aiEndpoint(parsed.data)
    const previousEndpoint = this.credentialEndpoint(previous)
    // 地址改变必须重新提供密钥；仅切到 Codex 时保留已有绑定，切回同端点才能继续使用。
    const apiKey =
      parsed.data.apiKey ||
      (endpoint === undefined || endpoint === previousEndpoint ? previous.apiKey : undefined)
    if (parsed.data.provider !== "codex" && !apiKey) throw new AIConfigError("ai_key_required")
    const config: AIConfig = {
      ...parsed.data,
      apiKey,
      ...(apiKey ? { apiKeyBaseUrl: endpoint ?? previousEndpoint } : {}),
    }
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
    return this.publicView(config)
  }

  async execution(
    snapshot?: AIConfig | AIProvider,
    expectedBaseUrl?: string,
    expectedModel?: string,
  ): Promise<AIChatExecution | undefined> {
    // 当前流程直接传 read() 的私有快照，模型、端点和密钥在同一次读取中绑定。
    const config = typeof snapshot === "object" ? snapshot : await this.read()
    const requested = typeof snapshot === "string" ? snapshot : config.provider
    if (requested === "codex") return undefined
    const endpoint =
      requested === "qianwen"
        ? QIANWEN_BASE_URL
        : typeof snapshot === "string"
          ? expectedBaseUrl
          : config.baseUrl
    // 固定的后台任务只在当前配置仍对应同一提供商/模型/端点时取密钥，否则明确拒绝。
    if (
      typeof snapshot === "string" &&
      (requested !== config.provider ||
        (expectedModel !== undefined && expectedModel !== config.model) ||
        !endpoint ||
        endpoint !== aiEndpoint(config))
    )
      throw new AIConfigError("ai_config_changed")
    if (
      !endpoint ||
      !config.apiKey ||
      this.credentialEndpoint(config) !== normalizeAIBaseUrl(endpoint)
    )
      throw new AIConfigError("ai_key_required")
    return requested === "qianwen"
      ? { apiKey: config.apiKey }
      : { apiKey: config.apiKey, baseUrl: endpoint, provider: requested }
  }
}
