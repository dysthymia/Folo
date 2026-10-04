import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Source } from "./folo"
import {
  applyNotionSourceImport,
  normalizeXUsername,
  parseNotionSourceAccounts,
  previewNotionSourceImport,
  readNotionSourceAccounts,
} from "./notion-source-import"
import { Store } from "./store"

const stores: Store[] = []
const feed: Source = {
  key: "feed/x",
  kind: "feed",
  id: "x",
  title: "显示名不能用于匹配",
  view: 0,
  category: "X",
  siteUrl: "https://x.com/Example",
  feedUrl: "https://rsshub.example/twitter/user/example",
}
function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([feed], new Date().toISOString())
  store.schedule.save(
    {
      scope: { mode: "all" },
      sourceKeys: [],
      historySince: "2026-01-01T00:00:00Z",
      timeZone: "UTC",
      enabled: false,
    },
    0,
  )
  return store
}
afterEach(() => stores.splice(0).forEach((store) => store.close()))

describe("Notion 账号单向导入与对账", () => {
  // 此集成场景顺序启动两次Node/tsx并初始化SQLite，独立限时而不扩大纯单元测试时限。
  it("CLI 默认预览、显式 apply 并生成可审计报告（独立临时数据库）", () => {
    const directory = mkdtempSync(join(tmpdir(), "folo-notion-import-"))
    const db = join(directory, "store.sqlite"),
      input = join(directory, "accounts.json"),
      output = join(directory, "report.json")
    try {
      const store = new Store(db)
      store.bindOwner("owner")
      store.replaceSources([feed])
      store.close()
      writeFileSync(input, JSON.stringify([{ id: "n", username: "example", tags: ["AI"] }]))
      const args = [
        "--import",
        "tsx",
        "scripts/import-notion-sources.ts",
        "--db",
        db,
        "--input",
        input,
        "--output",
        output,
      ]
      execFileSync(process.execPath, args, {
        cwd: import.meta.dirname.replace(/\/src$/u, ""),
        stdio: "pipe",
        timeout: 8_000,
      })
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        mode: "preview",
        revision: 0,
        accounts: 1,
      })
      execFileSync(process.execPath, [...args, "--apply", "--revision", "0"], {
        cwd: import.meta.dirname.replace(/\/src$/u, ""),
        stdio: "pipe",
        timeout: 8_000,
      })
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        mode: "applied",
        revision: 1,
        createdTags: 1,
        changedBindings: 1,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)
  it("手工重加的受管理标签不会被下一次导入删除，取关记录不写入", () => {
    const store = fixture()
    const accounts = [{ id: "n", username: "example", tags: ["AI"] }]
    const first = applyNotionSourceImport(store, accounts, 0)
    const tag = store.subscriptionTags.snapshot().tags[0]!
    const manual = store.subscriptionTags.updateBindings({
      expectedRevision: first.revision,
      sourceKeys: [feed.key],
      tagIds: [tag.id],
      operation: "add",
    })
    expect(manual.revision).toBe(first.revision + 1)
    applyNotionSourceImport(store, [{ ...accounts[0]!, tags: [] }], manual.revision)
    expect(store.subscriptionTags.sourceTagBindings([feed.key]).bindings[0]?.tagIds).toContain(
      tag.id,
    )
    const preview = previewNotionSourceImport(store, [
      { ...accounts[0]!, active: false, tags: ["个人成长"] },
    ])
    expect(preview.rows[0]?.status).toBe("not_in_plan")
    expect(
      applyNotionSourceImport(
        store,
        [{ ...accounts[0]!, active: false, tags: ["个人成长"] }],
        preview.revision,
      ).createdTags,
    ).toBe(0)
  })

  it("规范化真实账号身份，支持带逗号标签的 CSV", () => {
    expect(normalizeXUsername("https://twitter.com/Example/")).toBe("example")
    expect(normalizeXUsername("显示名")).toBeNull()
    expect(
      parseNotionSourceAccounts(
        'Username,Link,Tags\n@Example,https://x.com/example,"AI,Crypto"\n',
        "csv",
      ),
    ).toEqual([
      { id: "csv:2", username: "@Example", url: "https://x.com/example", tags: ["AI", "Crypto"] },
    ])
  })
  it("预览不写入；只替换受管理标签并保留手工标签，拒绝过期 revision", () => {
    const store = fixture()
    const manual = store.subscriptionTags.create("手工", 0)
    store.subscriptionTags.updateBindings({
      expectedRevision: manual.revision,
      sourceKeys: [feed.key],
      tagIds: [manual.tags[0]!.id],
      operation: "add",
    })
    const accounts = [{ id: "notion:1", username: "@Example", tags: ["AI", "Crypto"] }]
    const preview = previewNotionSourceImport(store, accounts)
    expect(preview.rows[0]).toMatchObject({
      status: "awaiting_fetch",
      add: ["AI", "Crypto"],
      remove: [],
    })
    expect(store.subscriptionTags.snapshot().tags.map((tag) => tag.name)).toEqual(["手工"])
    const first = applyNotionSourceImport(store, accounts, preview.revision)
    const changed = [{ ...accounts[0]!, tags: ["个人成长"] }]
    expect(previewNotionSourceImport(store, changed).rows[0]?.remove).toEqual(["AI", "Crypto"])
    expect(() => applyNotionSourceImport(store, changed, preview.revision)).toThrow(
      "revision_conflict",
    )
    applyNotionSourceImport(store, changed, first.revision)
    const snapshot = store.subscriptionTags.snapshot()
    const ids = store.subscriptionTags.sourceTagBindings([feed.key]).bindings[0]!.tagIds
    expect(
      snapshot.tags
        .filter((tag) => ids.includes(tag.id))
        .map((tag) => tag.name)
        .sort(),
    ).toEqual(["个人成长", "手工"].sort())
  })
  it("多路由与重复登记均列出冲突，不静默绑定；稳定 ID 不退回改名后的 username", () => {
    const store = fixture()
    store.replaceSources([feed, { ...feed, key: "feed/second", id: "second" }])
    const accounts = [{ id: "n", username: "example", tags: ["AI"] }]
    const report = previewNotionSourceImport(store, accounts)
    expect(report.rows[0]?.status).toBe("identity_conflict")
    expect(applyNotionSourceImport(store, accounts, report.revision).changedBindings).toBe(0)
    store.replaceSources([{ ...feed, xUserId: "123" }])
    expect(
      previewNotionSourceImport(store, [{ ...accounts[0]!, userId: "456" }]).rows[0]?.status,
    ).toBe("source_missing")
    expect(
      previewNotionSourceImport(store, [...accounts, { ...accounts[0]!, id: "n2" }]).rows.every(
        (row) => row.status === "identity_conflict",
      ),
    ).toBe(true)
  })
  it("对账区分抓取错误、未纳入、正文待补与可处理", () => {
    const store = fixture()
    const accounts = [{ id: "n", username: "example", tags: [] }]
    store.sourceSync.fail(feed.key, "2026-01-01T00:00:00Z", new Date().toISOString(), "network")
    expect(previewNotionSourceImport(store, accounts).rows[0]).toMatchObject({
      status: "fetch_error",
      failure: "network",
    })
    store.sourceSync.savePage({
      sourceKey: feed.key,
      historySince: "2026-01-01T00:00:00Z",
      cursor: null,
      coverage: "end",
      pending: false,
      now: new Date().toISOString(),
    })
    expect(previewNotionSourceImport(store, accounts).rows[0]?.status).toBe("ready")
    store.saveEntry({
      id: "e",
      sourceKey: feed.key,
      title: "图片消息",
      url: "https://x.com/example/status/1",
      publishedAt: "2026-02-01T00:00:00Z",
      read: false,
      content: '<p>图表说明</p><img src="https://example/image">',
      description: null,
    })
    expect(previewNotionSourceImport(store, accounts).rows[0]?.status).toBe("needs_context")
    const snapshot = store.schedule.snapshot()
    store.schedule.save(
      {
        ...snapshot.config!,
        scope: { mode: "fixed", sourceKeys: ["feed/other"] },
        sourceKeys: ["feed/other"],
      },
      snapshot.revision,
    )
    expect(previewNotionSourceImport(store, accounts).rows[0]?.status).toBe("not_in_plan")
  })
  it("Notion 清单分页读取，不查询逐篇内容；失败拒绝半份数据", async () => {
    const row = {
      id: "n",
      properties: {
        Username: { rich_text: [{ plain_text: "@Example" }] },
        Tags: { multi_select: [{ name: "AI" }] },
      },
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [row], has_more: true, next_cursor: "next" })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null })),
      )
    expect(
      await readNotionSourceAccounts("secret", "11111111-1111-1111-1111-111111111111", fetcher),
    ).toEqual([{ id: "n", username: "@Example", tags: ["AI"] }])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      start_cursor: "next",
    })
    await expect(
      readNotionSourceAccounts(
        "secret",
        "11111111-1111-1111-1111-111111111111",
        vi.fn<typeof fetch>().mockResolvedValue(new Response("error", { status: 403 })),
      ),
    ).rejects.toThrow("notion_read_403")
  })
})
