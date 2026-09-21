import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"

import { extname, join, resolve, sep } from "pathe"
import { ZodError } from "zod"

import type { AIConfigStore } from "./ai-config"
import { AIConfigError } from "./ai-config"
import { automationApi } from "./automation-api"
import { AutomationError } from "./automation-store"
import type { FoloChat } from "./chat"
import { ChatInputError } from "./chat"
import { ExportStoreError } from "./export-store"
import { ExternalApiError } from "./external-api"
import { ExternalConfigError } from "./external-config"
import { NotionExportError } from "./notion-export"
import { ProcessingFeedbackError } from "./processing-feedback"
import { ProcessingReadingError } from "./processing-reading-store"
import { ProcessingScheduleError } from "./processing-schedule"
import type { ProcessingTrial } from "./processing-trial"
import { ProcessingTrialError } from "./processing-trial"
import { errorCode } from "./service"
import type { Store } from "./store"
import { StoryStoreError } from "./story-store"
import { SubscriptionTagError } from "./subscription-tags"
import { WebAuthError } from "./web-auth"
import { XConfigError } from "./x-config"
import { XQueryError } from "./x-query-store"

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
}

function json(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  response.end(JSON.stringify(body))
}

export function createInformationServer(
  store: Store,
  webRoot: string,
  port: number,
  publicOrigin: string,
  authenticate: (token: string) => Promise<void>,
  ai?: { config: AIConfigStore; chat: FoloChat; signal?: AbortSignal; trial?: ProcessingTrial },
  mainWebRoot?: string,
  externalHandlers: Array<{
    handle(method: string, path: string, body: unknown): Promise<object | undefined>
  }> = [],
) {
  const publicUrl = new URL(publicOrigin)
  // 只接受配置的站点与本机诊断地址，不放宽为任意 Host 或跨域请求。
  const hosts = new Set([publicUrl.host, `127.0.0.1:${port}`, `localhost:${port}`])
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!hosts.has(request.headers.host ?? ""))
      return json(response, 403, { error: "invalid_host" })
    const origin =
      request.headers.host === publicUrl.host ? publicUrl.origin : `http://${request.headers.host}`
    if (request.headers.origin && request.headers.origin !== origin)
      return json(response, 403, { error: "invalid_origin" })
    const url = new URL(request.url ?? "/", origin)
    response.setHeader("X-Content-Type-Options", "nosniff")
    response.setHeader("Referrer-Policy", "no-referrer")
    if (url.pathname === "/information/connect") {
      // 旧的本地连接票据不再授予数据访问权，已有主站登录即可打开页面。
      return json(response, 410, { error: "use_folo_login" })
    }
    const automation = url.pathname.startsWith("/information/v1/")
    const readHeader = request.headers["x-folo-read"]
    // HTTP 站点的浏览器 GET 缺少 Origin/Fetch Metadata；使用带 Origin 的空 POST 承载只读操作。
    // 该标记只选择 GET 分支，不能绕过下方账号核验或变成任意方法覆盖。
    const readPost = automation && request.method === "POST" && readHeader === "1"
    if (
      readHeader !== undefined &&
      (!readPost ||
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0"))
    )
      return json(response, 400, { error: "invalid_read_request" })
    if (
      automation ||
      ["snapshot", "settings", "chat"].some((name) => url.pathname === `/information/api/${name}`)
    ) {
      const settings = url.pathname.endsWith("/settings")
      if (
        automation
          ? !["GET", "POST", "PUT", "DELETE"].includes(request.method ?? "")
          : request.method !== "POST" && !(settings && request.method === "PUT")
      )
        return json(response, 405, { error: "method_not_allowed" })
      // 每次读取都核验主站新生成的一次性凭据，旧本地 Cookie 不能绕过退出或切换账号。
      // 浏览器的同源 GET 不发送 Origin，改用浏览器生成的 Fetch Metadata；写操作仍要求 Origin。
      const sameOriginRead =
        request.method === "GET" &&
        !request.headers.origin &&
        request.headers["sec-fetch-site"] === "same-origin"
      if (request.headers.origin !== origin && !sameOriginRead)
        return json(response, 403, { error: "invalid_origin" })
      const token = request.headers["x-folo-one-time-token"]
      if (typeof token !== "string" || !token || token.length > 4096) {
        return json(response, 401, { error: "authorization" })
      }
      try {
        await authenticate(token)
      } catch (error) {
        return error instanceof WebAuthError
          ? json(response, error.status, { error: error.code })
          : json(response, 502, { error: "upstream" })
      }
      if (automation) {
        try {
          const method = readPost ? "GET" : request.method!
          const body = method === "GET" ? undefined : await readJson(request, 1024 * 1024)
          // 外接服务复用同一登录与同源校验，只有对应的显式操作才触发网络请求。
          const path = url.pathname.slice("/information/v1".length)
          if (path === "/rules/trial" && method === "POST") {
            if (!ai?.trial) return json(response, 503, { error: "ai_not_configured" })
            const controller = new AbortController()
            const abort = () => controller.abort()
            response.once("close", abort)
            ai.signal?.addEventListener("abort", abort, { once: true })
            if (ai.signal?.aborted) abort()
            try {
              return json(response, 200, await ai.trial.run(body, controller.signal))
            } finally {
              response.removeListener("close", abort)
              ai.signal?.removeEventListener("abort", abort)
            }
          }
          for (const handler of externalHandlers) {
            const result = await handler.handle(method, path, body)
            if (result !== undefined) return json(response, 200, result)
          }
          return json(response, 200, automationApi(store, method, path, body))
        } catch (error) {
          if (error instanceof ProcessingTrialError)
            return json(
              response,
              error.code === "stale_target" || error.code === "trial_busy" ? 409 : 400,
              { error: error.code },
            )
          if (error instanceof ProcessingFeedbackError || error instanceof ProcessingReadingError)
            return json(response, error.code === "stale_target" ? 409 : 400, { error: error.code })
          if (error instanceof XConfigError || error instanceof XQueryError)
            return json(response, error.code === "not_found" ? 404 : 400, { error: error.code })
          if (
            error instanceof ExternalApiError ||
            error instanceof ExternalConfigError ||
            error instanceof ExportStoreError ||
            error instanceof NotionExportError
          )
            return json(response, error.code === "export_not_found" ? 404 : 400, {
              error: error.code,
            })
          if (error instanceof ProcessingScheduleError || error instanceof StoryStoreError)
            return json(response, error.code === "revision_conflict" ? 409 : 400, {
              error: error.code,
            })
          if (error instanceof SubscriptionTagError)
            return json(
              response,
              error.code === "revision_conflict" || error.code === "tag_referenced" ? 409 : 400,
              { error: error.code, ruleIds: error.ruleIds },
            )
          // 数据库等内部故障不能伪装成用户填错参数，也不返回底层错误正文。
          if (
            !(error instanceof AutomationError) &&
            !(error instanceof ZodError) &&
            !(error instanceof SyntaxError) &&
            !(error instanceof Error && error.message === "request_too_large")
          )
            return json(response, 500, { error: "internal_error" })
          const status =
            error instanceof AutomationError && error.code === "revision_conflict"
              ? 409
              : error instanceof AutomationError && error.code === "invalid_target"
                ? 404
                : 400
          return json(response, status, {
            error: error instanceof AutomationError ? error.code : "invalid_request",
          })
        }
      }
      if (url.pathname.endsWith("/snapshot")) return json(response, 200, store.snapshot())
      if (!ai) return json(response, 503, { error: "ai_not_configured" })
      try {
        if (settings) {
          const result =
            request.method === "PUT"
              ? await ai.config.save(await readJson(request, 8192))
              : await ai.config.publicSettings()
          return json(response, 200, result)
        }
        const body = await readJson(request, 1024 * 1024)
        const controller = new AbortController()
        const abort = () => controller.abort()
        response.once("close", abort)
        ai.signal?.addEventListener("abort", abort, { once: true })
        if (ai.signal?.aborted || response.destroyed) abort()
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Vercel-AI-UI-Message-Stream": "v1",
          "X-Accel-Buffering": "no",
        })
        const emit = (event: object) => {
          if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        // CLI 校验最终 JSON 后再发送正文；开始事件保留等待状态，断开连接会取消 CLI。
        const messageId = randomUUID()
        emit({ type: "start", messageId })
        emit({ type: "start-step" })
        const heartbeat = setInterval(() => {
          if (!response.destroyed) response.write(": waiting\n\n")
        }, 15000)
        try {
          const answer = await ai.chat.run(body, controller.signal)
          emit({ type: "text-start", id: messageId })
          emit({ type: "text-delta", id: messageId, delta: answer.answer })
          emit({ type: "text-end", id: messageId })
          emit({ type: "data-generated-title", data: answer.title })
          emit({ type: "finish-step" })
          emit({ type: "finish", finishReason: "stop", messageMetadata: { model: answer.model } })
        } catch (error) {
          // 上游日志与原始错误不进入 SSE，避免携带文章或认证内容。
          emit({
            type: "error",
            errorText: error instanceof ChatInputError ? error.code : errorCode(error),
          })
        } finally {
          clearInterval(heartbeat)
          response.removeListener("close", abort)
          ai.signal?.removeEventListener("abort", abort)
          if (!response.destroyed) response.end("data: [DONE]\n\n")
        }
        return
      } catch (error) {
        return json(response, 400, {
          error: error instanceof AIConfigError ? error.code : "invalid_request",
        })
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return json(response, 405, { error: "method_not_allowed" })
    if (url.pathname.startsWith("/information/api/"))
      return json(response, 404, { error: "not_found" })
    if (url.pathname === "/" && !mainWebRoot) {
      response.writeHead(302, { Location: "/information" })
      response.end()
      return
    }
    const informationPage =
      ["/information", "/information/"].includes(url.pathname) ||
      url.pathname.startsWith("/information-static/")
    const root = await realpath(!informationPage && mainWebRoot ? mainWebRoot : webRoot)
    // 独立资源前缀使生产页面与主站现有资源共存于同一个域名。
    const staticPath = url.pathname.startsWith("/information-static/")
      ? url.pathname.slice("/information-static/".length)
      : url.pathname
    const relative = ["/information", "/information/"].includes(url.pathname)
      ? "index.html"
      : decodeURIComponent(staticPath).replace(/^\/+/, "")
    let file: string
    try {
      file = await realpath(resolve(root, relative))
    } catch (error) {
      // 主站的客户端路由回到生产入口，缺失的静态资源仍保持 404。
      if (
        !informationPage &&
        mainWebRoot &&
        !extname(relative) &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
        file = await realpath(join(root, "index.html"))
      else throw error
    }
    if (!informationPage && mainWebRoot && relative === "")
      file = await realpath(join(root, "index.html"))
    // 静态路径和符号链接都必须留在生产构建目录内。
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile())
      return json(response, 404, { error: "not_found" })
    response.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    })
    if (request.method === "HEAD") response.end()
    else createReadStream(file).pipe(response)
  }
  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 404, { error: "not_found_or_web_build_missing" })
      else response.end()
    })
  })
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  // 设置和聊天都限制请求大小，超限时不把未校验正文交给 CLI。
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new Error("request_too_large")
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export async function verifyWebBuild(webRoot: string) {
  const index = await readFile(join(webRoot, "index.html"), "utf8")
  if (index.includes("/@vite/client") || !index.includes("<script"))
    throw new Error("production_web_build_required")
}
