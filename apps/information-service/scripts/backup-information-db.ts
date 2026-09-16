import { chmodSync, existsSync, rmSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { resolve } from "pathe"

function integrityCheck(db: DatabaseSync) {
  const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>
  if (rows.length !== 1 || Object.values(rows[0]!).some((value) => value !== "ok"))
    throw new Error("sqlite_integrity_check_failed")
}

function businessTables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => String((row as Record<string, unknown>).name))
    .filter((name) => !name.startsWith("sqlite_"))
    .sort()
}

function assertRecoverableBusinessTables(expected: readonly string[], backup: DatabaseSync) {
  const actual = businessTables(backup)
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
    throw new Error("business_tables_missing_from_backup")
}

function removeVolatileAccessTokens(db: DatabaseSync) {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_tokens'")
    .get()
  // 会话票据属于短期私密凭据；业务库恢复后应重新签发，不能随备份传播。
  if (row) db.exec("DELETE FROM access_tokens")
}

// SQLite 的 VACUUM INTO 走一致性备份路径；目标必须是新文件，避免误覆盖唯一业务库。
export function backupInformationDatabase(sourceFile: string, backupFile: string) {
  const sourcePath = resolve(sourceFile)
  const backupPath = resolve(backupFile)
  if (sourcePath === backupPath || !existsSync(sourcePath) || !statSync(sourcePath).isFile())
    throw new Error("invalid_source_database")
  if (existsSync(backupPath)) throw new Error("backup_destination_exists")

  const source = new DatabaseSync(sourcePath, { timeout: 5_000 })
  let created = false
  let sourceTables: string[] = []
  try {
    integrityCheck(source)
    sourceTables = businessTables(source)
    source.prepare("VACUUM INTO ?").run(backupPath)
    created = true
  } finally {
    source.close()
  }
  try {
    const backup = new DatabaseSync(backupPath, { timeout: 5_000 })
    try {
      removeVolatileAccessTokens(backup)
      integrityCheck(backup)
      assertRecoverableBusinessTables(sourceTables, backup)
    } finally {
      backup.close()
    }
    chmodSync(backupPath, 0o600)
  } catch (error) {
    if (created && existsSync(backupPath)) rmSync(backupPath)
    throw error
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [sourceFile, backupFile] = process.argv.slice(2)
  if (!sourceFile || !backupFile) {
    process.stderr.write("Usage: backup-information-db <source.sqlite> <backup.sqlite>\n")
    process.exitCode = 2
  } else {
    backupInformationDatabase(sourceFile, backupFile)
    process.stdout.write(`Backup written to ${resolve(backupFile)}\n`)
  }
}
