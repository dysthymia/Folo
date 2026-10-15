import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { describe, expect, it, vi } from "vitest"

import { runWorkerLoop, serviceRoles, workerReleaseChanged } from "./worker-lifecycle"

describe("independent web and worker lifecycle", () => {
  it("keeps queue recovery and execution out of the web role", () => {
    expect(serviceRoles("serve-web")).toEqual({ web: true, worker: false, once: false })
    expect(serviceRoles("worker")).toEqual({ web: false, worker: true, once: false })
    expect(serviceRoles("serve")).toEqual({ web: true, worker: true, once: false })
  })

  it("finishes an active rule batch without aborting its signal before reloading", async () => {
    const controller = new AbortController()
    let changed = false
    let finish!: () => void
    const recover = vi.fn()
    const runJob = vi.fn(async () => {})
    const runProcessing = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      expect(signal.aborted).toBe(false)
    })
    const loop = runWorkerLoop({
      signal: controller.signal,
      recover,
      runJob,
      runProcessing,
      shouldReload: () => changed,
      idleMs: 0,
    })
    await vi.waitFor(() => expect(runProcessing).toHaveBeenCalledTimes(1))
    changed = true
    // 发布指针已变化时调用仍继续，只有批次提交完成才允许退出。
    expect(controller.signal.aborted).toBe(false)
    finish()
    await loop
    expect(recover).toHaveBeenCalledOnce()
    expect(runJob).toHaveBeenCalledOnce()
    expect(runProcessing).toHaveBeenCalledOnce()
  })

  it("does not claim a rule batch after a scan finishes on an old release", async () => {
    let changed = false
    const runProcessing = vi.fn(async () => {})
    await runWorkerLoop({
      signal: new AbortController().signal,
      recover: () => {},
      runJob: async () => {
        changed = true
      },
      runProcessing,
      shouldReload: () => changed,
    })
    expect(runProcessing).not.toHaveBeenCalled()
  })

  it("detects an atomic runtime switch while retaining the old release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "folo-worker-release-"))
    try {
      const old = join(directory, "old")
      const next = join(directory, "next")
      const pointer = join(directory, "current")
      await mkdir(old)
      await mkdir(next)
      const manifest = (hash: string) => JSON.stringify({ files: { "index.mjs": hash } })
      await writeFile(join(old, "local-release.json"), manifest("same-backend"))
      await writeFile(join(next, "local-release.json"), manifest("same-backend"))
      await symlink(old, pointer)
      expect(workerReleaseChanged(pointer, old)).toBe(false)
      await rm(pointer)
      await symlink(next, pointer)
      expect(workerReleaseChanged(pointer, old)).toBe(false)
      await writeFile(join(next, "local-release.json"), manifest("new-backend"))
      expect(workerReleaseChanged(pointer, old)).toBe(true)
      expect(workerReleaseChanged()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
