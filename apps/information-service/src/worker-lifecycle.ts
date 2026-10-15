import { readFileSync, realpathSync } from "node:fs"
import { setTimeout } from "node:timers/promises"

import { join } from "pathe"

// 网页进程不获取执行锁或恢复队列，避免更新页面时误判另一个进程的任务已中断。
export function serviceRoles(command: string) {
  return {
    web: command === "serve" || command === "serve-web",
    worker: command === "serve" || command === "worker" || command === "run-once",
    once: command === "run-once",
  }
}

export function workerReleaseChanged(pointer?: string, runtime?: string) {
  if (!pointer || !runtime) return false
  // 读取原子切换的发布指针；旧目录会保留到当前执行器安全退出之后。
  const current = realpathSync(pointer)
  const running = realpathSync(runtime)
  if (current === running) return false
  // 只更新界面时后台代码摘要不变，执行器连安全重启都无需进行。
  const backend = (directory: string): string => {
    const manifest = JSON.parse(readFileSync(join(directory, "local-release.json"), "utf8")) as {
      files: Record<string, string>
    }
    const hash = manifest.files["index.mjs"]
    if (!hash) throw new Error("invalid_worker_release")
    return hash
  }
  return backend(current) !== backend(running)
}

export async function runWorkerLoop(options: {
  signal: AbortSignal
  recover: () => void
  runJob: (signal: AbortSignal) => Promise<void>
  runProcessing: (signal: AbortSignal) => Promise<void>
  shouldReload: () => boolean
  once?: boolean
  idleMs?: number
}) {
  options.recover()
  // 安装新版只改变发布指针，不取消模型调用；每个完整作业或规则批次结束后再切换。
  while (!options.signal.aborted && !options.shouldReload()) {
    await options.runJob(options.signal)
    if (options.signal.aborted || options.shouldReload()) break
    await options.runProcessing(options.signal)
    if (options.once || options.signal.aborted || options.shouldReload()) break
    await setTimeout(options.idleMs ?? 1000, undefined, { signal: options.signal }).catch(() => {})
  }
}
