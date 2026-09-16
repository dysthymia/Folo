import { afterEach, describe, expect, it, vi } from "vitest"

import type { CodexJsonOptions, runCodexJson } from "./codex"
import type { Page, Source, SourceEntry } from "./folo"
import { FoloReader, FoloReadError } from "./folo"
import { InformationService, sourceText } from "./service"
import { Store } from "./store"

const source: Source = {
  key: "feed/f1",
  kind: "feed",
  id: "f1",
  title: "来源",
  view: 0,
  category: null,
}
const makeEntry = (id: string, day: number, overrides: Partial<SourceEntry> = {}): SourceEntry => ({
  id,
  sourceKey: source.key,
  title: "文章",
  url: "https://example.test/article",
  publishedAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  read: true,
  content: "<p>来源正文</p>",
  description: null,
  ...overrides,
})
const page = (entries: SourceEntry[], pageFull: boolean): Page => ({
  entries,
  pageFull,
  nextCursor: entries.at(-1)?.publishedAt ?? null,
  boundaryCount: entries.filter((entry) => entry.publishedAt === entries.at(-1)?.publishedAt)
    .length,
})
const stores: Store[] = []

const fixture = () => {
  const store = new Store(":memory:")
  stores.push(store)
  const reader = new FoloReader({
    apiUrl: "https://api.example.test",
    token: "test-token",
    fetch: async () => {
      throw new Error("Unexpected network request")
    },
  })
  const session = vi
    .spyOn(reader, "session")
    .mockResolvedValue({ ownerId: "owner", expiresAt: null })
  const sources = vi.spyOn(reader, "sources").mockResolvedValue([source])
  const pages = vi.spyOn(reader, "page")
  const detail = vi.spyOn(reader, "detail").mockImplementation(async (_source, entry) => entry)
  const readability = vi.spyOn(reader, "readability").mockResolvedValue(null)
  const prompts: string[] = []
  // 泛型替身也执行调用方校验器，避免用类型断言掩盖结构化输出契约错误。
  const execute: typeof runCodexJson = async <T>(options: CodexJsonOptions<T>) => {
    prompts.push(options.prompt)
    const output: unknown = { summary: "已验证摘要", points: ["已验证要点"], entryId: "e1" }
    if (!options.validate(output)) throw new Error("Invalid fixture model output")
    return { result: output, model: options.model, durationMs: 10, usage: null, toolCalls: 0 }
  }
  const service = new InformationService({
    store,
    reader: async () => reader,
    runtimeDir: "/unused-mock-runtime",
    execute,
  })
  const signal = new AbortController().signal
  return { store, service, reader, session, sources, pages, detail, readability, prompts, signal }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})

