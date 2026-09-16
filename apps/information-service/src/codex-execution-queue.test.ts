import { describe, expect, it } from "vitest"

import { CodexExecutionQueueError, runSerialized } from "./codex-execution-queue"

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("Codex runtime 执行队列", () => {
  it("相同 runtime 的并发高水位为 1", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    let active = 0
    let highWater = 0
    const execute = (gate: ReturnType<typeof deferred<void>>) => async () => {
      active += 1
      highWater = Math.max(highWater, active)
      await gate.promise
      active -= 1
    }

    const one = runSerialized("/tmp/folo-runtime", undefined, execute(first))
    const two = runSerialized("/tmp/folo-runtime/../folo-runtime", undefined, execute(second))
    await Promise.resolve()
    expect(highWater).toBe(1)
    first.resolve()
    await Promise.resolve()
    expect(highWater).toBe(1)
    second.resolve()
    await Promise.all([one, two])
  })

  it("等待任务取消后不会执行，也不会阻塞后续任务", async () => {
    const first = deferred<void>()
    let canceledExecuted = false
    let subsequentExecuted = false
    const controller = new AbortController()
    const one = runSerialized("/tmp/folo-cancel", undefined, () => first.promise)
    const canceled = runSerialized("/tmp/folo-cancel", controller.signal, async () => {
      canceledExecuted = true
    })
    const subsequent = runSerialized("/tmp/folo-cancel", undefined, async () => {
      subsequentExecuted = true
    })

    await Promise.resolve()
    controller.abort()
    await expect(canceled).rejects.toEqual(expect.objectContaining({ code: "aborted" }))
    first.resolve()
    await Promise.all([one, subsequent])
    expect(canceledExecuted).toBe(false)
    expect(subsequentExecuted).toBe(true)
  })

  it("执行异常仍会释放同一 runtime 的槽位", async () => {
    let secondExecuted = false
    const failed = runSerialized("/tmp/folo-error", undefined, async () => {
      throw new Error("runner_failed")
    })
    const next = runSerialized("/tmp/folo-error", undefined, async () => {
      secondExecuted = true
      return "ok"
    })

    await expect(failed).rejects.toThrow("runner_failed")
    await expect(next).resolves.toBe("ok")
    expect(secondExecuted).toBe(true)
  })

  it("不同 runtime 可以并行执行", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    let started = 0
    const one = runSerialized("/tmp/folo-runtime-a", undefined, async () => {
      started += 1
      await first.promise
    })
    const two = runSerialized("/tmp/folo-runtime-b", undefined, async () => {
      started += 1
      await second.promise
    })

    await Promise.resolve()
    expect(started).toBe(2)
    first.resolve()
    second.resolve()
    await Promise.all([one, two])
  })

  it("已取消的任务从不调用 execute", async () => {
    const controller = new AbortController()
    controller.abort()
    let executed = false
    await expect(
      runSerialized("/tmp/folo-already-aborted", controller.signal, async () => {
        executed = true
      }),
    ).rejects.toBeInstanceOf(CodexExecutionQueueError)
    expect(executed).toBe(false)
  })
})
