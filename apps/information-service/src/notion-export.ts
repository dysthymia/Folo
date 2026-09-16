import type { ExportableRecord, ExportStore } from "./export-store"

export type NotionFetcher = typeof fetch

const NOTION_API = "https://api.notion.com/v1"
const NOTION_VERSION = "2026-03-11"
const MAX_RICH_TEXT_LENGTH = 1_900
const MAX_CHILDREN_PER_REQUEST = 100
const MAX_RECONCILE_PAGES = 100

type NotionBlock = {
  object: "block"
  type: "paragraph"
  paragraph: { rich_text: Array<{ type: "text"; text: { content: string } }> }
}
type NotionPage = { id?: unknown; parent?: { type?: unknown; page_id?: unknown } }
type NotionBlockList = {
  results?: unknown
  has_more?: unknown
  next_cursor?: unknown
}
type Inspection = "complete" | "incomplete" | "retry_after" | "unknown"

function paragraphBlocks(markdown: string): NotionBlock[] {
  const output: NotionBlock[] = []
  let chunk = ""
  for (const character of markdown) {
    if (chunk.length === MAX_RICH_TEXT_LENGTH) {
      output.push(paragraph(chunk))
      chunk = ""
    }
    chunk += character
  }
  if (chunk || output.length === 0) output.push(paragraph(chunk || " "))
  return output
}

function paragraph(content: string): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  }
}

function batches<T>(items: T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / MAX_CHILDREN_PER_REQUEST) }, (_, index) =>
    items.slice(index * MAX_CHILDREN_PER_REQUEST, (index + 1) * MAX_CHILDREN_PER_REQUEST),
  )
}

function retryAt(response: Response): string {
  const seconds = Number(response.headers.get("retry-after"))
  return new Date(Date.now() + (Number.isFinite(seconds) ? seconds : 60) * 1_000).toISOString()
}

function marker(record: ExportableRecord, blockCount: number, boundary: "start" | "end"): string {
  const subject = record.kind === "story" ? `story=${record.storyId}` : "entry"
  return [
    "Folo export",
    boundary,
    "v1",
    subject,
    `revision=${record.revision}`,
    `sha256=${record.contentHash}`,
    `blocks=${blockCount}`,
  ].join(" ")
}

function section(record: ExportableRecord): NotionBlock[] {
  const content = paragraphBlocks(record.markdown)
  return [
    paragraph(marker(record, content.length, "start")),
    paragraph(`Folo 导出版本 r${record.revision}`),
    ...content,
    paragraph(marker(record, content.length, "end")),
  ]
}

function textOf(block: unknown): string | null {
  if (!block || typeof block !== "object") return null
  const candidate = block as {
    paragraph?: { rich_text?: Array<{ plain_text?: unknown; text?: { content?: unknown } }> }
  }
  const richText = candidate.paragraph?.rich_text
  if (!Array.isArray(richText)) return null
  return richText
    .map((part) => (typeof part.plain_text === "string" ? part.plain_text : part.text?.content))
    .filter((part): part is string => typeof part === "string")
    .join("")
}

// 仅在用户确认后写入 Notion。网络结果不明确时宁可等待核查，也不重复创建页面。
export class NotionExportService {
  constructor(
    private readonly exports: ExportStore,
    private readonly token: string,
    private readonly fetcher: NotionFetcher = fetch,
  ) {}

  async confirm(id: string): Promise<ExportableRecord> {
    const record = this.exports.get(id)
    if (!record) throw new NotionExportError("export_not_found")
    if (record.status === "succeeded" || record.status === "unknown") return record
    if (record.operation === "append") {
      if (!record.notionPageId)
        return this.exports.update(id, "unknown", { error: "topic_mapping_missing" })
      return this.appendSection(record, record.notionPageId)
    }
    if (record.notionPageId) return record
    return this.createPage(record)
  }

  async reconcile(id: string): Promise<ExportableRecord> {
    let record = this.exports.get(id)
    if (!record) throw new NotionExportError("export_not_found")
    if (record.status === "succeeded") return record
    if (!record.notionPageId) {
      const pageId = await this.findPageByMarker(record)
      if (!pageId)
        return this.exports.update(id, "unknown", { error: "reconcile_marker_not_found" })
      record = this.exports.update(id, "unknown", { notionPageId: pageId })
    }

    const pageId = record.notionPageId
    if (!pageId) return this.exports.update(id, "unknown", { error: "reconcile_marker_not_found" })
    const inspected = await this.inspectSection(record, pageId)
    if (inspected === "complete") return this.exports.markSucceeded(id, pageId)
    if (inspected === "retry_after") {
      return this.exports.update(id, "retry_after", {
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
      })
    }
    return this.exports.update(id, "unknown", {
      error: inspected === "incomplete" ? "reconcile_marker_incomplete" : "reconcile_unknown",
    })
  }

