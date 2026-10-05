import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { StringDecoder } from "node:string_decoder"

import { join } from "pathe"
import { z } from "zod"

import { resolveCodexCommand } from "./codex-command"

const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_MODELS = 100
const TIMEOUT_MS = 8_000
const text = z.string().max(2000)
const identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\w./:-]+$/u)
const rpcModelSchema = z.object({
  id: identifier,
  model: identifier.optional(),
  displayName: text,
  description: text.optional(),
  hidden: z.boolean().optional(),
  inputModalities: z.array(text).max(10).optional(),
  defaultReasoningEffort: text.nullable().optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: text })).max(20),
})
const cacheModelSchema = z.object({
  slug: identifier,
  display_name: text,
  description: text.optional(),
  visibility: z.string(),
  supported_in_api: z.boolean().optional(),
  input_modalities: z.array(text).max(10).optional(),
  default_reasoning_level: text.nullable().optional(),
  supported_reasoning_levels: z.array(z.object({ effort: text })).max(20),
})
export type PublicModel = {
  id: string
  displayName: string
  description: string
  reasoningEfforts: string[]
  defaultReasoningEffort: string | null
}
export type ModelCatalog = {
  models: PublicModel[]
  source: "rpc" | "cache"
  fetchedAt: string | null
  stale: boolean
  available: boolean
  error?: string
}
class CatalogError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

// 只映射模型选择需要的字段；RPC/缓存里的身份、能力提示和其他原始字段从不回传。
function rpcModels(value: unknown): PublicModel[] {
  const parsed = z
    .object({
      data: z.array(rpcModelSchema).max(MAX_MODELS),
      nextCursor: z.string().nullable().optional(),
    })
    .safeParse(value)
  if (!parsed.success || parsed.data.nextCursor) throw new CatalogError("model_catalog_invalid")
  return parsed.data.data
    .filter(
      (model) =>
        !model.hidden && (!model.inputModalities || model.inputModalities.includes("text")),
    )
    .map((model) => ({
      id: model.model ?? model.id,
      displayName: model.displayName,
      description: model.description ?? "",
      reasoningEfforts: [
        ...new Set(model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)),
      ],
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    }))
}

async function readRpcModels(options: {
  command?: string
  timeoutMs?: number
  signal?: AbortSignal
}) {
  const temporary = await mkdtemp(join(tmpdir(), "folo-model-catalog-"))
  try {
    // 独立 HOME 不加载全局自定义 provider/catalog/auth；model/list 可读取 CLI 内置支持目录。
    // 只初始化和列模型，不创建 thread/turn，也不触发推理、登录或用户配置变更。
    const env: NodeJS.ProcessEnv = { CODEX_HOME: temporary, NO_COLOR: "1" }
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot"])
      if (process.env[key]) env[key] = process.env[key]
    return await new Promise<PublicModel[]>((resolve, reject) => {
      const child = spawn(
        options.command ?? resolveCodexCommand(),
        ["app-server", "--listen", "stdio://"],
        {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      let settled = false
      let bytes = 0
      let pending = ""
      const decoder = new StringDecoder("utf8")
      let initialized = false
      const finish = (error?: CatalogError, models?: PublicModel[]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
        const complete = () => {
          if (error) reject(error)
          else resolve(models ?? [])
        }
        // 进程确实退出后才删除独立 HOME，避免残留并发写入的临时状态文件。
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
          complete()
        else {
          child.once("exit", complete)
          child.kill("SIGKILL")
        }
        child.stdin.destroy()
      }
      const abort = () => finish(new CatalogError("model_catalog_aborted"))
      const timer = setTimeout(
        () => finish(new CatalogError("model_catalog_timeout")),
        options.timeoutMs ?? TIMEOUT_MS,
      )
      options.signal?.addEventListener("abort", abort, { once: true })
      child.on("error", () => finish(new CatalogError("model_catalog_unavailable")))
      child.on("exit", () => finish(new CatalogError("model_catalog_unavailable")))
      child.stdin.on("error", () => finish(new CatalogError("model_catalog_unavailable")))
      // 原始 stderr 可能带进程环境信息，不保存/回传；同样计入有界输出预算。
      const accountBytes = (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > MAX_CATALOG_BYTES) finish(new CatalogError("model_catalog_output_limit"))
      }
      child.stderr.on("data", accountBytes)
      child.stdout.on("data", (chunk: Buffer) => {
        accountBytes(chunk)
        if (settled) return
        pending += decoder.write(chunk)
        for (;;) {
          const end = pending.indexOf("\n")
          if (end < 0) break
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          if (!line.trim()) continue
          let message: { id?: number; result?: unknown; error?: unknown }
          try {
            message = JSON.parse(line)
          } catch {
            finish(new CatalogError("model_catalog_invalid"))
            return
          }
          if (!message || typeof message !== "object") {
            finish(new CatalogError("model_catalog_invalid"))
            return
          }
          if (message.id === 1 && !initialized) {
            if (message.error || message.result === undefined) {
              finish(new CatalogError("model_catalog_unavailable"))
              return
            }
            initialized = true
            child.stdin.write(
              `${JSON.stringify({ method: "initialized", params: {} })}\n${JSON.stringify({ id: 2, method: "model/list", params: { limit: MAX_MODELS, includeHidden: false } })}\n`,
            )
          } else if (message.id === 2 && initialized) {
            try {
              if (message.error) throw new CatalogError("model_catalog_unavailable")
              finish(undefined, rpcModels(message.result))
            } catch (error) {
              finish(
                error instanceof CatalogError ? error : new CatalogError("model_catalog_invalid"),
              )
            }
            return
          }
        }
      })
      if (options.signal?.aborted) {
        abort()
        return
      }
      child.stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "folo_model_catalog", version: "1" }, capabilities: {} } })}\n`,
      )
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function readModelCatalog(
  options: { command?: string; cachePath?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ModelCatalog> {
  let error: string
  try {
    const models = await readRpcModels(options)
    return {
      models,
      source: "rpc",
      fetchedAt: new Date().toISOString(),
      stale: false,
      available: models.length > 0,
    }
  } catch (failure) {
    error = failure instanceof CatalogError ? failure.code : "model_catalog_unavailable"
  }
  try {
    const path =
      options.cachePath ??
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json")
    const bytes = await readFile(path)
    if (bytes.byteLength > MAX_CATALOG_BYTES) throw new CatalogError("model_catalog_output_limit")
    const cache = z
      .object({
        fetched_at: z.iso.datetime({ offset: true }).optional(),
        models: z.array(cacheModelSchema).max(MAX_MODELS),
      })
      .parse(JSON.parse(bytes.toString("utf8")))
    const models = cache.models
      .filter(
        (model) =>
          model.visibility === "list" &&
          model.supported_in_api !== false &&
          (!model.input_modalities || model.input_modalities.includes("text")),
      )
      .map((model) => ({
        id: model.slug,
        displayName: model.display_name,
        description: model.description ?? "",
        reasoningEfforts: [
          ...new Set(model.supported_reasoning_levels.map((effort) => effort.effort)),
        ],
        defaultReasoningEffort: model.default_reasoning_level ?? null,
      }))
    return {
      models,
      source: "cache",
      fetchedAt: cache.fetched_at ?? null,
      stale: true,
      available: models.length > 0,
      error,
    }
  } catch {
    return { models: [], source: "cache", fetchedAt: null, stale: true, available: false, error }
  }
}
