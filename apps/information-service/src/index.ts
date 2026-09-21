import { execFile } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { setTimeout } from "node:timers/promises"
import { parseArgs } from "node:util"

import { join, resolve } from "pathe"

import { AIConfigStore } from "./ai-config"
import { FoloChat } from "./chat"
import { xPostId } from "./content-identity"
import { externalApi } from "./external-api"
import { FoloReader } from "./folo"
import { diagnosticsApi } from "./processing-diagnostics"
import { ProcessingTrial } from "./processing-trial"
import { runProcessingWorker } from "./processing-worker"
import { createInformationServer, verifyWebBuild } from "./server"
import { errorCode, InformationService, readCredential } from "./service"
import { Store } from "./store"
import { createWebAuthenticator } from "./web-auth"
import { createXApi } from "./x-api"
import { createXSearchClient } from "./x-client"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    entry: { type: "string" },
    model: { type: "string" },
    limit: { type: "string" },
    pages: { type: "string" },
    job: { type: "string" },
  },
})
const dataDir = resolve(
  process.env.FOLO_INFORMATION_DATA_DIR ?? join(homedir(), ".local/share/folo-information-p0"),
)
const webRoot = resolve(process.env.FOLO_INFORMATION_WEB_ROOT ?? "../desktop/out/information-web")
const mainWebRoot = process.env.FOLO_INFORMATION_MAIN_WEB_ROOT
const configPath = process.env.FOLO_INFORMATION_CLI_CONFIG ?? join(homedir(), ".folo/config.json")
const port = Number(process.env.FOLO_INFORMATION_PORT ?? 2240)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port")
// 浏览器始终使用站点域名，监听端口只作为本机反向代理的内部目标。
const publicOrigin = new URL(process.env.FOLO_INFORMATION_PUBLIC_ORIGIN ?? "http://local.folo.is")
  .origin
if (!/^https?:\/\//.test(publicOrigin)) throw new Error("invalid_public_origin")
const store = new Store(join(dataDir, "information.sqlite"))
const webCredentialPath = join(dataDir, "web-credential.json")
const aiConfig = new AIConfigStore(join(dataDir, "ai-config.json"))
const reader = async () =>
  new FoloReader(
    await readCredential(existsSync(webCredentialPath) ? webCredentialPath : configPath),
  )
const service = new InformationService({
  store,
  aiConfig,
  runtimeDir: join(dataDir, "runtime"),
  // 主站登录更新后台凭据后优先使用；只有尚未接入时兼容原 CLI 凭据。
  reader,
})
const command = positionals[0] ?? "status"
const print = (value: object) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

function workerLock() {
  const path = join(dataDir, "worker.lock")
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid_worker_lock")
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false
    }
    if (alive) throw new Error("worker_already_running")
    unlinkSync(path)
  }
  // 单个 worker 拥有恢复和模型调度权；CLI 只写入队列，不抢正在执行的任务。
  const fd = openSync(path, "wx", 0o600)
  writeFileSync(fd, String(process.pid))
  closeSync(fd)
  return () => unlinkSync(path)
}