  private async createPage(record: ExportableRecord): Promise<ExportableRecord> {
    const blockBatches = batches(section(record))
    this.exports.update(record.id, "sending")
    try {
      const response = await this.fetcher(`${NOTION_API}/pages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          parent: { type: "page_id", page_id: record.destinationId },
          properties: {
            title: {
              title: [
                {
                  type: "text",
                  text: {
                    content:
                      record.kind === "story"
                        ? `Folo Story ${record.storyId} r${record.revision}`
                        : `Folo Entry ${record.entry.title} r${record.revision}`.slice(0, 1_900),
                  },
                },
              ],
            },
          },
          children: blockBatches[0],
        }),
      })
      if (response.status === 429 || response.status === 529)
        return this.exports.update(record.id, "retry_after", { retryAfter: retryAt(response) })
      if (!response.ok)
        return this.exports.update(record.id, response.status >= 500 ? "unknown" : "failed", {
          error: `notion_${response.status}`,
        })

      const payload = (await response.json()) as NotionPage
      if (typeof payload.id !== "string")
        return this.exports.update(record.id, "unknown", { error: "notion_response_unknown" })
      this.exports.update(record.id, "sending", { notionPageId: payload.id })
      return this.appendBatches(record, payload.id, blockBatches.slice(1))
    } catch {
      return this.exports.update(record.id, "unknown", { error: "network_outcome_unknown" })
    }
  }

  private async appendSection(record: ExportableRecord, pageId: string): Promise<ExportableRecord> {
    this.exports.update(record.id, "sending", { notionPageId: pageId })
    return this.appendBatches(record, pageId, batches(section(record)))
  }

  private async appendBatches(
    record: ExportableRecord,
    pageId: string,
    blockBatches: NotionBlock[][],
  ): Promise<ExportableRecord> {
    try {
      for (const children of blockBatches) {
        const append = await this.fetcher(`${NOTION_API}/blocks/${pageId}/children`, {
          method: "PATCH",
          headers: this.headers(),
          body: JSON.stringify({ children }),
        })
        if (append.status === 429 || append.status === 529)
          return this.exports.update(record.id, "retry_after", {
            notionPageId: pageId,
            retryAfter: retryAt(append),
          })
        if (!append.ok)
          return this.exports.update(record.id, "unknown", {
            notionPageId: pageId,
            error: `append_${append.status}`,
          })
      }
      return this.exports.markSucceeded(record.id, pageId)
    } catch {
      return this.exports.update(record.id, "unknown", {
        notionPageId: pageId,
        error: "append_network_outcome_unknown",
      })
    }
  }

  private async findPageByMarker(record: ExportableRecord): Promise<string | null> {
    const expected = marker(record, paragraphBlocks(record.markdown).length, "start")
    try {
      const response = await this.fetcher(`${NOTION_API}/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          query: expected,
          filter: { property: "object", value: "page" },
          page_size: 100,
        }),
      })
      if (!response.ok) return null
      const payload = (await response.json()) as { results?: unknown }
      if (!Array.isArray(payload.results)) return null
      const match = payload.results.find((candidate) => {
        if (!candidate || typeof candidate !== "object") return false
        const page = candidate as NotionPage
        return (
          typeof page.id === "string" &&
          page.parent?.type === "page_id" &&
          page.parent.page_id === record.destinationId
        )
      }) as NotionPage | undefined
      return typeof match?.id === "string" ? match.id : null
    } catch {
      return null
    }
  }

  private async inspectSection(record: ExportableRecord, pageId: string): Promise<Inspection> {
    const all: unknown[] = []
    let cursor: string | null = null
    for (let index = 0; index < MAX_RECONCILE_PAGES; index += 1) {
      try {
        const search = new URLSearchParams({ page_size: "100" })
        if (cursor) search.set("start_cursor", cursor)
        const response = await this.fetcher(`${NOTION_API}/blocks/${pageId}/children?${search}`, {
          headers: this.headers(),
        })
        if (response.status === 429 || response.status === 529) return "retry_after"
        if (!response.ok) return "unknown"
        const payload = (await response.json()) as NotionBlockList
        if (!Array.isArray(payload.results)) return "unknown"
        all.push(...payload.results)
        if (payload.has_more !== true) break
        if (typeof payload.next_cursor !== "string" || payload.next_cursor === cursor)
          return "unknown"
        cursor = payload.next_cursor
      } catch {
        return "unknown"
      }
    }
    if (all.length === MAX_RECONCILE_PAGES * MAX_CHILDREN_PER_REQUEST) return "unknown"

    const body = paragraphBlocks(record.markdown).map(
      (block) => block.paragraph.rich_text[0]!.text.content,
    )
    const start = marker(record, body.length, "start")
    const end = marker(record, body.length, "end")
    const texts = all.map(textOf)
    const startIndex = texts.indexOf(start)
    const endIndex = texts.indexOf(end, startIndex + 1)
    if (
      startIndex < 0 ||
      endIndex < 0 ||
      texts[startIndex + 1] !== `Folo 导出版本 r${record.revision}`
    )
      return "incomplete"
    const actualBody = texts.slice(startIndex + 2, endIndex)
    return actualBody.length === body.length &&
      actualBody.every((text, index) => text === body[index])
      ? "complete"
      : "incomplete"
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    }
  }
}

export class NotionExportError extends Error {
  constructor(public readonly code: "export_not_found") {
    super(code)
  }
}
