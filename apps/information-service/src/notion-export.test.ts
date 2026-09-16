import { randomUUID } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import { join } from "pathe"
import { afterEach, describe, expect, it } from "vitest"

import type { ExportableRecord } from "./export-store"
import { ExportStore } from "./export-store"
import { ExternalApiService } from "./external-api"
import { publicSettings, readExternalConfig } from "./external-config"
import type { SourceEntry } from "./folo"
import type { NotionFetcher } from "./notion-export"
import { NotionExportService } from "./notion-export"
import { Store } from "./store"

const databases: DatabaseSync[] = []
const stores: Store[] = []
const temporaryDirectories: string[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  stores.splice(0).forEach((store) => store.close())
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true }))
})

function exportFixture(markdown = "# 研究包") {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const exports = new ExportStore(database, () => "owner")
  const storyId = randomUUID()
  const destinationId = randomUUID()
  return {
    exports,
    storyId,
    destinationId,
    record: exports.prepare(storyId, 3, destinationId, markdown),
  }
}

function fetchSequence(responses: Array<Response | Error>) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher: NotionFetcher = async (input, init) => {
    requests.push({ url: String(input), init })
    const next = responses.shift()
    if (!next) throw new Error("unexpected_notion_request")
    if (next instanceof Error) throw next
    return next
  }
  return { fetcher, requests }
}

function blocksFrom(request: { init: RequestInit | undefined }) {
  return (
    JSON.parse(String(request.init?.body)) as {
      children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }>
    }
  ).children
}

function remoteSection(record: ExportableRecord) {
  const subject = record.kind === "story" ? `story=${record.storyId}` : "entry"
  const start = `Folo export start v1 ${subject} revision=${record.revision} sha256=${record.contentHash} blocks=1`
  const end = `Folo export end v1 ${subject} revision=${record.revision} sha256=${record.contentHash} blocks=1`
  return [start, `Folo 导出版本 r${record.revision}`, record.markdown, end].map((content) => ({
    type: "paragraph",
    paragraph: { rich_text: [{ plain_text: content }] },
  }))
}

