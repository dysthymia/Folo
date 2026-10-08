import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { ruleSetSchema } from "@follow/information-core"
import { dirname, join, resolve } from "pathe"

import { convergedReadingRules } from "../src/processing-reading-presets"
import { Store } from "../src/store"
import { backupInformationDatabase } from "./backup-information-db"

const { values } = parseArgs({
  options: {
    database: { type: "string" },
    apply: { type: "boolean", default: false },
    revision: { type: "string" },
    backup: { type: "string" },
  },
})
if (!values.database) throw new Error("database_required")
const database = resolve(values.database)
const db = new DatabaseSync(database, { readOnly: true })
let revision: number
try {
  const draft = db.prepare("SELECT revision,body FROM automation_draft WHERE id=1").get()
  if (!draft) throw new Error("draft_required")
  revision = Number(draft.revision)
  const config = convergedReadingRules(ruleSetSchema.parse(JSON.parse(String(draft.body))))
  if (values.apply) {
    if (Number(values.revision) !== revision || !values.backup)
      throw new Error("expected_revision_and_fresh_backup_required")
    const lock = join(dirname(database), "worker.lock")
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid_worker_lock")
      try {
        process.kill(pid, 0)
        throw new Error("stop_worker_before_rule_convergence")
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    const schedule = db.prepare("SELECT body FROM processing_schedule WHERE id=1").get()
    if (!schedule || JSON.parse(String(schedule.body)).enabled)
      throw new Error("paused_schedule_required")
  } else
    process.stdout.write(
      `${JSON.stringify({ dryRun: true, revision, rules: config.rules.map((rule) => rule.name), scope: "future" })}\n`,
    )
} finally {
  db.close()
}

if (values.apply) {
  backupInformationDatabase(database, values.backup!)
  const store = new Store(database)
  try {
    const result = {
      releaseVersion: 0,
      draftRevision: 0,
      historicalRecalculated: 0,
      firstAssignments: 0,
      sourceCount: 0,
      enabledAt: "",
    }
    store.transaction(() => {
      const draft = store.automation.draft()
      if (draft.revision !== revision) throw new Error("revision_conflict")
      const saved = store.automation.saveDraft(convergedReadingRules(draft.config), revision)
      const preview = store.automation.previewPublication({ mode: "future" })
      // future 允许尚未分配的原始材料首次绑定版本，但不能重算任何已有发布结果。
      if (preview.impact.recalculated)
        throw new Error("future_publication_must_not_requeue_history")
      const release = store.automation.publish(saved.revision, { mode: "future" }, randomUUID())
      const schedule = store.schedule.snapshot()
      const enabledAt = new Date().toISOString()
      // 扩展内容池从当前时刻前进；旧文章只在用户主动加载列表时按既有边界处理。
      store.schedule.save(
        {
          ...schedule.config!,
          scope: { mode: "rules" },
          historySince: enabledAt,
          classification: { mode: "new_content", enabledAt },
          enabled: false,
        },
        schedule.revision,
      )
      Object.assign(result, {
        releaseVersion: release.version,
        draftRevision: saved.revision,
        historicalRecalculated: preview.impact.recalculated,
        firstAssignments: preview.impact.newAssignments,
        sourceCount: store.schedule.snapshot().config!.sourceKeys.length,
        enabledAt,
      })
    })
    process.stdout.write(`${JSON.stringify({ dryRun: false, ...result })}\n`)
  } finally {
    store.close()
  }
}
