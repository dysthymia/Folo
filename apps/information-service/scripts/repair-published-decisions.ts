import { existsSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { dirname, join, resolve } from "pathe"
import { z } from "zod"

import { sourceText } from "../src/service"
import { Store } from "../src/store"
import { backupInformationDatabase } from "./backup-information-db"

const manifestSchema = z
  .array(
    z
      .object({
        inputSeq: z.number().int().positive(),
        contentVersion: z.string().regex(/^[a-f0-9]{64}$/),
        decisionId: z.string().regex(/^[a-f0-9]{64}$/),
        reason: z.string().trim().min(1).max(4000),
        status: z.enum(["keep", "needs_context"]),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine((items) => new Set(items.map((item) => item.inputSeq)).size === items.length)

const { values } = parseArgs({
  options: {
    database: { type: "string" },
    manifest: { type: "string" },
    apply: { type: "boolean", default: false },
    backup: { type: "string" },
  },
})
if (!values.database || !values.manifest) throw new Error("database_and_manifest_required")
const database = resolve(values.database)
const manifest = manifestSchema.parse(JSON.parse(readFileSync(values.manifest, "utf8")))

// 预览使用只读连接，不运行建表迁移，也不启动恢复、扫描或模型任务。
const preview = new DatabaseSync(database, { readOnly: true })
try {
  for (const item of manifest) {
    const row = preview
      .prepare("SELECT content_version,current,decision_id FROM processing_inputs WHERE seq=?")
      .get(item.inputSeq)
    if (
      !row ||
      row.current !== 1 ||
      row.content_version !== item.contentVersion ||
      row.decision_id !== item.decisionId
    )
      throw new Error(`repair_target_changed:${item.inputSeq}`)
  }
  if (values.apply) {
    const lock = join(dirname(database), "worker.lock")
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid_worker_lock")
      try {
        process.kill(pid, 0)
        throw new Error("stop_worker_before_repair")
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    const schedule = preview.prepare("SELECT body FROM processing_schedule WHERE id=1").get()
    if (schedule && JSON.parse(String(schedule.body)).enabled)
      throw new Error("pause_schedule_before_repair")
    const running = preview
      .prepare(
        "SELECT (SELECT COUNT(*) FROM processing_inputs WHERE status='running')+(SELECT COUNT(*) FROM jobs WHERE status='running')+(SELECT COUNT(*) FROM processing_schedule_triggers WHERE status='running') AS count",
      )
      .get()
    if (Number(running?.count)) throw new Error("wait_for_running_tasks_before_repair")
  }
} finally {
  preview.close()
}

if (!values.apply) {
  process.stdout.write(
    `${JSON.stringify({ dryRun: true, inputSeqs: manifest.map((item) => item.inputSeq) })}\n`,
  )
} else {
  if (!values.backup) throw new Error("fresh_backup_path_required")
  backupInformationDatabase(database, values.backup)
  const store = new Store(database)
  try {
    // 修复摘要只摘录当前原文；错误模型档案及指纹留在审计层，阻止后续缓存复用。
    const targets = manifest.map((item) => {
      const input = store.automation.inputs([item.inputSeq])[0]!
      return {
        ...item,
        summary: sourceText(input.body.content || input.body.description || "").slice(0, 4000),
      }
    })
    process.stdout.write(
      `${JSON.stringify({ dryRun: false, results: store.processingState.quarantine(targets) })}\n`,
    )
  } finally {
    store.close()
  }
}