async function main() {
  if (command === "sync") {
    const { sources } = await service.sync()
    print({ ownerId: store.ownerId, sources })
  } else if (command === "scan" || command === "process") {
    if (!values.source) throw new Error("source_required")
    if (command === "process" && !values.entry) throw new Error("entry_required")
    // 新任务记录后台选定的模型；显式 --model 只覆盖这一条任务。
    const config = command === "process" ? await aiConfig.read() : null
    const limit = Number(values.limit ?? 5)
    const pages = Number(values.pages ?? 3)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(pages) ||
      pages < 1 ||
      pages > 100
    )
      throw new Error("invalid_budget")
    print(
      store.enqueue({
        kind: command,
        sourceKey: values.source,
        itemId: values.entry,
        model: values.model ?? config?.model,
        provider: config?.provider,
        limit,
        pages,
      }),
    )
  } else if (command === "resume") {
    const job = values.job ? store.job(values.job) : null
    if (!job || job.kind !== "scan" || job.status === "running" || job.coverage === "end")
      throw new Error("scan_not_resumable")
    job.status = "queued"
    job.error = null
    store.saveJob(job)
    print(job)
  } else if (command === "members") {
    const { reader, sources } = await service.sync()
    const source = sources.find(
      (candidate) => candidate.key === values.source && candidate.kind === "list",
    )
    if (!source) throw new Error("list_source_required")
    print(await reader.listMembers(source.id))
  } else if (command === "connect") {
    // 兼容旧命令入口，但不再创建另一套浏览器授权。
    await new Promise<void>((resolveOpen, reject) =>
      execFile("open", [`${publicOrigin}/information`], (error) =>
        error ? reject(error) : resolveOpen(),
      ),
    )
    print({ opened: true })
  } else if (command === "items") {
    // 仅输出可选择条目的元数据，便于从扫描结果显式发起单篇处理。
    print({ items: store.snapshot().items })
  } else if (command === "status") {
    const snapshot = store.snapshot()
    print({
      ownerId: snapshot.ownerId,
      sources: snapshot.sources.length,
      itemsShown: snapshot.items.length,
      resultsShown: snapshot.results.length,
      jobs: snapshot.jobs,
    })
  } else if (command === "serve" || command === "run-once") {
    if (command === "serve") {
      await verifyWebBuild(webRoot)
      if (mainWebRoot) await verifyWebBuild(mainWebRoot)
    }
    const unlock = workerLock()
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    const server =
      command === "serve"
        ? createInformationServer(
            store,
            webRoot,
            port,
            publicOrigin,
            createWebAuthenticator(store, webCredentialPath),
            {
              config: aiConfig,
              chat: new FoloChat({ store, aiConfig, reader, runtimeDir: join(dataDir, "runtime") }),
              trial: new ProcessingTrial({ store, aiConfig, runtimeDir: join(dataDir, "runtime") }),
              signal: controller.signal,
            },
            mainWebRoot,
            [
              externalApi({ store, configPath: join(dataDir, "external-config.json") }),
              diagnosticsApi(store, join(dataDir, "runtime", "codex-usage.jsonl")),
              createXApi({
                configPath: join(dataDir, "x-config.json"),
                queries: store.xQueries,
                client: (config) =>
                  createXSearchClient({ bearerToken: config.bearerToken!, access: config.access }),
                saveEntry: (entry) => store.saveEntry(entry),
                subscribedFoloSource: (postId) => {
                  // 按已保存的原帖链接身份关联，正文提及 X 或相似标题都不算同一帖子。
                  return (
                    store.automation.inputs().find((input) => {
                      return (
                        !input.sourceKey.startsWith("x/search/") && xPostId(input.body) === postId
                      )
                    })?.sourceKey ?? null
                  )
                },
              }),
            ],
          )
        : null
    try {
      if (server)
        await new Promise<void>((resolveListen, reject) => {
          server.once("error", reject)
          server.listen(port, "127.0.0.1", resolveListen)
        })
      store.recover()
      store.processingState.recover()
      print({ worker: "ready", ...(server ? { url: `${publicOrigin}/information` } : {}) })
      do {
        const job = store.nextJob()
        if (job) {
          await service.run(job, controller.signal)
          print({ jobId: job.id, status: job.status, error: job.error })
        }
        const processing = await runProcessingWorker(
          { store, aiConfig, reader, runtimeDir: join(dataDir, "runtime") },
          controller.signal,
        )
        if (processing) print({ processing })
        if (command === "run-once" || controller.signal.aborted) break
        await setTimeout(1000, undefined, { signal: controller.signal }).catch(() => {})
      } while (!controller.signal.aborted)
    } finally {
      if (server?.listening)
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      unlock()
      process.removeListener("SIGTERM", stop)
      process.removeListener("SIGINT", stop)
    }
  } else throw new Error("unknown_command")
}

try {
  await main()
} catch (error) {
  // 不打印原始异常对象，避免上游响应或子进程内容泄漏。
  const commandErrors = new Set([
    "invalid_worker_lock",
    "worker_already_running",
    "source_required",
    "entry_required",
    "invalid_budget",
    "scan_not_resumable",
    "list_source_required",
    "unknown_command",
    "production_web_build_required",
  ])
  print({
    error:
      error instanceof Error && commandErrors.has(error.message) ? error.message : errorCode(error),
  })
  process.exitCode = 1
} finally {
  store.close()
}
