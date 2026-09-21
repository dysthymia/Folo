import { compileInstructions } from "@follow/information-core"
import { z } from "zod"

import { AutomationError } from "./automation-store"
import type { SourceEntry } from "./folo"
import { processingRuleInput } from "./processing-context"
import type { ProcessingDecision } from "./processing-decision"
import { processingFeedbackApi } from "./processing-feedback-api"
import type {
  ProcessingEntryRole,
  ReadingSnapshot,
  ReadingSnapshotCounts,
  ReadingSnapshotPage,
  ResearchPack,
} from "./processing-reading-store"
import type {
  ProcessingScheduleInput,
  ProcessingScheduleReadingStatus,
  ProcessingTriggerStatus,
} from "./processing-schedule"
import { researchApi } from "./research-api"
import { sourceText } from "./service"
import type { Store } from "./store"
import { StoryCorrectionService } from "./story-corrections"
import type { Story, StoryLink } from "./story-store"

const revision = z.number().int().nonnegative()
const positiveInteger = z.number().int().positive()
const scheduleConfig = z
  .object({
    sourceKeys: z.array(z.string().min(1).max(300)).min(1).max(10000),
    historySince: z.iso.datetime({ offset: true }),
    timeZone: z.string().min(1).max(100),
    enabled: z.boolean(),
    times: z
      .array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))
      .min(1)
      .max(10)
      .optional(),
    pollIntervalMinutes: z.number().int().min(5).max(1440).nullable().optional(),
    readyBy: z
      .object({ leadMinutes: z.number().int().min(1).max(720) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()

export type ProcessingEntryDecisionView = Pick<
  ProcessingDecision,
  "status" | "title" | "summary" | "reason" | "labels" | "policy"
> & { id: string }
export type ProcessingEntryMetadataView = {
  sourceSyncedAt: string | null
  listMembershipVersion: number
}
export type ProcessingEntryOverrideView = {
  inputSeq: number
  mode: "restore" | "hide" | "automatic"
  revision: number
}
export type ProcessingEntryListItem = {
  seq: number
  sourceKey: string
  itemId: string
  title: string
  url: string | null
  read: boolean | null
  receivedAt: string
  status: string
  decision: ProcessingEntryDecisionView | null
  reviewNeeded: boolean
  issueCount: number
  override: ProcessingEntryOverrideView
  metadata: ProcessingEntryMetadataView
}
export type ProcessingEntryListResponse = { entries: ProcessingEntryListItem[] }
export type ProcessingEntryRolesResponse = { roles: ProcessingEntryRole[] }
export type ProcessingEntryDetailResponse = {
  // 详情页可读取原文和完整决策，供证据追溯；列表只能读取摘要级决策字段。
  entry: Omit<ProcessingEntryListItem, "decision"> & {
    input: SourceEntry
    decision: ProcessingDecision | null
  }
}
export type StoriesListResponse = {
  stories: Array<{
    story: Story
    title: string | null
    readStatus: { readSubstantiveRevision: number; unread: boolean }
  }>
}
export type StoryLinkResponse = StoryLink
export type ReadingCurrentProcessingStatus = {
  runStatus: ProcessingTriggerStatus | null
  sourceTotal: number
  incompleteSources: number | null
  sourceStatusAt: string | null
}
export type ReadingSnapshotResponse = {
  snapshot: ReadingSnapshot
  counts: ReadingSnapshotCounts
  processing: ReadingCurrentProcessingStatus
  schedule: ProcessingScheduleReadingStatus
}
export type ReadingSnapshotPageResponse = ReadingSnapshotPage
export type ResearchPackResponse = ResearchPack

function owner(store: Store): string {
  if (!store.ownerId) throw new AutomationError("owner_required")
  return store.ownerId
}

function readingSnapshotResponse(store: Store, snapshot: ReadingSnapshot): ReadingSnapshotResponse {
  const schedule = store.schedule.readingStatus()
  const triggers = store.schedule
    .triggers()
    .filter((trigger) => trigger.configRevision === schedule.revision)
  const currentRun = triggers.at(-1) ?? null
  const reports = new Map(
    store.processingState.reports().map((item) => [item.triggerId, item.report]),
  )
  const reportedTrigger = [...triggers].reverse().find((trigger) => reports.has(trigger.id)) ?? null
  const report = reportedTrigger ? reports.get(reportedTrigger.id) : null
  const reportRecord = report !== null && typeof report === "object" ? report : null
  const reportedSources =
    reportRecord && "sources" in reportRecord && Array.isArray(reportRecord.sources)
      ? reportRecord.sources
      : null
  const sourceCoverage = reportedSources
    ? new Map(
        reportedSources.flatMap((source) => {
          if (
            source === null ||
            typeof source !== "object" ||
            !("sourceKey" in source) ||
            typeof source.sourceKey !== "string" ||
            !("coverage" in source) ||
            typeof source.coverage !== "string"
          )
            return []
          return [[source.sourceKey, source.coverage] as const]
        }),
      )
    : null
  const finishedAt =
    reportRecord &&
    "finishedAt" in reportRecord &&
    typeof reportRecord.finishedAt === "string" &&
    Number.isFinite(Date.parse(reportRecord.finishedAt))
      ? new Date(reportRecord.finishedAt).toISOString()
      : null
  const sourceKeys = store.schedule.snapshot().config?.sourceKeys ?? []
  return {
    snapshot,
    counts: store.reading.counts(snapshot.id),
    processing: {
      runStatus: currentRun?.status ?? null,
      sourceTotal: sourceKeys.length,
      incompleteSources: sourceCoverage
        ? sourceKeys.filter(
            (sourceKey) =>
              !["end", "history_boundary"].includes(sourceCoverage.get(sourceKey) ?? ""),
          ).length
        : null,
      sourceStatusAt: finishedAt,
    },
    schedule,
  }
}

function entryView(store: Store): ProcessingEntryListItem[] {
  const decisions = new Map(
    store.processingState
      .published()
      .map(({ input, decisionId, decision }) => [input.seq, { decisionId, decision }]),
  )
  const overrides = new Map(
    store.processingState.overrides().map((override) => [override.inputSeq, override]),
  )
  const unsupportedCitationCounts = new Map<string, number>()
  for (const feedback of store.feedback.list()) {
    if (
      feedback.kind !== "unsupported_citation" ||
      feedback.target.kind !== "entry" ||
      !feedback.target.decisionId
    )
      continue
    unsupportedCitationCounts.set(
      feedback.target.decisionId,
      (unsupportedCitationCounts.get(feedback.target.decisionId) ?? 0) + 1,
    )
  }
  // 完整 current input 集合交给 UI 筛选，服务端不按处理状态或数量截断。
  return store.automation.inputs().map((input) => {
    const result = decisions.get(input.seq)
    const issueCount = result ? (unsupportedCitationCounts.get(result.decisionId) ?? 0) : 0
    return {
      seq: input.seq,
      sourceKey: input.sourceKey,
      itemId: input.itemId,
      title: input.body.title,
      url: input.body.url,
      read: input.body.read,
      receivedAt: input.receivedAt,
      status: input.status,
      decision: result
        ? {
            id: result.decisionId,
            status: result.decision.status,
            title: result.decision.title,
            summary: result.decision.summary,
            reason: result.decision.reason,
            labels: result.decision.labels,
            policy: result.decision.policy,
          }
        : null,
      reviewNeeded: issueCount > 0,
      issueCount,
      override: overrides.get(input.seq) ?? { inputSeq: input.seq, mode: "automatic", revision: 0 },
      metadata: store.sourceSync.contextFor(input.sourceKey, input.body).metadata,
    } satisfies ProcessingEntryListItem
  })
}

export function processingApi(
  store: Store,
  method: string,
  path: string,
  body: unknown,
): object | undefined {
  const feedback = processingFeedbackApi(store, method, path, body)
  if (feedback !== undefined) return feedback
  const research = researchApi(store, method, path, body)
  if (research !== undefined) return research
  if (path === "/schedule") {
    if (method === "GET") return store.schedule.snapshot()
    if (method === "PUT") {
      const input = z
        .object({ expectedRevision: revision, config: scheduleConfig })
        .strict()
        .parse(body)
      const knownSources = new Set(store.sources().map((source) => source.key))
      if (input.config.sourceKeys.some((sourceKey) => !knownSources.has(sourceKey)))
        throw new AutomationError("invalid_target")
      return store.schedule.save(input.config as ProcessingScheduleInput, input.expectedRevision)
    }
  }
  if (path === "/runs") {
    if (method === "GET")
      return { runs: store.schedule.triggers(), reports: store.processingState.reports() }
    if (method === "POST") {
      const input = z.object({ requestId: z.uuid() }).strict().parse(body)
      if (!store.automation.releases().length) throw new AutomationError("invalid_target")
      return store.schedule.manual(input.requestId, new Date())
    }
  }
  if (path === "/reading-snapshot") {
    if (method === "GET") return readingSnapshotResponse(store, store.reading.snapshot())
    if (method === "POST") {
      const input = z
        .object({
          snapshotId: z.uuid().optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(50).optional(),
          view: z
            .enum(["smart", "standalone", "all", "hidden", "pending", "failed", "stories"])
            .optional(),
        })
        .strict()
        .parse(body)
      return store.reading.page(input) satisfies ReadingSnapshotPageResponse
    }
  }
  if (path === "/reading-snapshot/refresh" && method === "POST") {
    z.object({}).strict().parse(body)
    return readingSnapshotResponse(store, store.reading.refresh())
  }
  const researchPackPath = /^\/research-pack\/([^/]+)$/.exec(path)
  if (researchPackPath && method === "GET")
    return store.reading.researchPack(researchPackPath[1]!) satisfies ResearchPackResponse
  if (path === "/processing/roles" && method === "GET")
    // 时间线角色投影不受计划范围限制：时间线覆盖全部订阅，只取当前 input。
    return { roles: store.reading.roles() } satisfies ProcessingEntryRolesResponse
  if (path === "/processing/entries" && method === "GET")
    return { entries: entryView(store) } satisfies ProcessingEntryListResponse

  const entryDetailPath = /^\/processing\/entries\/(\d+)$/.exec(path)
  if (entryDetailPath && method === "GET") {
    const seq = positiveInteger.parse(Number(entryDetailPath[1]))
    const item = entryView(store).find((entry) => entry.seq === seq)
    const input = store.automation.inputs().find((candidate) => candidate.seq === seq)
    const published = store.processingState
      .published()
      .find((candidate) => candidate.input.seq === seq)
    if (!item || !input) throw new AutomationError("invalid_target")
    return {
      entry: { ...item, input: input.body, decision: published?.decision ?? null },
    } satisfies ProcessingEntryDetailResponse
  }

  const explanationPath = /^\/processing\/entries\/(\d+)\/explanation$/.exec(path)
  if (explanationPath && method === "GET") {
    const seq = positiveInteger.parse(Number(explanationPath[1]))
    const input = store.automation.inputs().find((item) => item.seq === seq && item.current)
    if (!input || !store.sources().some((source) => source.key === input.sourceKey))
      throw new AutomationError("invalid_target")
    const published = store.processingState.published().find((item) => item.input.seq === seq)
    const release =
      input.releaseVersion === null ? null : store.automation.release(input.releaseVersion)
    // 已完成结果使用执行当时的上下文和发布版本解释，避免把新草稿伪装成旧决定的原因。
    const context =
      published?.decision.context ??
      processingRuleInput(
        store,
        input.sourceKey,
        input.body,
        sourceText(input.body.content ?? ""),
        store.processingState.material(input) === "complete",
      )
    const instructions = release ? compileInstructions(release, context) : null
    return {
      sourceId: context.source_id,
      releaseVersion: input.releaseVersion,
      globalInstructions: instructions?.global.markdown ?? null,
      rules:
        instructions?.matches.map((match) => ({
          id: match.ruleId,
          name: release!.rules.find((rule) => rule.id === match.ruleId)!.name,
          state: match.state,
        })) ?? [],
      shadowed: instructions?.shadowed ?? [],
      pending: !published,
    }
  }

  const entryPath = /^\/processing\/entries\/(\d+)\/(override|undo|retry)$/.exec(path)
  if (entryPath) {
    const seq = positiveInteger.parse(Number(entryPath[1]))
    const action = entryPath[2]
    if (action === "override" && method === "POST") {
      const input = z
        .object({ mode: z.enum(["restore", "hide", "automatic"]), expectedRevision: revision })
        .strict()
        .parse(body)
      let result: ReturnType<typeof store.processingState.setOverride> | undefined
      store.transaction(() => {
        result = store.processingState.setOverride(seq, input.mode, input.expectedRevision)
        store.stories.invalidateInputs([seq])
      })
      return result!
    }
    if (action === "undo" && method === "POST") {
      const input = z.object({ expectedRevision: revision }).strict().parse(body)
      let result: ReturnType<typeof store.processingState.undoOverride> | undefined
      store.transaction(() => {
        result = store.processingState.undoOverride(seq, input.expectedRevision)
        store.stories.invalidateInputs([seq])
      })
      return result!
    }
    if (action === "retry" && method === "POST") {
      z.object({}).strict().parse(body)
      if (!store.processingState.retry(seq)) throw new AutomationError("invalid_target")
      return { inputSeq: seq, status: "pending" }
    }
  }
  if (path === "/stories" && method === "GET") {
    const readerId = owner(store)
    return {
      stories: store.stories
        .list()
        .map((listedStory) => {
          // 活跃 Story 只展示仍可作为当前快照读取的标题；修复中的条目保留旧版本标题便于定位。
          const link = store.stories.resolveLink(listedStory.id)
          if (link.kind === "missing") return null
          const story = link.story
          const title =
            link.kind === "current"
              ? link.revision.title
              : (store.stories.revision(story.id, story.currentRevision)?.title ?? null)
          return { story, title, readStatus: store.stories.readStatus(story.id, readerId) }
        })
        .filter((story): story is StoriesListResponse["stories"][number] => story !== null),
    } satisfies StoriesListResponse
  }
  const revisionPath = /^\/stories\/([^/]+)\/revisions\/(\d+)$/.exec(path)
  if (revisionPath && method === "GET")
    return {
      revision: store.stories.revision(
        revisionPath[1]!,
        positiveInteger.parse(Number(revisionPath[2])),
      ),
    }
  if (path === "/stories/merge" && method === "POST") {
    const input = z
      .object({
        keepStoryId: z.uuid(),
        mergeStoryId: z.uuid(),
        expectedKeepRevision: positiveInteger,
        expectedMergedRevision: positiveInteger,
      })
      .strict()
      .parse(body)
    owner(store)
    return new StoryCorrectionService(store.stories).merge(input)
  }
  const splitPath = /^\/stories\/([^/]+)\/split$/.exec(path)
  if (splitPath && method === "POST") {
    const input = z
      .object({
        expectedRevision: positiveInteger,
        groups: z.array(z.array(positiveInteger).min(2).max(10000)).max(1000),
        independentInputSeqs: z.array(positiveInteger).max(10000).default([]),
      })
      .strict()
      .parse(body)
    owner(store)
    return new StoryCorrectionService(store.stories).split({
      storyId: z.uuid().parse(splitPath[1]),
      ...input,
    })
  }
  const storyPath = /^\/stories\/([^/]+)$/.exec(path)
  if (storyPath) {
    const storyId = storyPath[1]!
    if (method === "GET") return store.stories.resolveLink(storyId) satisfies StoryLinkResponse
    if (method === "POST") {
      const input = z.object({ revision: positiveInteger.optional() }).strict().parse(body)
      store.stories.markRead(storyId, owner(store), input.revision)
      return { storyId, readStatus: store.stories.readStatus(storyId, owner(store)) }
    }
  }
  const removeMemberPath = /^\/stories\/([^/]+)\/remove-member$/.exec(path)
  if (removeMemberPath && method === "POST") {
    const input = z
      .object({ expectedRevision: positiveInteger, inputSeq: positiveInteger })
      .strict()
      .parse(body)
    return store.stories.removeMember(removeMemberPath[1]!, input.expectedRevision, input.inputSeq)
  }
  const materialPath = /^\/materials\/(\d+)\/withdraw$/.exec(path)
  if (materialPath && method === "POST") {
    const input = z
      .object({ reason: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(body)
    return store.stories.withdrawMaterial(
      positiveInteger.parse(Number(materialPath[1])),
      input.reason,
    )
  }
  const correctionPath = /^\/corrections\/([^/]+)\/undo$/.exec(path)
  if (correctionPath && method === "POST") {
    z.object({}).strict().parse(body)
    return store.stories.undoCorrection(correctionPath[1]!)
  }
  return undefined
}
