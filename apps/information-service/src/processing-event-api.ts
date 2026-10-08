import { z } from "zod"

import { AutomationError } from "./automation-store"
import type { EventScope } from "./processing-event-registry"
import {
  eventListQuerySchema,
  eventMembersQuerySchema,
  EventRegistryError,
} from "./processing-event-registry"
import type { Store } from "./store"

const eventId = z.string().regex(/^evt_[0-9a-f-]{36}$/u)
const member = z
  .object({ inputSeq: z.number().int().positive(), mentionId: z.string().regex(/^M[1-9]\d*$/u) })
  .strict()
const correction = z
  .object({
    requestId: z.uuid(),
    expectedRevisions: z.record(eventId, z.number().int().positive()),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("rename"), title: z.string().trim().min(1).max(500) }).strict(),
      member.extend({ type: z.literal("exclude") }).strict(),
      member.extend({ type: z.literal("move"), targetEventId: eventId }).strict(),
      z.object({ type: z.literal("merge"), targetEventId: eventId }).strict(),
      z
        .object({
          type: z.literal("split"),
          groups: z
            .array(
              z
                .object({
                  title: z.string().trim().min(1).max(500),
                  members: z.array(member).min(1).max(1000),
                })
                .strict(),
            )
            .min(2)
            .max(10),
        })
        .strict(),
      z.object({ type: z.literal("undo"), correctionId: z.uuid() }).strict(),
    ]),
  })
  .strict()

// 事件检索只读现有材料；噪声隐藏、人工隐藏、撤回及不可访问来源均先于计数和分页排除。
function eventScope(store: Store, inputSeqs?: readonly number[]): EventScope {
  const overrides = new Map(
    store.processingState.overrides(inputSeqs).map((item) => [item.inputSeq, item.mode]),
  )
  const published = new Map(
    store.processingState.published(inputSeqs).map((item) => [item.input.seq, item.decision]),
  )
  return {
    activeSources: new Set(
      store
        .sources()
        .filter((source) => source.origin !== "generated" && !source.key.startsWith("generated:"))
        .map((source) => source.key),
    ),
    excludedInputSeqs: new Set(
      store.automation
        .inputs(inputSeqs)
        .filter((input) => {
          const decision = published.get(input.seq)
          return (
            store.stories.isMaterialWithdrawn(input.seq) ||
            overrides.get(input.seq) === "hide" ||
            (overrides.get(input.seq) !== "restore" &&
              decision?.status === "hide" &&
              decision.policy.aggregation === "deny")
          )
        })
        .map((input) => input.seq),
    ),
  }
}

export function processingEventApi(
  store: Store,
  method: string,
  path: string,
  body: unknown,
): object | undefined {
  const entryPath = /^\/processing\/entries\/(\d+)\/events$/u.exec(path)
  const eventPath = /^\/processing\/events\/(evt_[0-9a-f-]{36})(?:\/(members|corrections))?$/u.exec(
    path,
  )
  const listRoute = path === "/processing/events" && (method === "GET" || method === "POST")
  const entryRoute = entryPath && method === "GET"
  const detailRoute =
    eventPath &&
    ((!eventPath[2] && method === "GET") ||
      (eventPath[2] === "members" && (method === "GET" || method === "POST")) ||
      (eventPath[2] === "corrections" && method === "POST"))
  if (!listRoute && !entryRoute && !detailRoute) return undefined
  if (!store.ownerId) throw new AutomationError("owner_required")
  // 单篇入口只检查并登记目标条目，避免事件面板读取全部当前材料。
  const inputSeqs =
    entryRoute && entryPath ? [z.number().int().positive().parse(Number(entryPath[1]))] : undefined
  const scope = eventScope(store, inputSeqs)
  // 可按需登记旧格式已完成决定，不调用模型，也不重新处理历史文章。
  store.synchronizeEvents(inputSeqs)
  if (listRoute) return store.events.queryEvents(eventListQuerySchema.parse(body ?? {}), scope)
  if (entryRoute && entryPath) {
    const inputSeq = z.number().int().positive().parse(Number(entryPath[1]))
    const input = store.automation.inputs([inputSeq]).find((candidate) => candidate.current)
    if (
      !input ||
      !scope.activeSources.has(input.sourceKey) ||
      store.stories.isMaterialWithdrawn(inputSeq)
    )
      throw new EventRegistryError("invalid_target")
    const decisionId = store.processingState.published([inputSeq])[0]?.decisionId ?? null
    return {
      inputSeq,
      contentVersion: input.contentVersion,
      decisionId,
      events: scope.excludedInputSeqs?.has(inputSeq)
        ? []
        : store.events
            .entryEvents(input)
            .map(({ event, membership }) => ({ event, ...membership })),
    }
  }
  if (!eventPath) return undefined
  const id = eventId.parse(eventPath[1])
  const detail = store.events.queryEvent(id, scope)
  if (!detail) throw new EventRegistryError("invalid_target")
  if (!eventPath[2])
    return {
      ...detail,
      stories: store.stories.linkedStories(id).filter((story) => {
        const revision = store.stories.currentSnapshot(story.id)
        return (
          revision &&
          revision.members.every((item) => {
            const input = store.automation.inputs([item.inputSeq])[0]
            return (
              input &&
              scope.activeSources.has(input.sourceKey) &&
              !scope.excludedInputSeqs?.has(input.seq)
            )
          })
        )
      }),
    }
  if (eventPath[2] === "members") {
    const page = store.events.queryMembers(
      eventMembersQuerySchema.parse({
        ...(method === "GET" ? {} : z.record(z.string(), z.unknown()).parse(body)),
        eventId: id,
      }),
      scope,
    )
    const sourceTitles = new Map(store.sources().map((source) => [source.key, source.title]))
    // 展示来源名称而非内部订阅键；成员、顺序和版本仍来自已冻结的检索快照。
    return {
      ...page,
      rows: page.rows.map((member) => ({
        ...member,
        sourceTitle: sourceTitles.get(member.sourceKey),
      })),
    }
  }
  const request = correction.parse(body)
  const action = request.action
  const mapped =
    action.type === "rename"
      ? { ...action, eventId: id }
      : action.type === "exclude"
        ? {
            type: "remove" as const,
            eventId: id,
            inputSeq: action.inputSeq,
            mentionId: action.mentionId,
          }
        : action.type === "move"
          ? {
              type: "move" as const,
              fromEventId: id,
              toEventId: action.targetEventId,
              inputSeq: action.inputSeq,
              mentionId: action.mentionId,
            }
          : action.type === "merge"
            ? { type: "merge" as const, sourceEventIds: [id], targetEventId: action.targetEventId }
            : action.type === "split"
              ? { ...action, eventId: id }
              : { type: "undo" as const, correctionRequestId: action.correctionId }
  let response: object | undefined
  store.transaction(() => {
    const result = store.events.correct({ ...request, action: mapped }, scope, (changed) => {
      // 仅首次关系变更让现有 Story 等待修复；请求重放不重复失效或重置用户状态。
      if (action.type !== "rename") store.stories.invalidateInputs(changed.affectedInputSeqs)
      store.stories.synchronizeEventLinks((revision) =>
        store.events.confirmedEventIdsForMembers(revision.members),
      )
    })
    const current = store.events.queryEvent(id, scope)
    response = { ...result, event: current?.event ?? result.events[0] }
  })
  return response
}
