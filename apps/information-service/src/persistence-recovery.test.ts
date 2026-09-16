import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, describe, expect, it } from "vitest"

import { backupInformationDatabase } from "../scripts/backup-information-db"
import type { SourceEntry } from "./folo"
import { Store } from "./store"

const stores: Store[] = []
const directories: string[] = []

function databasePath(name = "information.sqlite") {
  const directory = mkdtempSync(join(tmpdir(), "folo-information-recovery-"))
  directories.push(directory)
  return join(directory, name)
}

function open(path: string) {
  const store = new Store(path)
  stores.push(store)
  return store
}

function reopen(store: Store, path: string) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
  return open(path)
}

const entry: SourceEntry = {
  sourceKey: "feed/recovery-source",
  id: "recovery-entry",
  title: "恢复验证文章",
  url: "https://example.test/recovery",
  publishedAt: "2026-04-01T00:00:00.000Z",
  read: false,
  content: "用于持久化恢复验证的正文。",
  description: null,
}

function prepareBusinessState(store: Store) {
  store.bindOwner("owner")
  store.saveEntry(entry)
  const draft = store.automation.draft()
  store.automation.saveDraft(
    {
      ...draft.config,
      global: { version: 1, markdown: "恢复后仍应保留的规则集说明" },
    },
    draft.revision,
  )
  store.automation.publish(1, { mode: "future" }, "00000000-0000-4000-8000-000000000501")
  const tag = store.subscriptionTags.create("来源/恢复验证", 0).tags[0]!
  store.subscriptionTags.updateBindings({
    expectedRevision: 1,
    sourceKeys: [entry.sourceKey],
    tagIds: [tag.id],
    operation: "add",
  })
  store.schedule.save(
    {
      sourceKeys: [entry.sourceKey],
      historySince: "2026-04-01T00:00:00.000Z",
      timeZone: "Asia/Shanghai",
      enabled: true,
      times: ["08:00", "12:00", "15:00"],
    },
    0,
  )
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("业务库持久化与恢复", () => {
  it("关闭重开后保留规则、标签和计划；跨日仅创建一个追赶，过期租约不能由旧 worker 完成", () => {
    const path = databasePath()
    const original = open(path)
    prepareBusinessState(original)
    // 上海 07:00，建立停机前水位但不触发计划时点。
    expect(original.schedule.tick("2026-04-01T23:00:00.000Z")).toEqual([])

    const restored = reopen(original, path)
    expect(restored.automation.release(1)?.global.markdown).toBe("恢复后仍应保留的规则集说明")
    expect(restored.subscriptionTags.snapshot()).toMatchObject({
      revision: 2,
      tags: [{ name: "来源/恢复验证" }],
    })
    expect(restored.subscriptionTags.sourceTagBindings([entry.sourceKey]).bindings).toEqual([
      { sourceKey: entry.sourceKey, tagIds: [expect.any(String)] },
    ])
    expect(restored.schedule.snapshot()).toMatchObject({
      revision: 1,
      config: { sourceKeys: [entry.sourceKey], enabled: true },
    })

    const catchup = restored.schedule.tick("2026-04-03T08:30:00.000Z")
    expect(catchup).toEqual([expect.objectContaining({ kind: "catchup" })])
    expect(restored.schedule.tick("2026-04-03T08:31:00.000Z")).toEqual([])

    const claimed = restored.schedule.claim("2026-04-03T08:30:00.000Z", 1_000)!
    const afterRestart = reopen(restored, path)
    expect(afterRestart.schedule.recover("2026-04-03T08:30:01.000Z")).toBe(1)
    const retried = afterRestart.schedule.claim("2026-04-03T08:30:01.000Z", 1_000)!
    expect(
      afterRestart.schedule.finish(
        claimed.id,
        claimed.leaseToken!,
        "succeeded",
        "2026-04-03T08:30:01.000Z",
      ),
    ).toBe(false)
    expect(
      afterRestart.schedule.finish(
        retried.id,
        retried.leaseToken!,
        "succeeded",
        "2026-04-03T08:30:01.000Z",
      ),
    ).toBe(true)
  })

  it("对仍打开的 WAL 库作一致性备份，恢复业务数据但清除短期访问票据", () => {
    const sourcePath = databasePath()
    const backupPath = join(
      sourcePath.slice(0, sourcePath.lastIndexOf("/")),
      "recovery-backup.sqlite",
    )
    const source = open(sourcePath)
    prepareBusinessState(source)
    const sessionToken = source.issueAccess("session")

    // 源连接仍然打开且 WAL 存在，验证不是依赖关闭后复制主数据库文件。
    expect(existsSync(`${sourcePath}-wal`)).toBe(true)
    backupInformationDatabase(sourcePath, backupPath)

    expect(source.entry(entry.sourceKey, entry.id)).toEqual(entry)
    expect(source.checkAccess(sessionToken, "session")).toBe(true)
    const restored = open(backupPath)
    expect(restored.entry(entry.sourceKey, entry.id)).toEqual(entry)
    expect(restored.automation.release(1)?.global.markdown).toBe("恢复后仍应保留的规则集说明")
    expect(restored.subscriptionTags.snapshot().tags).toEqual([
      expect.objectContaining({ name: "来源/恢复验证" }),
    ])
    expect(restored.schedule.snapshot().config?.sourceKeys).toEqual([entry.sourceKey])
    expect(restored.checkAccess(sessionToken, "session")).toBe(false)

    // 备份目标不可覆盖，二次调用不能改变已验证的备份文件。
    expect(() => backupInformationDatabase(sourcePath, backupPath)).toThrow(
      "backup_destination_exists",
    )
    expect(open(backupPath).entry(entry.sourceKey, entry.id)).toEqual(entry)
  })

  it("损坏源库备份失败时保留源文件，也不遗留目标文件", () => {
    const sourcePath = databasePath("corrupt.sqlite")
    const backupPath = join(
      sourcePath.slice(0, sourcePath.lastIndexOf("/")),
      "corrupt-backup.sqlite",
    )
    const sourceBody = Buffer.from("not a sqlite database")
    writeFileSync(sourcePath, sourceBody)

    expect(() => backupInformationDatabase(sourcePath, backupPath)).toThrow()
    expect(readFileSync(sourcePath)).toEqual(sourceBody)
    expect(existsSync(backupPath)).toBe(false)
  })
})
