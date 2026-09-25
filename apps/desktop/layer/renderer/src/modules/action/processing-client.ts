import type { RuleSet } from "@follow/information-core"
import {
  conditionSchema,
  conditionSetSchema,
  presentationPolicySchema,
  ruleSchema,
  ruleSetSchema,
  scheduleScopeSchema,
} from "@follow/information-core"
import { z } from "zod"

import { informationRequestInit } from "../information/request-init"
import { informationSnapshotSchema } from "../information/snapshot"

const isoDateTime = z.iso.datetime({ offset: true })
const revisionSchema = z.number().int().nonnegative()
const positiveIntegerSchema = z.number().int().positive()
const identifierSchema = z.string().min(1).max(200)

export const processingDraftSchema = z
  .object({
    revision: revisionSchema,
    config: ruleSetSchema,
  })
  .strict()

const releaseScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("future") }).strict(),
  z.object({ mode: z.literal("recent"), since: isoDateTime }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      inputIds: z.array(positiveIntegerSchema).min(1).max(10_000),
    })
    .strict(),
])

export const processingReleaseWireSchema = z
  .object({
    version: positiveIntegerSchema,
    draftRevision: revisionSchema,
    activationSeq: revisionSchema,
    scope: releaseScopeSchema,
    targetInputIds: z.array(positiveIntegerSchema),
    createdAt: isoDateTime,
  })
  .strict()

export const processingReleaseImpactSchema = z
  .object({
    newAssignments: revisionSchema,
    recalculated: revisionSchema,
    queuedUnchanged: revisionSchema,
    historicalUnchanged: revisionSchema,
  })
  .strict()

export const processingReleasePreviewSchema = z
  .object({
    scope: releaseScopeSchema,
    targetInputIds: z.array(positiveIntegerSchema),
    impact: processingReleaseImpactSchema,
  })
  .strict()

export const processingReleaseDetailSchema = z
  .object({ release: processingReleaseWireSchema, config: ruleSetSchema })
  .strict()

const releaseResultSchema = processingReleaseWireSchema.transform(
  ({ version, targetInputIds }) => ({
    version,
    targetInputIds,
  }),
)

const tagSnapshotWireSchema = z
  .object({
    formatVersion: z.literal(1),
    revision: revisionSchema,
    tags: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1).max(100),
          createdAt: isoDateTime,
          updatedAt: isoDateTime,
        })
        .strict(),
    ),
  })
  .strict()

const tagSnapshotSchema = tagSnapshotWireSchema

const editorSourceSchema = informationSnapshotSchema.shape.sources.element
  .extend({
    siteUrl: z.string().nullable().optional(),
    feedUrl: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
  })
  .strict()
const editorItemSchema = informationSnapshotSchema.shape.items.element.strict()
const listMembershipSchema = z
  .object({
    listKey: z.string().min(1),
    ownerId: z.string().min(1).nullable().optional(),
    feedIds: z.array(z.string().min(1)),
    complete: z.boolean(),
    status: z.enum(["complete", "unknown"]),
    revision: z.number().int().nonnegative(),
    syncedAt: z.string().datetime().nullable(),
  })
  .strict()

export const processingEditorSchema = processingDraftSchema
  .extend({
    sources: z.array(editorSourceSchema),
    sourceInventoryKnown: z.boolean().optional(),
    items: z.array(editorItemSchema),
    releases: z.array(processingReleaseWireSchema),
    capabilities: z.object({ automaticProcessing: z.boolean() }).strict(),
    subscriptionTags: tagSnapshotSchema,
    sourceTags: z.array(
      z.object({ sourceKey: z.string().min(1), tagIds: z.array(z.string().min(1)) }).strict(),
    ),
    listMemberships: z.array(listMembershipSchema),
  })
  .strict()

