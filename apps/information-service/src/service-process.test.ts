import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { describe, expect, it } from "vitest"

import { Store } from "./store"

async function waitForWeb(child: ChildProcessWithoutNullStreams) {
  await new Promise<void>((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => reject(new Error("web_start_timeout")), 10_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(new Error("web_exited_before_ready"))
    })
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString()
      if (output.includes('"command": "serve-web"')) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
}

// 使用真实子进程和共享 SQLite，防止角色拆分后网页启动仍误恢复运行中的任务。
describe("information service process isolation", () => {
  it("restarts web beside a locked worker without recovering or executing its running job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "folo-process-isolation-"))
    const web = join(directory, "web")
    await mkdir(web)
    await writeFile(
      join(web, "index.html"),
      '<html><body><script type="module" src="/assets/app.js"></script></body></html>',
    )
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const address = probe.address()
    if (!address || typeof address === "string") throw new Error("missing_test_port")
    const port = address.port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const store = new Store(join(directory, "information.sqlite"))
    const job = store.enqueue({ kind: "scan", sourceKey: "feed/isolated" })
    job.status = "running"
    store.saveJob(job)
    await writeFile(join(directory, "worker.lock"), String(process.pid))
    const environment = {
      ...process.env,
      FOLO_INFORMATION_DATA_DIR: directory,
      FOLO_INFORMATION_WEB_ROOT: web,
      FOLO_INFORMATION_MAIN_WEB_ROOT: "",
      FOLO_INFORMATION_PORT: String(port),
      FOLO_INFORMATION_PUBLIC_ORIGIN: "http://local.folo.is",
    }
    let child: ChildProcessWithoutNullStreams | undefined
    try {
      // 连续启动两次网页，模拟发布重启；已有执行器锁和 running 状态必须原样保留。
      for (let attempt = 0; attempt < 2; attempt++) {
        child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "serve-web"], {
          env: environment,
        })
        await waitForWeb(child)
        const response = await fetch(`http://127.0.0.1:${port}/information`)
        expect(response.status).toBe(200)
        expect(store.job(job.id)?.status).toBe("running")
        const exited = once(child, "exit")
        child.kill("SIGTERM")
        await exited
        child = undefined
        expect(await readFile(join(directory, "worker.lock"), "utf8")).toBe(String(process.pid))
        expect(store.job(job.id)?.status).toBe("running")
      }
      const duplicate = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "run-once"], {
        env: environment,
      })
      let output = ""
      duplicate.stdout.on("data", (data: Buffer) => {
        output += data.toString()
      })
      const [code] = await once(duplicate, "exit")
      expect(code).toBe(1)
      expect(output).toContain("worker_already_running")
      expect(store.job(job.id)?.status).toBe("running")
    } finally {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit")
        child.kill("SIGTERM")
        await exited
      }
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
