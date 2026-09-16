import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import type { Server } from "node:http"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import { FoloChat } from "./chat"
import { externalApi } from "./external-api"
import { FoloReader } from "./folo"
import { createInformationServer, verifyWebBuild } from "./server"
import { Store } from "./store"
import { WebAuthError } from "./web-auth"

// 使用真实 SQLite 和本机 HTTP，覆盖 Cookie 与静态文件的服务边界。
describe("information HTTP server", () => {
  let directory: string
  let webRoot: string
  let store: Store
  let server: Server
  let port: number
  let aiConfig: AIConfigStore
  let chat: FoloChat
  const authenticate = vi.fn<(token: string) => Promise<void>>()

  const productionHtml =
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>'

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "folo-information-server-"))
    webRoot = join(directory, "web")
    await mkdir(join(webRoot, "assets"), { recursive: true })
    await writeFile(join(webRoot, "index.html"), productionHtml)
    await writeFile(join(webRoot, "assets/app.js"), 'document.title = "Information"')
    await writeFile(join(directory, "private.txt"), "outside-build-secret")
    await symlink(join(directory, "private.txt"), join(webRoot, "linked.txt"))
    store = new Store(":memory:")
    store.bindOwner("test-owner")
    store.replaceSources([
      { key: "feed/1", kind: "feed", id: "1", title: "Test feed", view: 0, category: null },
    ])
    store.saveEntry({
      id: "entry-1",
      sourceKey: "feed/1",
      title: "Article",
      url: "https://example.com/article",
      publishedAt: "2026-09-08T00:00:00Z",
      read: false,
      content: "private-raw-content",
      description: null,
    })
    store.enqueue({ kind: "scan", sourceKey: "feed/1" })
    // 先取得系统分配的空闲端口，再传入服务的 Host 白名单。
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", resolve)
    })
    const address = probe.address()
    if (!address || typeof address === "string") throw new Error("missing_test_port")
    port = address.port
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    )
    authenticate.mockReset().mockImplementation(async (token) => {
      if (token !== "valid-one-time-token") throw new WebAuthError(401, "authorization")
    })
    aiConfig = new AIConfigStore(join(directory, "ai.json"))
    await aiConfig.save({ provider: "qianwen", model: "qwen3.8-flash", apiKey: "private-test-key" })
    chat = new FoloChat({
      store,
      aiConfig,
      runtimeDir: directory,
      reader: async () =>
        new FoloReader({ apiUrl: "https://api.folo.is", token: "unused-test-token" }),
    })
    server = createInformationServer(
      store,
      webRoot,
      port,
      "http://local.folo.is",
      authenticate,
      {
        config: aiConfig,
        chat,
      },
      undefined,
      [externalApi({ store, configPath: join(directory, "integrations.json") })],
    )
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", resolve)
    })
  })

  it("HTTP 同域只读 POST 保留 Origin 和新凭据检查，不能携带写入内容", async () => {
    const headers = { ...signedHeaders, "X-Folo-Read": "1" }
    const result = await request("/information/v1/configuration", { method: "POST", headers })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ revision: 0, releases: [] })
    expect(
      (await request("/information/v1/integrations/settings", { method: "POST", headers })).status,
    ).toBe(200)
    authenticate.mockClear()
    const noOrigin = {
      Host: "local.folo.is",
      "X-Folo-One-Time-Token": "valid-one-time-token",
      "X-Folo-Read": "1",
    }
    for (const origin of [undefined, "http://evil.example"]) {
      expect(
        (
          await request("/information/v1/configuration", {
            method: "POST",
            headers: { ...noOrigin, ...(origin ? { Origin: origin } : {}) },
          })
        ).status,
      ).toBe(403)
    }
    expect(authenticate).not.toHaveBeenCalled()
    expect(
      (
        await request("/information/v1/configuration", {
          method: "POST",
          headers: { ...headers, "X-Folo-One-Time-Token": "expired" },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await request("/information/v1/global-instructions", {
          method: "POST",
          headers,
          body: { expectedRevision: 0, markdown: "不能写入" },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await request("/information/v1/configuration", {
          method: "POST",
          headers: { ...headers, "X-Folo-Read": "PUT" },
        })
      ).status,
    ).toBe(400)
    expect((await request("/information/api/settings", { method: "POST", headers })).status).toBe(
      400,
    )
    expect(store.automation.draft().revision).toBe(0)
  })

  it("外接配置复用主站授权，保存私有密钥后不通过响应泄露", async () => {
    const endpoint = "/information/v1/integrations/settings"
    expect((await request(endpoint, { method: "GET" })).status).toBe(403)
    const saved = await request(endpoint, {
      method: "PUT",
      headers: signedHeaders,
      body: {
        notion: {
          enabled: true,
          token: "private-notion-test-token",
          parentPageId: "11111111-1111-4111-8111-111111111111",
        },
      },
    })
    expect(saved.status).toBe(200)
    expect(saved.body).not.toContain("private-notion-test-token")
    expect(JSON.parse(saved.body)).toMatchObject({ integrations: { notion: { enabled: true } } })
    const read = await request(endpoint, { headers: signedHeaders })
    expect(read.status).toBe(200)
    expect(read.body).not.toContain("token")
    expect(
      (
        await request("/information/v1/exports/not-a-uuid/confirm", {
          method: "POST",
          headers: signedHeaders,
          body: {},
        })
      ).status,
    ).toBe(400)
  })

  it("生产主站和信息工作台同域共存，客户端路由可直接打开", async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    const mainRoot = join(directory, "main-web")
    await mkdir(join(mainRoot, "assets"), { recursive: true })
    await writeFile(join(mainRoot, "index.html"), productionHtml.replace("root", "main-root"))
    await writeFile(join(mainRoot, "assets/main.js"), "export default 'main'")
    server = createInformationServer(
      store,
      webRoot,
      port,
      "http://local.folo.is",
      authenticate,
      undefined,
      mainRoot,
    )
    await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen))
    expect((await request("/")).body).toContain("main-root")
    expect((await request("/action?scope=processing_service")).body).toContain("main-root")
    expect((await request("/information")).body).not.toContain("main-root")
    expect((await request("/assets/main.js")).status).toBe(200)
    expect((await request("/assets/missing.js")).status).toBe(404)
    expect((await request("/information-static/assets/app.js")).body).toContain("Information")
  })

  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    store?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  // 保留原始路径，防止 fetch 在发出请求前规范化 ../ 而掩盖目录穿越。
  function request(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ) {
    return new Promise<{
      status: number
      body: string
      headers: import("node:http").IncomingHttpHeaders
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          headers: options.headers,
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("error", reject)
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              headers: response.headers,
            }),
          )
        },
      )
      req.on("error", reject)
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
    })
  }

  // 每次快照必须有同源请求与主站新凭据，旧本地会话不能独立授权。
  const signedHeaders = {
    Host: "local.folo.is",
    Origin: "http://local.folo.is",
    "X-Folo-One-Time-Token": "valid-one-time-token",
  }
  it("规则接口复用主站授权，草稿冲突与真实原文预览可追踪", async () => {
    // 新接口与摘要/聊天共用账号核验，不能用旧 Cookie 绕过一次性凭据。
    expect(
      (
        await request("/information/v1/configuration", {
          headers: { Host: "local.folo.is", Origin: "http://local.folo.is" },
        })
      ).status,
    ).toBe(401)
    const initial = await request("/information/v1/configuration", { headers: signedHeaders })
    expect(initial.status).toBe(200)
    const browserHeaders = {
      Host: "local.folo.is",
      "Sec-Fetch-Site": "same-origin",
      "X-Folo-One-Time-Token": "valid-one-time-token",
    }
    expect(
      (await request("/information/v1/configuration", { headers: browserHeaders })).status,
    ).toBe(200)
    expect(
      (
        await request("/information/v1/configuration", {
          headers: { ...browserHeaders, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request("/information/v1/global-instructions", {
          method: "PUT",
          headers: browserHeaders,
          body: { expectedRevision: 0, markdown: "缺少 Origin" },
        })
      ).status,
    ).toBe(403)
    expect(JSON.parse(initial.body)).toMatchObject({
      revision: 0,
      config: { ownerId: "test-owner" },
      releases: [],
    })
    const rule = {
      name: "尚未同步的标签",
      enabled: true,
      executionLocation: "processing_service",
      when: {
        anyOf: [{ allOf: [{ field: "visible_length", operator: "lt", value: 50 }] }],
      },
      actions: [{ type: "ai_transform", prompt: "合并同一事件" }],
    }
    expect(
      (
        await request("/information/v1/rules", {
          method: "POST",
          headers: signedHeaders,
          body: { expectedRevision: 0, rule },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await request("/information/v1/global-instructions", {
          method: "PUT",
          headers: signedHeaders,
          body: { expectedRevision: 0, markdown: "过期编辑" },
        })
      ).status,
    ).toBe(409)
    const preview = await request("/information/v1/rules/preview", {
      method: "POST",
      headers: signedHeaders,
      body: { sourceKey: "feed/1", entryId: "entry-1" },
    })
    expect(preview.status).toBe(200)
    expect(JSON.parse(preview.body)).toMatchObject({
      input: { entry_content: "private-raw-content", read: false },
      matches: [{ state: "unknown" }],
      blocksFinalPresentation: true,
    })
    const malformed = { ...rule, when: { anyOf: [] } }
    expect(
      (
        await request("/information/v1/rules", {
          method: "POST",
          headers: signedHeaders,
          body: { expectedRevision: 1, rule: malformed },
        })
      ).status,
    ).toBe(400)
    expect(store.automation.draft().revision).toBe(1)
    const inputs = await request("/information/v1/inputs", { headers: signedHeaders })
    expect(inputs.status).toBe(200)
    expect(inputs.body).not.toContain("private-raw-content")
    expect(store.automation.releases()).toEqual([])
    // 真实服务故障必须报告失败，不能返回空配置或泄漏 SQL 细节。
    vi.spyOn(store.automation, "draft").mockImplementationOnce(() => {
      throw new Error("private SQLite failure")
    })
    const failure = await request("/information/v1/configuration", { headers: signedHeaders })
    expect(failure.status).toBe(500)
    expect(JSON.parse(failure.body)).toEqual({ error: "internal_error" })
  })

  it("设置读写要求主站身份，返回模型但不回显密钥", async () => {
    expect(
      (
        await request("/information/api/settings", {
          method: "POST",
          headers: { Host: "local.folo.is", Origin: "http://local.folo.is" },
        })
      ).status,
    ).toBe(401)
    const saved = await request("/information/api/settings", {
      method: "PUT",
      headers: signedHeaders,
      body: { provider: "qianwen", model: "qwen-new", apiKey: "" },
    })
    expect(saved.status).toBe(200)
    expect(JSON.parse(saved.body)).toEqual({
      provider: "qianwen",
      model: "qwen-new",
      hasApiKey: true,
    })
    expect(saved.body).not.toContain("private-test-key")
    expect(await aiConfig.execution()).toEqual({ apiKey: "private-test-key" })
  })

  it("聊天以 UIMessage SSE 返回正文，失败信息不泄漏上游内容", async () => {
    const run = vi
      .spyOn(chat, "run")
      .mockResolvedValue({ answer: "模型回复", model: "qwen3.8-flash", title: "Test" })
    const result = await request("/information/api/chat", {
      method: "POST",
      headers: signedHeaders,
      body: { messages: [] },
    })
    expect(result.headers["x-vercel-ai-ui-message-stream"]).toBe("v1")
    const events = result.body
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)))
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "data-generated-title",
      "finish-step",
      "finish",
    ])
    expect(events[3].delta).toBe("模型回复")
    expect(result.body).toContain("data: [DONE]")
    run.mockRejectedValue(new Error("secret-upstream-body"))
    const failed = await request("/information/api/chat", {
      method: "POST",
      headers: signedHeaders,
      body: {},
    })
    expect(failed.body).toContain("internal_error")
    expect(failed.body).not.toContain("secret-upstream-body")
  })

  it("浏览器断开 SSE 会取消模型执行", async () => {
    let resolveAbort: () => void
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve
    })
    vi.spyOn(chat, "run").mockImplementation(async (_input, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolveAbort()
            resolve()
          },
          { once: true },
        )
      })
      throw new Error("cancelled")
    })
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/information/api/chat",
        method: "POST",
        headers: signedHeaders,
      },
      (res) => {
        res.once("data", () => res.destroy())
      },
    )
    req.end("{}")
    await aborted
  })
  it("主站凭据核验后返回快照，不泄露凭据和原始正文", async () => {
    const result = await request("/information/api/snapshot", {
      method: "POST",
      headers: signedHeaders,
    })
    expect(result.status).toBe(200)
    expect(authenticate).toHaveBeenCalledWith("valid-one-time-token")
    expect(JSON.parse(result.body)).toMatchObject({
      ownerId: "test-owner",
      items: [{ id: "entry-1" }],
    })
    expect(result.body).not.toMatch(/valid-one-time-token|private-raw-content/)
    expect(result.headers["cache-control"]).toBe("no-store")
    expect(result.headers["set-cookie"]).toBeUndefined()
  })

  it.each([undefined, "http://evil.example", "null"])(
    "缺失或跨域 Origin 不交换凭据：%s",
    async (origin) => {
      const headers: Record<string, string> = {
        Host: "local.folo.is",
        "X-Folo-One-Time-Token": "valid-one-time-token",
      }
      if (origin) headers.Origin = origin
      expect((await request("/information/api/snapshot", { method: "POST", headers })).status).toBe(
        403,
      )
      expect(authenticate).not.toHaveBeenCalled()
    },
  )

  it("拒绝未登录、过期凭据以及旧 Cookie", async () => {
    const headers = {
      Host: "local.folo.is",
      Origin: "http://local.folo.is",
      Cookie: `folo_information=${store.issueAccess("session")}`,
    }
    expect((await request("/information/api/snapshot", { method: "POST", headers })).status).toBe(
      401,
    )
    expect(
      (
        await request("/information/api/snapshot", {
          method: "POST",
          headers: { ...headers, "X-Folo-One-Time-Token": "expired" },
        })
      ).status,
    ).toBe(401)
    expect((await request("/information/api/snapshot", { headers })).status).toBe(405)
    expect((await request("/information/connect?code=old")).status).toBe(410)
  })

  it("账号不符时不返回原账号数据", async () => {
    authenticate.mockRejectedValueOnce(new WebAuthError(403, "account_mismatch"))
    const result = await request("/information/api/snapshot", {
      method: "POST",
      headers: signedHeaders,
    })
    expect(result.status).toBe(403)
    expect(result.body).toBe(JSON.stringify({ error: "account_mismatch" }))
    expect(result.body).not.toContain("test-owner")
  })

  it("跨站 Host、HEAD 和超长凭据不触发授权交换", async () => {
    expect(
      (
        await request("/information/api/snapshot", {
          method: "POST",
          headers: { ...signedHeaders, Host: "evil.example" },
        })
      ).status,
    ).toBe(403)
    expect(
      (await request("/information/api/snapshot", { method: "HEAD", headers: signedHeaders }))
        .status,
    ).toBe(405)
    expect(
      (
        await request("/information/api/snapshot", {
          method: "POST",
          headers: { ...signedHeaders, "X-Folo-One-Time-Token": "x".repeat(4097) },
        })
      ).status,
    ).toBe(401)
    expect(authenticate).not.toHaveBeenCalled()
  })

  it("serves production assets below the information prefix without escaping the build", async () => {
    expect(
      (await request("/information-static/assets/app.js", { headers: { Host: "local.folo.is" } }))
        .body,
    ).toContain("Information")
    const response = await request("/information-static/linked.txt", {
      headers: { Host: "local.folo.is" },
    })
    expect(response.status).toBe(404)
    expect(response.body).not.toContain("outside-build-secret")
  })

  it.each([
    "/../private.txt",
    "/%2e%2e%2fprivate.txt",
    "/assets/%2e%2e%2f%2e%2e%2fprivate.txt",
    "/linked.txt",
    "/%ZZ",
  ])("rejects unsafe static path %s", async (path) => {
    const response = await request(path)
    expect(response.status).toBe(404)
    expect(response.body).not.toContain("outside-build-secret")
  })

  it("serves production HTML and assets with correct GET and HEAD behavior", async () => {
    await expect(verifyWebBuild(webRoot)).resolves.toBeUndefined()
    const response = await request("/information")
    expect(response.status).toBe(200)
    expect(response.body).toBe(productionHtml)
    expect(response.body).not.toContain("/@vite/client")
    expect(response.headers["content-type"]).toContain("text/html")
    expect((await request("/assets/app.js")).headers["content-type"]).toContain("javascript")
    const head = await request("/information", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(head.body).toBe("")
    expect((await request("/information", { method: "POST" })).status).toBe(405)
    expect((await request("/information/api/missing")).status).toBe(404)
    expect((await request("/")).headers.location).toBe("/information")
  })

  it("rejects a development HTML entry or missing module entry", async () => {
    await writeFile(join(webRoot, "index.html"), '<script src="/@vite/client"></script>')
    await expect(verifyWebBuild(webRoot)).rejects.toThrow("production_web_build_required")
    await writeFile(join(webRoot, "index.html"), "<html>Empty</html>")
    await expect(verifyWebBuild(webRoot)).rejects.toThrow("production_web_build_required")
  })
})
