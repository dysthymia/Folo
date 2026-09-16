import { z } from "zod"

import type { ProcessingInput } from "./automation-store"
import type {
  ExportableRecord,
  ExportOperation,
  ExportStatus,
  ExportTargetMode,
} from "./export-store"
import type { PublicIntegrationSettings } from "./external-config"
import { publicSettings, readExternalConfig, saveExternalConfig } from "./external-config"
import type { NotionFetcher } from "./notion-export"
import { NotionExportService } from "./notion-export"
import type { ProcessingDecision } from "./processing-decision"
import type { ResearchPack } from "./processing-reading-store"
import type { Store } from "./store"

const exportTarget = {
  destinationPageId: z.uuid().optional(),
  targetPageId: z.uuid().optional(),
}
const prepareExport = z.object({ storyId: z.uuid(), ...exportTarget }).strict()
const prepareEntryExport = z
  .object({ inputSeq: z.number().int().positive(), ...exportTarget })
  .strict()

const emptyBody = z.object({}).strict()

export type ExternalExportView = {
  id: string
  kind: "story" | "entry"
  storyId: string | null
  entry: {
    inputSeq: number
    sourceKey: string
    itemId: string
    contentVersion: string
    title: string
  } | null
  revision: number
  destinationId: string
  contentHash: string
  operation: ExportOperation
  targetMode: ExportTargetMode
  status: ExportStatus
  notionPageId: string | null
  retryAfter: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export type ExportPreview = Pick<
  ResearchPack,
  "storyId" | "revision" | "title" | "markdown" | "references"
>
export type EntryExportPreview = {
  kind: "entry"
  inputSeq: number
  sourceKey: string
  itemId: string
  contentVersion: string
  title: string
  url: string | null
  publishedAt: string
  markdown: string
  decision: { status: string; title: string; summary: string; reason: string } | null
}
export type ExternalApiResponse =
  | { integrations: PublicIntegrationSettings }
  | { disabled: true; integrations: PublicIntegrationSettings }
  | { exports: ExternalExportView[]; integrations: PublicIntegrationSettings }
  | { export: ExternalExportView }
  | { export: ExternalExportView; preview: ExportPreview | EntryExportPreview }

export type ExternalApiOptions = {
  store: Store
  configPath: string
  fetcher?: NotionFetcher
}

// 外部服务独立于同步 automation API，只有 confirm/reconcile 两个显式动作可访问网络。
export class ExternalApiService {
  constructor(private readonly options: ExternalApiOptions) {}

  async handle(
    method: string,
    path: string,
    body: unknown,
  ): Promise<ExternalApiResponse | undefined> {
    if (path === "/integrations/settings" && method === "GET") {
      return { integrations: publicSettings(this.options.configPath) }
    }

    if (path === "/integrations/settings" && method === "PUT") {
      return { integrations: saveExternalConfig(this.options.configPath, body) }
    }

    if (path === "/exports" && method === "GET") {
      return {
        exports: this.options.store.exports.list().map(exportView),
        integrations: publicSettings(this.options.configPath),
      }
    }

    if (path === "/exports" && method === "POST") {
      const input = prepareExport.parse(body)
      const config = readExternalConfig(this.options.configPath)
      if (!notionEnabled(config)) return disabled(this.options.configPath)
      const pack = this.options.store.reading.researchPack(input.storyId)
      if (pack.status !== "ready" || !pack.markdown || pack.revision === null)
        throw new ExternalApiError("story_not_exportable")
      const selectedTarget = target(input, config.notion.parentPageId)
      const record = this.options.store.exports.prepare(
        pack.storyId,
        pack.revision,
        selectedTarget.id,
        pack.markdown,
        selectedTarget.mode,
      )
      return { export: exportView(record), preview: pack }
    }

    if (path === "/exports/entries" && method === "POST") {
      const input = prepareEntryExport.parse(body)
      const config = readExternalConfig(this.options.configPath)
      if (!notionEnabled(config)) return disabled(this.options.configPath)
      const processingInput = this.options.store.automation
        .inputs()
        .find((item) => item.seq === input.inputSeq)
      if (!processingInput) throw new ExternalApiError("entry_not_exportable")
      const published = this.options.store.processingState
        .published()
        .find((candidate) => candidate.input.seq === processingInput.seq)
      const markdown = entryMarkdown(processingInput, published?.decision ?? null)
      const selectedTarget = target(input, config.notion.parentPageId)
      const record = this.options.store.exports.prepareEntry(
        {
          inputSeq: processingInput.seq,
          sourceKey: processingInput.sourceKey,
          itemId: processingInput.itemId,
          contentVersion: processingInput.contentVersion,
          title: processingInput.body.title,
        },
        selectedTarget.id,
        markdown,
        selectedTarget.mode,
      )
      return {
        export: exportView(record),
        preview: entryPreview(processingInput, published?.decision ?? null, markdown),
      }
    }

    const action = /^\/exports\/([^/]+)\/(confirm|reconcile)$/.exec(path)
    if (action && method === "POST") {
      emptyBody.parse(body)
      const id = z.uuid().parse(action[1])
      const config = readExternalConfig(this.options.configPath)
      if (!notionEnabled(config)) return disabled(this.options.configPath)
      const service = new NotionExportService(
        this.options.store.exports,
        config.notion.token,
        this.options.fetcher,
      )
      const record =
        action[2] === "confirm" ? await service.confirm(id) : await service.reconcile(id)
      return { export: exportView(record) }
    }

    const item = /^\/exports\/([^/]+)$/.exec(path)
    if (item && method === "GET") {
      const record = this.options.store.exports.get(z.uuid().parse(item[1]))
      if (!record) throw new ExternalApiError("export_not_found")
      return { export: exportView(record) }
    }

    return undefined
  }
}

export function externalApi(options: ExternalApiOptions): ExternalApiService {
  return new ExternalApiService(options)
}

function disabled(configPath: string): ExternalApiResponse {
  return { disabled: true, integrations: publicSettings(configPath) }
}

function notionEnabled(
  config: ReturnType<typeof readExternalConfig>,
): config is { notion: { enabled: true; token: string; parentPageId: string } } {
  return Boolean(config?.notion.enabled && config.notion.token && config.notion.parentPageId)
}

function target(
  input: { destinationPageId?: string; targetPageId?: string },
  configuredParent: string,
): { id: string; mode: ExportTargetMode } {
  if (input.destinationPageId && input.targetPageId)
    throw new ExternalApiError("conflicting_destination")
  // targetPageId 是用户明确选择的现有 Notion 页面；确认时只 PATCH 该页，不创建子页面。
  if (input.targetPageId) return { id: input.targetPageId, mode: "page" }
  return { id: input.destinationPageId ?? configuredParent, mode: "parent" }
}

function entryMarkdown(input: ProcessingInput, decision: ProcessingDecision | null): string {
  const content = input.body.content ?? input.body.description ?? "原文正文暂不可用。"
  return [
    `# ${input.body.title}`,
    "",
    `- 来源：${input.sourceKey}`,
    `- 条目：${input.itemId}`,
    `- 原文版本：${input.contentVersion}`,
    `- 发布于：${input.body.publishedAt}`,
    input.body.url ? `- 链接：${input.body.url}` : null,
    decision ? "\n## 处理结论" : null,
    decision ? `- 状态：${decision.status}` : null,
    decision ? `- 标题：${decision.title}` : null,
    decision ? `- 摘要：${decision.summary}` : null,
    decision ? `- 原因：${decision.reason}` : null,
    "\n## 原文",
    "",
    content,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
}

function entryPreview(
  input: ProcessingInput,
  decision: ProcessingDecision | null,
  markdown: string,
): EntryExportPreview {
  return {
    kind: "entry",
    inputSeq: input.seq,
    sourceKey: input.sourceKey,
    itemId: input.itemId,
    contentVersion: input.contentVersion,
    title: input.body.title,
    url: input.body.url,
    publishedAt: input.body.publishedAt,
    markdown,
    decision: decision
      ? {
          status: decision.status,
          title: decision.title,
          summary: decision.summary,
          reason: decision.reason,
        }
      : null,
  }
}

function exportView(record: ExportableRecord): ExternalExportView {
  return {
    id: record.id,
    kind: record.kind,
    storyId: record.kind === "story" ? record.storyId : null,
    entry: record.kind === "entry" ? record.entry : null,
    revision: record.revision,
    destinationId: record.destinationId,
    contentHash: record.contentHash,
    operation: record.operation,
    targetMode: record.targetMode,
    status: record.status,
    notionPageId: record.notionPageId,
    retryAfter: record.retryAfter,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export class ExternalApiError extends Error {
  constructor(
    public readonly code:
      | "story_not_exportable"
      | "entry_not_exportable"
      | "export_not_found"
      | "conflicting_destination",
  ) {
    super(code)
  }
}
