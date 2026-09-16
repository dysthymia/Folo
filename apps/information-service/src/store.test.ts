import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import { join } from "pathe"
import { afterEach, describe, expect, it } from "vitest"

import type { Source, SourceEntry } from "./folo"
import type { Result } from "./store"
import { Store } from "./store"

const source: Source = {
  key: "feed/f1",
  kind: "feed",
  id: "f1",
  title: "来源",
  view: 0,
  category: null,
}
const entry: SourceEntry = {
  id: "e1",
  sourceKey: source.key,
  title: "文章",
  url: "https://example.test/article",
  publishedAt: "2026-09-01T00:00:00.000Z",
  read: true,
  content: "<p>正文</p>",
  description: null,
}
const result: Result = {
  id: "result1",
  itemId: entry.id,
  sourceKey: source.key,
  title: entry.title,
  model: "test-model",
  material: "source_text",
  createdAt: "2026-09-01T01:00:00.000Z",
  payload: { summary: "摘要", points: ["要点"], entryId: entry.id },
  durationMs: 12,
  usage: null,
}

const stores: Store[] = []
const directories: string[] = []
const openStore = (path = ":memory:") => {
  const store = new Store(path)
  stores.push(store)
  return store
}
const reopen = (store: Store, path: string) => {
  store.close()
  stores.splice(stores.indexOf(store), 1)
  return openStore(path)
}
const databasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "folo-p0-store-test-"))
  directories.push(directory)
  return join(directory, "state.sqlite")
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("Store persistence", () => {
  it("旧库条目只迁入一次输入版本，发布和草稿重启后仍分别保存", () => {
    const path = databasePath()
    const legacy = new DatabaseSync(path)
    // 用真实旧表结构验证增量迁移，不预先创建新模块的表或迁移标记。
    legacy.exec(
      "CREATE TABLE entries(source_key TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_key,id))",
    )
    legacy
      .prepare("INSERT INTO entries VALUES(?,?,?)")
      .run(entry.sourceKey, entry.id, JSON.stringify(entry))
    legacy.close()
    const migrated = openStore(path)
    migrated.bindOwner("owner")
    const initial = migrated.automation.draft()
    migrated.automation.publish(
      initial.revision,
      { mode: "future" },
      "00000000-0000-4000-8000-000000000001",
    )
    migrated.automation.saveDraft(
      { ...initial.config, global: { version: 1, markdown: "尚未发布的新草稿" } },
      initial.revision,
    )
    const restored = reopen(migrated, path)
    expect(restored.automation.inputs()).toHaveLength(1)
    expect(restored.automation.draft().config.global.markdown).toBe("尚未发布的新草稿")
    expect(restored.automation.release(1)?.global.markdown).toBe("")
    expect(restored.automation.assign(restored.automation.inputs()[0]!.seq).releaseVersion).toBe(1)
    expect(restored.entry(entry.sourceKey, entry.id)).toEqual(entry)
  })

  it("SQLite 关闭再打开后保留账号、来源、正文、任务水位和结果", () => {
    const path = databasePath()
    const original = openStore(path)
    original.bindOwner("owner")
    original.replaceSources([source])
    original.saveEntry(entry)
    original.saveResult(result)
    const job = original.enqueue({ kind: "scan", sourceKey: source.key, limit: 2, pages: 3 })
    job.cursor = entry.publishedAt
    job.pages = 1
    job.status = "succeeded"
    job.coverage = "budget"
    original.saveJob(job)

    const restored = reopen(original, path)
    expect(restored.ownerId).toBe("owner")
    expect(restored.sources()).toEqual([source])
    expect(restored.entry(source.key, entry.id)).toEqual(entry)
    expect(restored.job(job.id)).toEqual(job)
    expect(restored.result(result.id)).toEqual(result)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // 面向 Web 的快照不携带正文，防止把整库文章意外塞进列表响应。
    expect(restored.snapshot().items[0]).not.toHaveProperty("content")
  })

  it("重启只重排扫描任务，模型结果未知的任务不会自动重试", () => {
    const path = databasePath()
    const original = openStore(path)
    const scan = original.enqueue({ kind: "scan", sourceKey: source.key })
    Object.assign(scan, { status: "running", pages: 2, cursor: entry.publishedAt })
    original.saveJob(scan)
    const process = original.enqueue({
      kind: "process",
      sourceKey: source.key,
      itemId: entry.id,
      model: "test-model",
    })
    process.status = "running"
    original.saveJob(process)
    const completed = original.enqueue({ kind: "process", sourceKey: source.key })
    completed.status = "succeeded"
    original.saveJob(completed)

    const restored = reopen(original, path)
    restored.recover()
    expect(restored.job(scan.id)).toMatchObject({
      status: "queued",
      pages: 2,
      cursor: entry.publishedAt,
      error: null,
    })
    expect(restored.job(process.id)).toMatchObject({
      status: "failed",
      error: "interrupted_model_outcome_unknown",
    })
    expect(restored.job(completed.id)?.status).toBe("succeeded")
    expect(restored.nextJob()?.id).toBe(scan.id)
    restored.recover()
    expect(restored.job(process.id)?.status).toBe("failed")
  })

  it("拒绝把已有数据库绑定到另一个账号", () => {
    const store = openStore()
    store.bindOwner("owner")
    store.replaceSources([source])
    store.bindOwner("owner")
    expect(() => store.bindOwner("other")).toThrow("account_changed")
    expect(store.ownerId).toBe("owner")
    expect(store.sources()).toEqual([source])
  })

  it("事务失败会同时回滚正文与任务游标", () => {
    const store = openStore()
    const job = store.enqueue({ kind: "scan", sourceKey: source.key })
    expect(() =>
      store.transaction(() => {
        store.saveEntry(entry)
        store.saveJob({ ...job, pages: 1, cursor: entry.publishedAt })
        throw new Error("simulated persistence failure")
      }),
    ).toThrow("simulated persistence failure")
    expect(store.entry(source.key, entry.id)).toBeNull()
    expect(store.job(job.id)).toMatchObject({ pages: 0, cursor: null })
  })

  it("刷新来源只撤销活跃授权，不丢失已保存的文章", () => {
    const store = openStore()
    store.replaceSources([source])
    store.saveEntry(entry)
    store.replaceSources([])
    expect(store.sources()).toEqual([])
    expect(store.entry(source.key, entry.id)).toEqual(entry)
  })

  it("列表快照不降级正文与媒体信息，详情明确变空仍创建新版本", () => {
    const store = openStore()
    store.bindOwner("owner")
    store.saveEntry({ ...entry, mediaLength: 2, attachmentsDuration: 120 })
    const originalSeq = store.automation.inputs()[0]!.seq
    store.automation.publish(0, { mode: "future" }, randomUUID())
    const target = store.automation.assign(originalSeq)
    store.automation.complete(target, { summary: "已处理" })

    store.saveListedEntry({
      ...entry,
      read: !entry.read,
      content: null,
      mediaLength: null,
      attachmentsDuration: null,
    })
    const listed = store.entry(source.key, entry.id)!
    expect(listed).toMatchObject({
      content: entry.content,
      read: !entry.read,
      mediaLength: 2,
      attachmentsDuration: 120,
    })
    expect(store.automation.inputs()).toHaveLength(1)
    expect(store.automation.inputs()[0]!.seq).toBe(originalSeq)

    // 详情返回同一正文时仍复用旧成功输入，不经历“空正文再恢复”的版本震荡。
    store.saveEntry(listed)
    expect(store.automation.inputs()[0]!.seq).toBe(originalSeq)

    // 部分页有正文却仍省略媒体字段，也不能使成功结果变成待处理。
    store.saveListedEntry({ ...listed, mediaLength: undefined, attachmentsDuration: undefined })
    expect(store.automation.inputs()[0]).toMatchObject({ seq: originalSeq, status: "succeeded" })

    // 真实列表把正文内两张媒体缩成一张预览，非空计数同样不能替换详情计数。
    store.saveListedEntry({ ...listed, content: null, mediaLength: 1, attachmentsDuration: 0 })
    expect(store.automation.inputs()[0]).toMatchObject({ seq: originalSeq, status: "succeeded" })
    expect(store.entry(source.key, entry.id)).toMatchObject({
      mediaLength: 2,
      attachmentsDuration: 120,
    })

    store.saveListedEntry({
      ...listed,
      collected: true,
      updatedAt: "2026-09-12T01:00:00.000Z",
      content: null,
    })
    const refreshed = store.entry(source.key, entry.id)!
    expect(refreshed).toMatchObject({
      content: entry.content,
      collected: true,
      updatedAt: "2026-09-12T01:00:00.000Z",
    })

    store.saveEntry({ ...refreshed, content: null })
    expect(store.entry(source.key, entry.id)?.content).toBeNull()
    expect(store.automation.inputs()[0]!.seq).not.toBe(originalSeq)

    // 上游明确返回空数组转换出的 0 是已知变化，不能被旧媒体信息覆盖。
    store.saveListedEntry({ ...refreshed, mediaLength: 0, attachmentsDuration: 0 })
    expect(store.entry(source.key, entry.id)).toMatchObject({
      mediaLength: 0,
      attachmentsDuration: 0,
    })
    store.saveEntry({ ...refreshed, mediaLength: null, attachmentsDuration: null })
    expect(store.entry(source.key, entry.id)).toMatchObject({
      mediaLength: null,
      attachmentsDuration: null,
    })
  })

  it("带同步时间刷新时把规则上下文来源快照一并更新", () => {
    const store = openStore()
    const syncedAt = "2026-09-12T00:00:00.000Z"
    store.replaceSources([source], syncedAt)

    expect(store.sources()).toEqual([source])
    expect(store.sourceSync.contextFor(source.key, entry).metadata.sourceSyncedAt).toBe(syncedAt)
  })
})