describe("InformationService scan", () => {
  it("逐页获取详情，并只在整页完成后推进持久化水位", async () => {
    const { store, service, pages, detail, signal } = fixture()
    const first = makeEntry("e1", 8, { content: null })
    const second = makeEntry("e2", 7, { content: null })
    const third = makeEntry("e3", 6, { content: null })
    const job = store.enqueue({ kind: "scan", sourceKey: source.key, limit: 2, pages: 3 })
    pages
      .mockResolvedValueOnce(page([first, second], true))
      .mockImplementationOnce(async (_source, options) => {
        expect(options.cursor).toBe(second.publishedAt)
        expect(store.job(job.id)).toMatchObject({ pages: 1, cursor: second.publishedAt })
        expect(store.entry(source.key, first.id)?.content).toBe("<p>完整 e1</p>")
        return page([third], false)
      })
    detail.mockImplementation(async (_source, entry) => {
      if (entry.id === "e2") expect(store.entry(source.key, "e1")).toBeNull()
      return { ...entry, content: `<p>完整 ${entry.id}</p>` }
    })
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({
      status: "succeeded",
      pages: 2,
      coverage: "end",
      cursor: third.publishedAt,
    })
    expect(detail).toHaveBeenCalledTimes(3)
    expect(store.entry(source.key, third.id)?.content).toBe("<p>完整 e3</p>")
  })

  it("页内详情失败不留下半页数据，重新排队后从已提交游标继续", async () => {
    const { store, service, pages, detail, signal } = fixture()
    const first = makeEntry("e1", 8)
    const previous = makeEntry("e0", 7)
    const second = makeEntry("e2", 6)
    const third = makeEntry("e3", 5)
    const job = store.enqueue({ kind: "scan", sourceKey: source.key, limit: 2, pages: 3 })
    pages
      .mockResolvedValueOnce(page([first, previous], true))
      .mockResolvedValueOnce(page([second, third], true))
    detail
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new FoloReadError("unauthorized", 401))
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({
      status: "failed",
      error: "folo_unauthorized",
      pages: 1,
      cursor: previous.publishedAt,
    })
    expect(store.entry(source.key, first.id)).toEqual(first)
    expect(store.entry(source.key, second.id)).toBeNull()
    expect(store.entry(source.key, third.id)).toBeNull()

    const resumed = store.job(job.id)!
    resumed.status = "queued"
    store.saveJob(resumed)
    pages
      .mockImplementationOnce(async (_source, options) => {
        expect(options.cursor).toBe(previous.publishedAt)
        return page([second, third], true)
      })
      .mockResolvedValueOnce(page([], false))
    await service.run(resumed, signal)
    expect(store.job(job.id)).toMatchObject({
      status: "succeeded",
      error: null,
      pages: 3,
      cursor: third.publishedAt,
    })
    expect(store.entry(source.key, second.id)).toEqual(second)
  })

  it("同时间游标不前进时停止，保留可疑边界而不跳过它", async () => {
    const { store, service, pages, detail, signal } = fixture()
    const first = makeEntry("e1", 8)
    const second = makeEntry("e2", 8)
    const third = makeEntry("e3", 8)
    const job = store.enqueue({ kind: "scan", sourceKey: source.key, limit: 2, pages: 3 })
    pages
      .mockResolvedValueOnce(page([first, second], true))
      .mockResolvedValueOnce(page([third, makeEntry("e4", 8)], true))
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({
      status: "failed",
      error: "pagination_stalled",
      coverage: "timestamp_boundary",
      pages: 1,
      cursor: first.publishedAt,
    })
    expect(detail).toHaveBeenCalledTimes(2)
    expect(store.entry(source.key, third.id)).toBeNull()
  })

  it("页面提交失败后不能把已回滚页面的内存水位再次保存", async () => {
    const { store, service, pages, signal } = fixture()
    const job = store.enqueue({ kind: "scan", sourceKey: source.key, limit: 1, pages: 1 })
    pages.mockResolvedValueOnce(page([makeEntry("e1", 8)], true))
    const saveJob = store.saveJob.bind(store)
    vi.spyOn(store, "saveJob")
      .mockImplementation(saveJob)
      .mockImplementationOnce(saveJob)
      .mockImplementationOnce(() => {
        throw new Error("simulated commit write failure")
      })
    await service.run(job, signal)
    expect(store.entry(source.key, "e1")).toBeNull()
    expect(store.job(job.id)).toMatchObject({ status: "failed", pages: 0, cursor: null })
  })

  it("后续短页不能抹掉前页已发现的时间边界覆盖缺口", async () => {
    const { store, service, pages, signal } = fixture()
    const job = store.enqueue({ kind: "scan", sourceKey: source.key, limit: 2, pages: 3 })
    pages
      .mockResolvedValueOnce(page([makeEntry("e1", 8), makeEntry("e2", 8)], true))
      .mockResolvedValueOnce(page([makeEntry("e3", 7)], false))
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({
      status: "succeeded",
      pages: 2,
      coverage: "timestamp_boundary",
    })
  })

  it("达到页预算只完成本批，不把来源标成扫描到底", async () => {
    const { store, service, pages, signal } = fixture()
    const job = store.enqueue({ kind: "scan", sourceKey: source.key, limit: 1, pages: 1 })
    pages.mockResolvedValueOnce(page([makeEntry("e1", 8)], true))
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({ status: "succeeded", pages: 1, coverage: "budget" })
    expect(pages).toHaveBeenCalledTimes(1)
  })

  it("拒绝倒序异常的页面，避免错误水位写入", async () => {
    const { store, service, pages, detail, signal } = fixture()
    const job = store.enqueue({ kind: "scan", sourceKey: source.key })
    pages.mockResolvedValueOnce(page([makeEntry("older", 7), makeEntry("newer", 8)], false))
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({ error: "pagination_order", pages: 0, cursor: null })
    expect(detail).not.toHaveBeenCalled()
  })

  it("账号变化时阻止同步，保留原账号来源和数据", async () => {
    const { store, service, session, sources, pages, signal } = fixture()
    store.bindOwner("original")
    store.replaceSources([source])
    session.mockResolvedValue({ ownerId: "different", expiresAt: null })
    const job = store.enqueue({ kind: "scan", sourceKey: source.key })
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({ status: "failed", error: "account_changed" })
    expect(store.ownerId).toBe("original")
    expect(store.sources()).toEqual([source])
    expect(sources).not.toHaveBeenCalled()
    expect(pages).not.toHaveBeenCalled()
  })

  it("撤销来源授权后不读取其历史条目", async () => {
    const { store, service, sources, pages, signal } = fixture()
    sources.mockResolvedValue([])
    const job = store.enqueue({ kind: "scan", sourceKey: source.key })
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({ error: "source_not_authorized" })
    expect(pages).not.toHaveBeenCalled()
  })
})

