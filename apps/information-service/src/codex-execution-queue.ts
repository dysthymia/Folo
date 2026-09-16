import { resolve } from "pathe"

type QueueTask<T> = {
  signal: AbortSignal | undefined
  execute: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  removeAbortListener: () => void
}

type RuntimeQueue = {
  running: boolean
  tasks: Array<QueueTask<unknown>>
}

const queues = new Map<string, RuntimeQueue>()

// 同一 runtime 共用一个进程内槽位，避免聊天、单篇和 Story 同时竞争同一 Codex runtime。
export function runSerialized<T>(
  runtimeDir: string,
  signal: AbortSignal | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  const key = resolve(runtimeDir)
  let queue = queues.get(key)
  if (!queue) {
    queue = { running: false, tasks: [] }
    queues.set(key, queue)
  }
  if (signal?.aborted) return Promise.reject(new CodexExecutionQueueError("aborted"))

  return new Promise<T>((resolveTask, rejectTask) => {
    const task: QueueTask<T> = {
      signal,
      execute,
      resolve: resolveTask,
      reject: rejectTask,
      removeAbortListener: () => undefined,
    }
    const abort = () => {
      const index = queue!.tasks.indexOf(task as QueueTask<unknown>)
      if (index < 0) return
      queue!.tasks.splice(index, 1)
      task.removeAbortListener()
      rejectTask(new CodexExecutionQueueError("aborted"))
      cleanup(key, queue!)
    }
    if (signal) {
      signal.addEventListener("abort", abort, { once: true })
      task.removeAbortListener = () => signal.removeEventListener("abort", abort)
    }
    queue.tasks.push(task as QueueTask<unknown>)
    pump(key, queue)
  })
}

function pump(key: string, queue: RuntimeQueue): void {
  if (queue.running) return
  const task = queue.tasks.shift()
  if (!task) {
    cleanup(key, queue)
    return
  }
  if (task.signal?.aborted) {
    task.removeAbortListener()
    task.reject(new CodexExecutionQueueError("aborted"))
    pump(key, queue)
    return
  }

  queue.running = true
  task.removeAbortListener()
  // 用微任务调用 execute，保证同步抛错也能释放槽位。
  Promise.resolve()
    .then(task.execute)
    .then(task.resolve, task.reject)
    .finally(() => {
      queue.running = false
      pump(key, queue)
    })
}

function cleanup(key: string, queue: RuntimeQueue): void {
  if (!queue.running && queue.tasks.length === 0 && queues.get(key) === queue) queues.delete(key)
}

export class CodexExecutionQueueError extends Error {
  constructor(public readonly code: "aborted") {
    super(code)
  }
}