describe("Notion 手动导出", () => {
  it("首次确认按每次最多 100 个 children 分批写入，并冻结同一份 outbox 正文", async () => {
    const { exports, record } = exportFixture("x".repeat(1_900 * 101))
    const { fetcher, requests } = fetchSequence([
      new Response(JSON.stringify({ id: "notion-page" }), { status: 200 }),
      new Response(JSON.stringify({}), { status: 200 }),
    ])

    const result = await new NotionExportService(exports, "private-test-token", fetcher).confirm(
      record.id,
    )

    expect(result).toMatchObject({ status: "succeeded", notionPageId: "notion-page" })
    expect(requests).toHaveLength(2)
    expect(requests[0]!.url).toBe("https://api.notion.com/v1/pages")
    expect(requests[1]!.url).toBe("https://api.notion.com/v1/blocks/notion-page/children")
    for (const request of requests) {
      const children = blocksFrom(request)
      expect(children.length).toBeLessThanOrEqual(100)
      expect(
        children.every((block) => block.paragraph.rich_text[0]!.text.content.length <= 1_900),
      ).toBe(true)
    }
    expect(exports.get(record.id)?.contentHash).toBe(record.contentHash)
  })

  it("核查必须验证 marker、正文块数量和内容哈希，不能只因页面存在就成功", async () => {
    const { exports, record } = exportFixture("待核查正文")
    const { fetcher, requests } = fetchSequence([new Error("timeout")])
    const service = new NotionExportService(exports, "private-test-token", fetcher)

    expect(await service.confirm(record.id)).toMatchObject({
      status: "unknown",
      error: "network_outcome_unknown",
    })
    await service.confirm(record.id)
    expect(requests).toHaveLength(1)

    const known = exports.update(record.id, "unknown", { notionPageId: "notion-page" })
    const checked = fetchSequence([
      new Response(JSON.stringify({ results: remoteSection(known), has_more: false }), {
        status: 200,
      }),
    ])
    expect(
      await new NotionExportService(exports, "private-test-token", checked.fetcher).reconcile(
        known.id,
      ),
    ).toMatchObject({ status: "succeeded", notionPageId: "notion-page" })

    const incomplete = exports.prepare(record.storyId, 4, record.destinationId, "另一版本")
    const broken = fetchSequence([
      new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 }),
    ])
    expect(
      await new NotionExportService(exports, "private-test-token", broken.fetcher).reconcile(
        exports.update(incomplete.id, "unknown", { notionPageId: "notion-page" }).id,
      ),
    ).toMatchObject({ status: "unknown", error: "reconcile_marker_incomplete" })
  })

  it("同一 Story 和目标页的新修订追加到稳定页面，切换目标页则创建新的不可变导出", async () => {
    const { exports, storyId, destinationId, record } = exportFixture("第一版")
    const created = fetchSequence([
      new Response(JSON.stringify({ id: "notion-page" }), { status: 200 }),
    ])
    expect(
      await new NotionExportService(exports, "private-test-token", created.fetcher).confirm(
        record.id,
      ),
    ).toMatchObject({ status: "succeeded", operation: "create", notionPageId: "notion-page" })

    const next = exports.prepare(storyId, 4, destinationId, "第二版")
    expect(next).toMatchObject({
      operation: "append",
      notionPageId: "notion-page",
      status: "prepared",
    })
    const appended = fetchSequence([new Response(JSON.stringify({}), { status: 200 })])
    expect(
      await new NotionExportService(exports, "private-test-token", appended.fetcher).confirm(
        next.id,
      ),
    ).toMatchObject({ status: "succeeded", operation: "append", notionPageId: "notion-page" })
    expect(appended.requests[0]!.url).toBe("https://api.notion.com/v1/blocks/notion-page/children")

    const otherDestination = exports.prepare(storyId, 5, randomUUID(), "第三版")
    expect(otherDestination).toMatchObject({ operation: "create", notionPageId: null })
  })

  it("限流会保留 retry_after，已成功的记录不会被核查接口降级", async () => {
    const { exports, record } = exportFixture()
    const limited = fetchSequence([
      new Response(JSON.stringify({}), { status: 429, headers: { "retry-after": "30" } }),
    ])
    const retried = await new NotionExportService(
      exports,
      "private-test-token",
      limited.fetcher,
    ).confirm(record.id)
    expect(retried).toMatchObject({ status: "retry_after" })
    expect(retried.retryAfter).not.toBeNull()

    const successful = exports.markSucceeded(record.id, "notion-page")
    const noNetwork = fetchSequence([])
    expect(
      await new NotionExportService(exports, "private-test-token", noNetwork.fetcher).reconcile(
        successful.id,
      ),
    ).toMatchObject({ status: "succeeded" })
    expect(noNetwork.requests).toHaveLength(0)
  })

  it("相同单篇内容版本与目标页会复用 Folo 页面并追加新冻结版本", async () => {
    const database = new DatabaseSync(":memory:")
    databases.push(database)
    const exports = new ExportStore(database, () => "owner")
    const entry = {
      inputSeq: 7,
      sourceKey: "feed/f1",
      itemId: "entry-1",
      contentVersion: "content-v1",
      title: "单篇标题",
    }
    const destinationId = randomUUID()
    const first = exports.prepareEntry(entry, destinationId, "第一份冻结内容")
    const created = fetchSequence([
      new Response(JSON.stringify({ id: "entry-page" }), { status: 200 }),
    ])
    expect(
      await new NotionExportService(exports, "private-test-token", created.fetcher).confirm(
        first.id,
      ),
    ).toMatchObject({ status: "succeeded", operation: "create" })

    const second = exports.prepareEntry(entry, destinationId, "第二份冻结内容")
    expect(second).toMatchObject({ operation: "append", notionPageId: "entry-page", revision: 2 })
    const appended = fetchSequence([new Response(JSON.stringify({}), { status: 200 })])
    expect(
      await new NotionExportService(exports, "private-test-token", appended.fetcher).confirm(
        second.id,
      ),
    ).toMatchObject({ status: "succeeded", operation: "append", notionPageId: "entry-page" })
    expect(appended.requests[0]!.url).toBe("https://api.notion.com/v1/blocks/entry-page/children")
  })

  it("单篇条目按稳定来源身份映射，targetPageId 会直接追加到该现有页面", async () => {
    const directory = mkdtempSync(join(tmpdir(), "folo-entry-export-"))
    temporaryDirectories.push(directory)
    const configPath = join(directory, "external.json")
    const store = new Store(":memory:")
    stores.push(store)
    store.bindOwner("owner")
    const created = fetchSequence([new Response(JSON.stringify({}), { status: 200 })])
    const api = new ExternalApiService({ store, configPath, fetcher: created.fetcher })
    const destinationId = randomUUID()
    await api.handle("PUT", "/integrations/settings", {
      notion: { token: "private-test-token", parentPageId: randomUUID(), enabled: true },
    })
    const first: SourceEntry = {
      id: "entry-1",
      sourceKey: "feed/f1",
      title: "单篇标题",
      url: "https://example.test/entry-1",
      publishedAt: "2026-01-01T00:00:00.000Z",
      read: false,
      content: "第一版正文",
      description: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    store.saveEntry(first)
    const prepared = await api.handle("POST", "/exports/entries", {
      inputSeq: store.automation.inputs()[0]!.seq,
      targetPageId: destinationId,
    })
    expect(prepared).toMatchObject({
      export: {
        kind: "entry",
        operation: "append",
        targetMode: "page",
        destinationId,
        notionPageId: destinationId,
      },
      preview: {
        kind: "entry",
        title: "单篇标题",
        markdown: expect.stringContaining("第一版正文"),
      },
    })
    const id = (prepared as { export: { id: string } }).export.id
    expect(await api.handle("POST", `/exports/${id}/confirm`, {})).toMatchObject({
      export: { status: "succeeded", notionPageId: destinationId },
    })
    expect(created.requests[0]!.url).toBe(
      `https://api.notion.com/v1/blocks/${destinationId}/children`,
    )

    store.saveEntry({ ...first, content: "第二版正文", updatedAt: "2026-01-02T00:00:00.000Z" })
    const changed = await api.handle("POST", "/exports/entries", {
      inputSeq: store.automation.inputs().at(-1)!.seq,
      targetPageId: destinationId,
    })
    expect(changed).toMatchObject({
      export: {
        kind: "entry",
        operation: "append",
        targetMode: "page",
        notionPageId: destinationId,
        revision: 2,
      },
    })
  })

  it("设置写入为 0600 且公开响应不含 token；空 token 保留既有凭据", async () => {
    const directory = mkdtempSync(join(tmpdir(), "folo-external-"))
    temporaryDirectories.push(directory)
    const configPath = join(directory, "external.json")
    const store = new Store(":memory:")
    stores.push(store)
    store.bindOwner("owner")
    let calls = 0
    const api = new ExternalApiService({
      store,
      configPath,
      fetcher: async () => {
        calls += 1
        return new Response()
      },
    })

    expect(await api.handle("POST", "/exports", { storyId: randomUUID() })).toEqual({
      disabled: true,
      integrations: { notion: { enabled: false, parentPageId: null } },
    })
    const parentPageId = randomUUID()
    const written = await api.handle("PUT", "/integrations/settings", {
      notion: { token: "private-test-token", parentPageId, enabled: true },
    })
    expect(written).toEqual({ integrations: { notion: { enabled: true, parentPageId } } })
    expect(JSON.stringify(written)).not.toContain("private-test-token")
    expect(readExternalConfig(configPath)?.notion.token).toBe("private-test-token")
    expect(statSync(configPath).mode & 0o777).toBe(0o600)

    const disabled = await api.handle("PUT", "/integrations/settings", {
      notion: { token: "", enabled: false },
    })
    expect(disabled).toEqual({ integrations: { notion: { enabled: false, parentPageId } } })
    expect(readExternalConfig(configPath)?.notion.token).toBe("private-test-token")
    expect(publicSettings(configPath)).not.toHaveProperty("notion.token")
    expect(calls).toBe(0)

    chmodSync(configPath, 0o644)
    expect(publicSettings(configPath)).toEqual({
      notion: { enabled: false, parentPageId: null },
    })
  })
})