const nullableText = z.string().nullable().optional()
const ruleInputSchema = z
  .object({
    source_id: z.string().nullable(),
    contextId: z.string().min(1),
    title: nullableText,
    category: nullableText,
    site_url: nullableText,
    feed_url: nullableText,
    entry_title: nullableText,
    entry_content: nullableText,
    entry_url: nullableText,
    entry_author: nullableText,
    language: nullableText,
    platform: nullableText,
    content_completeness: nullableText,
    view: z.number().int().nonnegative().nullable().optional(),
    category_ref: z
      .object({ view: z.number().int().nonnegative(), name: identifierSchema })
      .strict()
      .nullable()
      .optional(),
    subscription_tag: z.array(z.string()).nullable().optional(),
    list_id: z.record(z.string(), z.boolean().nullable()).nullable().optional(),
    read: z.boolean().nullable().optional(),
    collected: z.boolean().nullable().optional(),
    entry_media_length: z.number().nonnegative().nullable().optional(),
    entry_attachments_duration: z.number().nonnegative().nullable().optional(),
    visible_length: z.number().int().nonnegative().nullable().optional(),
    updated_at: nullableText,
  })
  .strict()

const matchStateSchema = z.enum(["match", "no_match", "unknown"])
const presetRefSchema = z.object({ id: identifierSchema, version: positiveIntegerSchema }).strict()
const aggregateSchema = z
  .object({
    ruleId: identifierSchema,
    version: positiveIntegerSchema,
    order: revisionSchema,
    type: z.literal("ai_aggregate"),
    createPrompt: z.string().min(1).max(30_000),
    updatePrompt: z.string().max(30_000),
    scope: conditionSetSchema,
    mode: z.enum(["same_event", "topic"]),
    presets: z
      .object({ create: presetRefSchema.optional(), update: presetRefSchema.optional() })
      .strict()
      .optional(),
  })
  .strict()

const dedupeSchema = z
  .object({
    ruleId: identifierSchema,
    version: positiveIntegerSchema,
    order: revisionSchema,
    scope: conditionSetSchema,
  })
  .strict()

export const processingPreviewWireSchema = z
  .object({
    entryId: z.string().min(1),
    sourceKey: z.string().min(1),
    material: z.enum(["source_text", "missing"]),
    input: ruleInputSchema,
    metadataVersion: revisionSchema,
    global: z
      .object({
        markdown: z.string(),
        version: positiveIntegerSchema,
        preset: presetRefSchema.optional(),
      })
      .strict(),
    matched: z.array(ruleSchema),
    pendingRuleIds: z.array(identifierSchema),
    matches: z.array(
      z
        .object({
          ruleId: identifierSchema,
          state: matchStateSchema,
          groups: z.array(
            z.array(z.object({ condition: conditionSchema, state: matchStateSchema }).strict()),
          ),
        })
        .strict(),
    ),
    policy: presentationPolicySchema,
    display: z
      .object({
        language: z.string().optional(),
        summaryMaxGraphemes: positiveIntegerSchema.optional(),
      })
      .strict(),
    resolvedBy: z.record(z.string(), identifierSchema),
    shadowed: z.array(
      z
        .object({ field: z.string(), ruleId: identifierSchema, winnerRuleId: identifierSchema })
        .strict(),
    ),
    blocksFinalPresentation: z.boolean(),
    transformations: z.array(
      z
        .object({
          ruleId: identifierSchema,
          version: positiveIntegerSchema,
          order: revisionSchema,
          prompt: z.string(),
        })
        .strict(),
    ),
    aggregates: z.array(aggregateSchema),
    dedupes: z.array(dedupeSchema),
  })
  .strict()

const previewSchema = processingPreviewWireSchema

const trialResultSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    reason: z.string(),
    status: z.enum(["keep", "hide", "needs_context"]),
    policy: presentationPolicySchema,
    facts: z.array(
      z
        .object({
          text: z.string(),
          quote: z.string(),
          kind: z.enum(["fact", "source_claim", "inference"]),
        })
        .strict(),
    ),
  })
  .strict()