describe("InformationService model input", () => {
  it("邮箱无正文时只使用邮件描述，不触发网页正文提取", async () => {
    const { store, service, sources, readability, prompts, signal } = fixture()
    const inbox: Source = { ...source, key: "inbox/i1", id: "i1", kind: "inbox" }
    sources.mockResolvedValue([inbox])
    store.saveEntry(
      makeEntry("e1", 8, { sourceKey: inbox.key, content: null, description: "邮件描述" }),
    )
    const job = store.enqueue({
      kind: "process",
      sourceKey: inbox.key,
      itemId: "e1",
      model: "test-model",
    })
    await service.run(job, signal)
    expect(readability).not.toHaveBeenCalled()
    expect(store.job(job.id)?.status).toBe("succeeded")
    expect(prompts[0]).toContain("邮件描述")
  })

  it("详情缺正文时读取官方正文，保存实际材料后调用模型", async () => {
    const { store, service, readability, prompts, signal } = fixture()
    store.saveEntry(makeEntry("e1", 8, { content: null }))
    readability.mockResolvedValue("<p>官方提取正文</p><script>不能执行</script>")
    const job = store.enqueue({
      kind: "process",
      sourceKey: source.key,
      itemId: "e1",
      model: "test-model",
    })
    await service.run(job, signal)
    expect(readability).toHaveBeenCalledWith("e1")
    expect(store.job(job.id)?.status).toBe("succeeded")
    expect(store.entry(source.key, "e1")?.content).toContain("官方提取正文")
    expect(store.snapshot().results[0]?.material).toBe("source_text")
    expect(prompts[0]).toContain("官方提取正文")
    expect(prompts[0]).not.toContain("不能执行")
  })

  it("官方正文读取认证失败时保留失败，不以描述继续调用模型", async () => {
    const { store, service, readability, prompts, signal } = fixture()
    store.saveEntry(makeEntry("e1", 8, { content: null, description: "已有描述" }))
    readability.mockRejectedValue(new FoloReadError("unauthorized"))
    const job = store.enqueue({
      kind: "process",
      sourceKey: source.key,
      itemId: "e1",
      model: "test-model",
    })
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({ status: "failed", error: "folo_unauthorized" })
    expect(prompts).toHaveLength(0)
  })

  it("HTML 材料去除脚本、样式和嵌入页面，保留段落文本", () => {
    const text = sourceText(
      '<p>第一段</p><script>secretScript()</script><style>.secret-style{}</style><noscript>secret fallback</noscript><iframe src="https://example.test">secret frame</iframe><p>第二段 &amp; 内容</p>',
    )
    expect(text).toContain("第一段\n")
    expect(text).toContain("第二段 & 内容")
    expect(text).not.toMatch(/secret|script|iframe/)
  })

  it("只有描述时显式标记 description_only，不能声称拥有正文", async () => {
    const { store, service, prompts, signal } = fixture()
    store.saveEntry(
      makeEntry("e1", 8, {
        content: "<script>无效正文</script>",
        description: "<p>仅有来源描述</p>",
      }),
    )
    const job = store.enqueue({
      kind: "process",
      sourceKey: source.key,
      itemId: "e1",
      model: "test-model",
    })
    await service.run(job, signal)
    expect(store.job(job.id)?.status).toBe("succeeded")
    expect(store.snapshot().results[0]?.material).toBe("description_only")
    const material: unknown = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf("\n") + 1))
    expect(material).toMatchObject({ material: "description_only", text: "仅有来源描述" })
    expect(prompts[0]).not.toContain("无效正文")
  })

  it.each([
    { content: null, description: null, error: "material_missing" },
    { content: `<p>${"文".repeat(60_001)}</p>`, description: null, error: "needs_context" },
  ])("缺材料或超长内容不会调用模型", async ({ content, description, error }) => {
    const { store, service, prompts, signal } = fixture()
    store.saveEntry(makeEntry("e1", 8, { content, description }))
    const job = store.enqueue({
      kind: "process",
      sourceKey: source.key,
      itemId: "e1",
      model: "test-model",
    })
    await service.run(job, signal)
    expect(store.job(job.id)).toMatchObject({ status: "failed", error })
    expect(prompts).toHaveLength(0)
    expect(store.snapshot().results).toHaveLength(0)
  })

  it("同材料与模型幂等，材料变化后才生成新结果", async () => {
    const { store, service, prompts, detail, signal } = fixture()
    store.saveEntry(makeEntry("e1", 8))
    const enqueue = () =>
      store.enqueue({ kind: "process", sourceKey: source.key, itemId: "e1", model: "test-model" })
    const first = enqueue()
    await service.run(first, signal)
    const duplicate = enqueue()
    await service.run(duplicate, signal)
    expect(store.job(first.id)?.status).toBe("succeeded")
    expect(store.job(duplicate.id)?.status).toBe("succeeded")
    expect(prompts).toHaveLength(1)
    expect(store.snapshot().results).toHaveLength(1)

    detail.mockResolvedValueOnce(makeEntry("e1", 8, { content: "<p>来源修订后的正文</p>" }))
    await service.run(enqueue(), signal)
    expect(prompts).toHaveLength(2)
    expect(store.snapshot().results).toHaveLength(2)
  })
})