export const processingTrialSchema = z
  .object({
    entryId: z.string(),
    sourceKey: z.string(),
    original: z.object({ title: z.string(), text: z.string() }).strict(),
    before: trialResultSchema.nullable(),
    beforeReleaseVersion: z.number().int().positive().nullable(),
    after: trialResultSchema,
    model: z.string(),
    usage: z
      .object({ inputTokens: z.number(), outputTokens: z.number(), cachedInputTokens: z.number() })
      .strict()
      .nullable(),
    aggregation: z.array(
      z
        .object({
          ruleId: z.string(),
          mode: z.enum(["same_event", "topic"]),
          count: z.number().int().nonnegative(),
          candidates: z.array(
            z
              .object({
                inputSeq: z.number().int().positive(),
                title: z.string(),
                sourceKey: z.string(),
                entryId: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()
export type ProcessingTrialResult = z.infer<typeof processingTrialSchema>

const scheduleConfigSchema = z
  .object({
    scope: scheduleScopeSchema,
    sourceKeys: z.array(z.string().min(1).max(300)).min(1).max(10_000),
    historySince: isoDateTime,
    timeZone: z.string().min(1).max(100),
    enabled: z.boolean(),
    times: z
      .array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))
      .min(1)
      .max(10),
    pollIntervalMinutes: z.number().int().min(5).max(1440).nullable(),
    readyBy: z
      .object({ leadMinutes: z.number().int().min(1).max(720) })
      .strict()
      .nullable(),
  })
  .strict()
const scheduleSchema = z
  .object({
    revision: revisionSchema,
    config: scheduleConfigSchema.nullable(),
  })
  .strict()

export const processingRunSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["scheduled", "catchup", "poll", "manual"]),
    dedupeKey: z.string().min(1),
    configRevision: revisionSchema,
    sourceKeys: z.array(z.string().min(1)),
    historySince: isoDateTime,
    timeZone: z.string().min(1),
    scheduledFor: z.string().min(1).nullable(),
    cutoffAt: isoDateTime,
    status: z.enum([
      "pending",
      "running",
      "succeeded",
      "retry_wait",
      "needs_context",
      "deferred_budget",
      "failed",
      "cancelled",
    ]),
    leaseToken: z.string().min(1).nullable(),
    leaseUntil: isoDateTime.nullable(),
    createdAt: isoDateTime,
    startedAt: isoDateTime.nullable(),
    finishedAt: isoDateTime.nullable(),
    error: z.string().nullable(),
  })
  .strict()

const runsSchema = z
  .object({
    runs: z.array(processingRunSchema),
    reports: z.array(z.object({ triggerId: z.string().uuid(), report: z.unknown() }).strict()),
  })
  .strict()

export const processingInputWireSchema = z
  .object({
    seq: positiveIntegerSchema,
    sourceKey: z.string().min(1),
    itemId: z.string().min(1),
    contentVersion: z.string().min(1),
    receivedAt: isoDateTime,
    releaseVersion: positiveIntegerSchema.nullable(),
    generation: revisionSchema,
    // `skipped` 是「已读条目退出处理队列」引入的终态：已读条目不再消耗额度，
    // 状态机里必须有它，否则 /inputs 响应过不了这里的 .strict() 校验，
    // 详情面板会整体报「规则或服务响应无效」而拿不到任何输入。
    status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
    current: z.boolean(),
  })
  .strict()

const processingInputSchema = processingInputWireSchema.transform(
  ({ seq, sourceKey, itemId, status }) => ({ seq, sourceKey, itemId, status }),
)
const inputsSchema = z
  .object({
    inputs: z.array(processingInputSchema),
  })
  .strict()
export type ProcessingEditor = z.infer<typeof processingEditorSchema>
export type ProcessingPreview = z.infer<typeof previewSchema>
export type ProcessingSchedule = z.infer<typeof scheduleSchema>
export type ProcessingScheduleConfig = z.infer<typeof scheduleConfigSchema>
export type ProcessingRun = z.infer<typeof processingRunSchema>
export type ProcessingRelease = z.infer<typeof releaseResultSchema>
export type ProcessingReleaseScope = z.infer<typeof releaseScopeSchema>
export type ProcessingReleaseImpact = z.infer<typeof processingReleaseImpactSchema>
export type ProcessingReleasePreview = z.infer<typeof processingReleasePreviewSchema>
export type ProcessingReleaseDetail = z.infer<typeof processingReleaseDetailSchema>
export type ProcessingInput = z.infer<typeof inputsSchema>["inputs"][number]
export class ProcessingRequestError extends Error {
  constructor(
    public readonly kind: "authorization" | "conflict" | "referenced" | "invalid" | "request",
  ) {
    super(kind)
  }
}

export function createProcessingClient(
  generate: () => Promise<string>,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
) {
  async function request<T>(
    path: string,
    method: "GET" | "PUT" | "POST" | "DELETE",
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    // 每次请求交换主站新凭据，不缓存授权，也不复用官方 Actions 的写入接口。
    const token = await generate()
    signal.throwIfAborted()
    const response = await fetcher(
      `/information/v1/${path}`,
      informationRequestInit({
        method,
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "X-Folo-One-Time-Token": token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    if (!response.ok) {
      const detail = await response.json().catch(() => null)
      const referenced = z.object({ error: z.literal("tag_referenced") }).safeParse(detail).success
      throw new ProcessingRequestError(
        [401, 403].includes(response.status)
          ? "authorization"
          : referenced
            ? "referenced"
            : response.status === 409
              ? "conflict"
              : response.status === 400
                ? "invalid"
                : "request",
      )
    }
    const parsed = schema.safeParse(await response.json())
    signal.throwIfAborted()
    if (!parsed.success) throw new ProcessingRequestError("invalid")
    return parsed.data
  }
  return {
    createTag: (name: string, expectedRevision: number, signal: AbortSignal) =>
      request("subscription-tags", "POST", tagSnapshotSchema, signal, { name, expectedRevision }),
    renameTag: (id: string, name: string, expectedRevision: number, signal: AbortSignal) =>
      request(`subscription-tags/${encodeURIComponent(id)}`, "PUT", tagSnapshotSchema, signal, {
        name,
        expectedRevision,
      }),
    deleteTag: (id: string, expectedRevision: number, signal: AbortSignal) =>
      request(`subscription-tags/${encodeURIComponent(id)}`, "DELETE", tagSnapshotSchema, signal, {
        expectedRevision,
      }),
    bindTags: (
      sourceKeys: string[],
      tagIds: string[],
      operation: "add" | "remove",
      expectedRevision: number,
      signal: AbortSignal,
    ) =>
      request(
        "source-tags",
        "PUT",
        z
          .object({
            revision: revisionSchema,
            changedBindings: revisionSchema,
            sourceKeys: z.array(z.string().min(1)),
          })
          .strict(),
        signal,
        { sourceKeys, tagIds, operation, expectedRevision },
      ),
    load: (signal: AbortSignal) => request("configuration", "GET", processingEditorSchema, signal),
    save: (config: RuleSet, expectedRevision: number, signal: AbortSignal) =>
      request("configuration", "PUT", processingDraftSchema, signal, {
        config: ruleSetSchema.parse(config),
        expectedRevision,
      }),
    preview: (config: RuleSet, sourceKey: string, entryId: string, signal: AbortSignal) =>
      request("rules/preview", "POST", previewSchema, signal, {
        config: ruleSetSchema.parse(config),
        sourceKey,
        entryId,
      }),
    trial: (config: RuleSet, sourceKey: string, entryId: string, signal: AbortSignal) =>
      request("rules/trial", "POST", processingTrialSchema, signal, {
        config: ruleSetSchema.parse(config),
        sourceKey,
        entryId,
      }),
    loadSchedule: (signal: AbortSignal) => request("schedule", "GET", scheduleSchema, signal),
    saveSchedule: (
      config: ProcessingScheduleConfig,
      expectedRevision: number,
      signal: AbortSignal,
    ) => request("schedule", "PUT", scheduleSchema, signal, { expectedRevision, config }),
    startRun: (requestId: string, signal: AbortSignal) =>
      request("runs", "POST", processingRunSchema, signal, { requestId }),
    loadRuns: (signal: AbortSignal) => request("runs", "GET", runsSchema, signal),
    releaseRuleSet: (
      expectedRevision: number,
      scope: ProcessingReleaseScope,
      requestId: string,
      signal: AbortSignal,
    ) =>
      request("rule-set-releases", "POST", releaseResultSchema, signal, {
        expectedRevision,
        scope,
        requestId,
      }),
    previewRelease: (scope: ProcessingReleaseScope, signal: AbortSignal) =>
      request("rule-set-releases/preview", "POST", processingReleasePreviewSchema, signal, {
        scope,
      }),
    loadRelease: (version: number, signal: AbortSignal) =>
      request(`rule-set-releases/${version}`, "GET", processingReleaseDetailSchema, signal),
    loadInputs: (signal: AbortSignal) => request("inputs", "GET", inputsSchema, signal),
  }
}
