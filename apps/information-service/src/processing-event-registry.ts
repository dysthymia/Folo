import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import { z } from "zod"

import type { AutomationStore, ProcessingInput } from "./automation-store"
import type { ProcessingDecision } from "./processing-decision"
import type { EventIdentity } from "./processing-event"
import { compatibleEvents, eventIdentitySchema, traceableRelatedEvent } from "./processing-event"
import { normalizeEventMentions } from "./processing-event-mentions"
import { sourceText } from "./service"

export class EventRegistryError extends Error {
  constructor(public readonly code: "owner_required" | "invalid_target" | "revision_conflict") {
    super(code)
  }
}
const eventIdSchema = z.string().regex(/^evt_[0-9a-f-]{36}$/u)
const mentionIdSchema = z.string().regex(/^M[1-9]\d*$/u)
const roleSchema = z.enum(["reports", "analysis_of", "tutorial_for", "mentions"])
const memberStateSchema = z.enum(["confirmed", "candidate", "excluded"])
const memberRefSchema = z
  .object({ inputSeq: z.number().int().positive(), mentionId: mentionIdSchema })
  .strict()
export const eventCorrectionSchema = z
  .object({
    requestId: z.uuid(),
    expectedRevisions: z.record(eventIdSchema, z.number().int().positive()),
    action: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("rename"),
          eventId: eventIdSchema,
          title: z.string().trim().min(1).max(500),
        })
        .strict(),
      memberRefSchema.extend({ type: z.literal("remove"), eventId: eventIdSchema }).strict(),
      memberRefSchema
        .extend({ type: z.literal("move"), fromEventId: eventIdSchema, toEventId: eventIdSchema })
        .strict(),
      z
        .object({
          type: z.literal("merge"),
          sourceEventIds: z.array(eventIdSchema).min(1).max(20),
          targetEventId: eventIdSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal("split"),
          eventId: eventIdSchema,
          groups: z
            .array(
              z
                .object({
                  title: z.string().trim().min(1).max(500),
                  members: z.array(memberRefSchema).min(1).max(1000),
                })
                .strict(),
            )
            .min(2)
            .max(10),
        })
        .strict(),
      z.object({ type: z.literal("undo"), correctionRequestId: z.uuid() }).strict(),
    ]),
  })
  .strict()
export type EventCorrection = z.infer<typeof eventCorrectionSchema>
export const eventMembersQuerySchema = z
  .object({
    eventId: eventIdSchema,
    role: roleSchema.optional(),
    state: memberStateSchema.optional(),
    order: z.enum(["newest", "oldest"]).default("newest"),
    snapshotId: z.uuid().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(30),
  })
  .strict()
export const eventListQuerySchema = z
  .object({
    search: z.string().trim().max(500).default(""),
    snapshotId: z.uuid().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(30),
  })
  .strict()
export type EventScope = {
  activeSources: ReadonlySet<string>
  excludedInputSeqs?: ReadonlySet<number>
}
export type RegistryEvent = {
  id: string
  title: string
  aliases: string[]
  identity: EventIdentity
  status: "candidate" | "confirmed" | "merged" | "split"
  revision: number
  mergedInto: string | null
  splitInto: string[]
}
export type RegistryMembership = {
  eventId: string
  inputSeq: number
  sourceKey: string
  itemId: string
  contentVersion: string
  decisionId: string
  mentionId: string
  role: z.infer<typeof roleSchema>
  isPrimary: boolean
  evidence: string[]
  state: z.infer<typeof memberStateSchema>
  origin: "automatic" | "manual"
}
export type RegistryMemberResult = RegistryMembership & {
  title: string
  url: string | null
  publishedAt: string
}
type MemberRow = { key: string; identityKey: string; membership: RegistryMembership }
type SavedEvent = { event: RegistryEvent; firstReport: boolean }
type ChangeSnapshot = { events: SavedEvent[]; members: MemberRow[] }
export type CorrectionResult = {
  correctionId: string
  eventIds: string[]
  affectedInputSeqs: number[]
  events: RegistryEvent[]
}
type CorrectionRecord = {
  before: ChangeSnapshot
  afterRevisions: Record<string, number>
  newEventIds: string[]
  affectedKeys: string[]
  result: CorrectionResult
}
const actionNames: Record<EventIdentity["action"]["value"], string> = {
  announcement: "公告",
  product_release: "发布",
  campaign: "活动",
  security_incident: "安全事件",
  regulatory_action: "监管行动",
  legal_case: "案件",
  public_statement: "声明",
  death: "去世",
  market_event: "市场事件",
  transaction: "交易",
  election: "选举",
}
function canonicalReference(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    url.hash = ""
    for (const key of [...url.searchParams.keys()])
      if (/^utm_|^(?:fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    if (["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(url.hostname)) {
      const post = /^\/[^/]+\/status\/(\d+)/u.exec(url.pathname)
      if (post) return `https://x.com/status/${post[1]}`
    }
    return url.toString().replace(/\/$/u, "")
  } catch {
    return null
  }
}
function identityKey(identity: EventIdentity) {
  const normalize = (value: string) =>
    canonicalReference(value) ?? value.trim().normalize("NFKC").toLowerCase()
  return JSON.stringify([
    normalize(identity.subject.value),
    identity.action.value,
    normalize(identity.object.value),
    identity.version ? normalize(identity.version.value) : null,
    identity.round ? normalize(identity.round.value) : null,
    identity.anchor
      ? [identity.anchor.kind, normalize(identity.anchor.value), identity.anchor.timeZone ?? null]
      : null,
  ])
}
function identityFromKey(key: string): EventIdentity | null {
  const values = JSON.parse(key) as unknown[]
  const field = (value: unknown) => ({ value, quote: "已登记身份，仅用于兼容性比较" })
  const anchor = values[5]
  const parsed = eventIdentitySchema.safeParse({
    kind: "event",
    subject: field(values[0]),
    action: field(values[1]),
    object: field(values[2]),
    version: values[3] === null ? null : field(values[3]),
    round: values[4] === null ? null : field(values[4]),
    anchor: Array.isArray(anchor)
      ? { ...field(anchor[1]), kind: anchor[0], timeZone: anchor[2] }
      : null,
  })
  return parsed.success ? parsed.data : null
}

function membershipKey(
  input: Pick<ProcessingInput, "sourceKey" | "itemId" | "contentVersion">,
  mentionId: string,
) {
  return JSON.stringify([input.sourceKey, input.itemId, input.contentVersion, mentionId])
}
function officialReferencesMatch(left: EventIdentity, right: EventIdentity) {
  if (left.anchor?.kind !== "official_reference" || right.anchor?.kind !== "official_reference")
    return true
  return canonicalReference(left.anchor.value) === canonicalReference(right.anchor.value)
}

// 事件登记只处理同账号已发布材料，不调用模型，不创建 Story，也不按主题或标题聚类。
export class ProcessingEventRegistry {
  constructor(
    private readonly db: DatabaseSync,
    private readonly automation: AutomationStore,
    private readonly ownerId: () => string | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processing_events(id TEXT PRIMARY KEY,body TEXT NOT NULL,first_report INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_event_members(member_key TEXT PRIMARY KEY,event_id TEXT NOT NULL,input_seq INTEGER NOT NULL,source_key TEXT NOT NULL,item_id TEXT NOT NULL,content_version TEXT NOT NULL,decision_id TEXT NOT NULL,identity_key TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processing_event_member_event ON processing_event_members(event_id,input_seq);
      CREATE INDEX IF NOT EXISTS processing_event_member_input ON processing_event_members(input_seq);
      CREATE TABLE IF NOT EXISTS processing_event_publications(input_seq INTEGER PRIMARY KEY,content_version TEXT NOT NULL,decision_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_event_corrections(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_event_snapshots(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,query TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processing_event_snapshot_time ON processing_event_snapshots(created_at);
    `)
  }

  publish(input: ProcessingInput, _decision: ProcessingDecision, decisionId: string) {
    this.requireOwner()
    return this.transaction(() => {
      // 必须读取当前指针指向的不可变结果，重发的新输出不能改写已登记身份。
      const row = this.db
        .prepare(
          "SELECT decisions.body,current.body AS input_body FROM processing_inputs current JOIN entry_decisions decisions ON decisions.id=current.decision_id AND decisions.input_seq=current.seq AND decisions.generation=current.generation AND decisions.release_version=current.release_version WHERE current.seq=? AND current.current=1 AND current.status='succeeded' AND current.content_version=? AND current.generation=? AND current.release_version=? AND current.decision_id=? AND current.source_key=? AND current.item_id=?",
        )
        .get(
          input.seq,
          input.contentVersion,
          input.generation,
          input.releaseVersion,
          decisionId,
          input.sourceKey,
          input.itemId,
        )
      if (!row) return { eventIds: [], affectedInputSeqs: [] }
      const decision = JSON.parse(String(row.body)) as ProcessingDecision
      input = { ...input, body: JSON.parse(String(row.input_body)) as ProcessingInput["body"] }
      const publication = this.db
        .prepare(
          "SELECT decision_id FROM processing_event_publications WHERE input_seq=? AND content_version=?",
        )
        .get(input.seq, input.contentVersion)
      if (publication?.decision_id === decisionId) {
        // 按当前指针定向返回关系，批量幂等同步不能逐篇扫描全部成员。
        const eventIds = this.db
          .prepare(
            "SELECT DISTINCT event_id FROM processing_event_members WHERE input_seq=? AND content_version=? AND decision_id=?",
          )
          .all(input.seq, input.contentVersion, decisionId)
          .map((row) => String(row.event_id))
        return { eventIds, affectedInputSeqs: [] }
      }
      const text = sourceText(input.body.content ?? "")
      const allRows = this.memberRows()
      const currentKeys = new Set(
        this.currentMembers()
          .filter((member) => member.state === "confirmed")
          .map((member) => membershipKey(member, member.mentionId)),
      )
      const compatibleWithMembers = (eventId: string, identity: EventIdentity) =>
        allRows
          .filter((row) => row.membership.eventId === eventId && currentKeys.has(row.key))
          .every((row) => {
            const known = identityFromKey(row.identityKey)
            return (
              known !== null &&
              compatibleEvents(known, identity) &&
              officialReferencesMatch(known, identity)
            )
          })
      const previous = allRows.filter(
        (member) =>
          member.membership.sourceKey === input.sourceKey &&
          member.membership.itemId === input.itemId &&
          member.membership.contentVersion === input.contentVersion,
      )
      const changed = new Set<string>()
      const hasManualRelation = previous.some((member) => member.membership.origin === "manual")
      // 人工排除、移动及拆分绑定材料版本；同材料重跑只能更新发布指针，不能复活旧关系。
      for (const member of previous.filter((item) => item.membership.origin === "manual")) {
        const updated = {
          ...member,
          membership: { ...member.membership, inputSeq: input.seq, decisionId },
        }
        this.saveMember(updated)
        allRows[allRows.indexOf(member)] = updated
        if (updated.membership.state === "confirmed") currentKeys.add(updated.key)
        changed.add(member.membership.eventId)
      }
      const mentions = decision.semantic
        ? normalizeEventMentions(decision.semantic).slice(0, 4)
        : []
      for (const mention of mentions) {
        const parsed = eventIdentitySchema.safeParse(mention.identity)
        if (!parsed.success) continue
        const identity: EventIdentity = { ...parsed.data, kind: "event" }
        const evidence = [
          ...new Set(
            [
              identity.subject,
              identity.action,
              identity.object,
              identity.version,
              identity.round,
              identity.anchor,
            ].flatMap((field) => (field ? [field.quote] : [])),
          ),
        ]
        if (!evidence.length || evidence.some((quote) => !text.includes(quote))) continue
        const key = identityKey(identity)
        const existing = previous.find((member) => member.identityKey === key)
        if (existing?.membership.origin === "manual") continue
        // 同正文已有人工纠错时，身份漂移产生的新提及只能等待确认；重复重跑也不能提升候选。
        const needsIdentityReview =
          hasManualRelation && (!existing || existing.membership.state === "candidate")
        const valid =
          !needsIdentityReview &&
          traceableRelatedEvent(parsed.data, text) !== null &&
          this.validOfficialReference(identity, input)
        const candidates = valid
          ? this.events().filter(
              (event) =>
                event.status === "confirmed" &&
                allRows.some(
                  (row) => row.membership.eventId === event.id && currentKeys.has(row.key),
                ) &&
                compatibleEvents(event.identity, identity) &&
                officialReferencesMatch(event.identity, identity) &&
                compatibleWithMembers(event.id, identity),
            )
          : []
        let event = candidates.length === 1 ? candidates[0]! : undefined
        let state: RegistryMembership["state"] =
          valid && candidates.length <= 1 ? "confirmed" : "candidate"
        if (!event && existing) {
          const previousEvent = this.event(existing.membership.eventId)
          if (
            previousEvent &&
            ["candidate", "confirmed"].includes(previousEvent.status) &&
            identityKey(previousEvent.identity) === key &&
            (previousEvent.status !== "confirmed" ||
              compatibleWithMembers(previousEvent.id, identity))
          )
            event = previousEvent
        }
        if (!event) {
          event = {
            id: `evt_${randomUUID()}`,
            title: mention.role === "reports" ? decision.title : this.identityTitle(identity),
            aliases: [],
            identity,
            status: state,
            revision: 1,
            mergedInto: null,
            splitInto: [],
          }
          this.saveEvent(event, mention.role === "reports")
        } else if (valid && event.status === "candidate" && candidates.length === 0) {
          event = { ...event, status: "confirmed", identity, revision: event.revision + 1 }
          state = "confirmed"
          this.saveEvent(event, this.savedEvent(event.id)!.firstReport)
        }
        const saved = this.savedEvent(event.id)!
        if (mention.role === "reports" && !saved.firstReport) {
          event = {
            ...event,
            title: decision.title,
            aliases: [...new Set([...event.aliases, event.title])],
            revision: event.revision + 1,
          }
          this.saveEvent(event, true)
        } else if (decision.title !== event.title && !event.aliases.includes(decision.title)) {
          event = {
            ...event,
            aliases: [...event.aliases, decision.title].slice(-50),
            revision: event.revision + 1,
          }
          this.saveEvent(event, saved.firstReport)
        }
        const mentionId =
          existing?.membership.mentionId ??
          `M${Math.max(0, ...previous.map((member) => Number(member.membership.mentionId.slice(1)))) + 1}`
        const member: MemberRow = {
          key: membershipKey(input, mentionId),
          identityKey: key,
          membership: {
            eventId: event.id,
            inputSeq: input.seq,
            sourceKey: input.sourceKey,
            itemId: input.itemId,
            contentVersion: input.contentVersion,
            decisionId,
            mentionId,
            role: mention.role,
            isPrimary: mention.isPrimary,
            evidence,
            state,
            origin: "automatic",
          },
        }
        this.saveMember(member)
        // 同一篇的后续提及也必须核验本轮已登记成员，不能由首项未知版本桥接两个冲突版本。
        const previousIndex = allRows.findIndex((row) => row.key === member.key)
        if (previousIndex >= 0) allRows[previousIndex] = member
        else allRows.push(member)
        if (member.membership.state === "confirmed") currentKeys.add(member.key)
        else currentKeys.delete(member.key)
        previous.push(member)
        changed.add(event.id)
      }
      for (const id of changed) this.bumpEvent(id)
      this.db
        .prepare(
          "INSERT INTO processing_event_publications VALUES(?,?,?) ON CONFLICT(input_seq) DO UPDATE SET content_version=excluded.content_version,decision_id=excluded.decision_id",
        )
        .run(input.seq, input.contentVersion, decisionId)
      return { eventIds: [...changed], affectedInputSeqs: changed.size ? [input.seq] : [] }
    })
  }

  entryEvents(
    input: ProcessingInput,
  ): Array<{ event: RegistryEvent; membership: RegistryMembership }> {
    this.requireOwner()
    return this.currentMembers([input.seq])
      .filter((member) => member.contentVersion === input.contentVersion)
      .flatMap((membership) => {
        const event = this.event(membership.eventId)
        return event ? [{ event, membership }] : []
      })
  }

  confirmedEventIdsForMembers(
    members: readonly { inputSeq: number; decisionId: string }[],
  ): string[] {
    this.requireOwner()
    if (!members.length) return []
    const current = this.currentMembers(members.map((member) => member.inputSeq))
    let common: string | undefined
    for (const ref of members) {
      // 确认唯一主报道关系；次要背景提及不改变主归属，逐事实隔离由 Story 发布边界执行。
      const mentions = current.filter(
        (member) =>
          member.inputSeq === ref.inputSeq &&
          member.decisionId === ref.decisionId &&
          member.isPrimary,
      )
      if (
        mentions.length !== 1 ||
        mentions[0]!.state !== "confirmed" ||
        mentions[0]!.role !== "reports" ||
        !mentions[0]!.isPrimary
      )
        return []
      const event = this.event(mentions[0]!.eventId)
      if (!event || event.status !== "confirmed" || (common && common !== event.id)) return []
      common = event.id
    }
    return common ? [common] : []
  }

  queryEvent(eventId: string, scope: EventScope) {
    this.requireOwner()
    const event = this.event(eventId)
    if (!event) return null
    const members = this.scopedMembers(scope)
    const visible = this.visibleEventIds(scope)
    if (!visible.has(event.id)) throw new EventRegistryError("invalid_target")
    const successorIds = event.mergedInto ? [event.mergedInto] : event.splitInto
    return {
      event,
      membershipCount: members.filter(
        (member) => member.eventId === event.id && member.state !== "excluded",
      ).length,
      successors: successorIds.flatMap((id) => {
        const child = this.event(id)
        return child && visible.has(id) ? [child] : []
      }),
    }
  }

  queryMembers(request: z.input<typeof eventMembersQuerySchema>, scope: EventScope) {
    this.requireOwner()
    const { snapshotId, offset, limit, ...filter } = eventMembersQuerySchema.parse(request)
    const event = this.queryEvent(filter.eventId, scope)
    if (!event) throw new EventRegistryError("invalid_target")
    const currentMembers = this.scopedMembers(scope).filter(
      (member) => member.eventId === filter.eventId,
    )
    const key = JSON.stringify({
      type: "members",
      filter,
      scope: this.scopeKey(scope),
      revision: {
        event: event.event.revision,
        members: this.memberPointerSignature(currentMembers),
      },
    })
    const snapshot = this.snapshot<RegistryMemberResult>(snapshotId, key, () => {
      const scoped = currentMembers.filter(
        (member) =>
          (!filter.role || member.role === filter.role) &&
          (filter.state ? member.state === filter.state : member.state !== "excluded"),
      )
      const inputs = new Map(
        this.automation
          .inputs(scoped.map((member) => member.inputSeq))
          .map((input) => [input.seq, input]),
      )
      return scoped
        .map((member) => ({
          ...member,
          title: inputs.get(member.inputSeq)!.body.title,
          url: inputs.get(member.inputSeq)!.body.url,
          publishedAt: inputs.get(member.inputSeq)!.body.publishedAt,
        }))
        .sort(
          (a, b) =>
            (filter.order === "oldest" ? 1 : -1) *
            (Date.parse(a.publishedAt) - Date.parse(b.publishedAt) ||
              a.inputSeq - b.inputSeq ||
              a.mentionId.localeCompare(b.mentionId)),
        )
    })
    return {
      snapshotId: snapshot.id,
      rows: snapshot.rows.slice(offset, offset + limit),
      total: snapshot.rows.length,
      nextOffset: offset + limit < snapshot.rows.length ? offset + limit : null,
    }
  }

  queryEvents(request: z.input<typeof eventListQuerySchema>, scope: EventScope) {
    this.requireOwner()
    const { snapshotId, offset, limit, ...filter } = eventListQuerySchema.parse(request)
    const currentMembers = this.scopedMembers(scope)
    const key = JSON.stringify({
      type: "events",
      filter,
      scope: this.scopeKey(scope),
      revision: {
        events: this.events().map((event) => [event.id, event.revision]),
        members: this.memberPointerSignature(currentMembers),
      },
    })
    const snapshot = this.snapshot<RegistryEvent>(snapshotId, key, () => {
      const visible = new Set(
        currentMembers
          .filter((member) => member.state !== "excluded")
          .map((member) => member.eventId),
      )
      const search = filter.search.normalize("NFKC").toLowerCase()
      return this.events().filter(
        (event) =>
          visible.has(event.id) &&
          !["merged", "split"].includes(event.status) &&
          (!search ||
            [event.title, ...event.aliases].some((name) =>
              name.normalize("NFKC").toLowerCase().includes(search),
            )),
      )
    })
    return {
      snapshotId: snapshot.id,
      events: snapshot.rows.slice(offset, offset + limit),
      total: snapshot.rows.length,
      nextOffset: offset + limit < snapshot.rows.length ? offset + limit : null,
    }
  }

  correct(
    raw: EventCorrection,
    scope: EventScope,
    afterChange?: (result: CorrectionResult) => void,
  ): CorrectionResult {
    const ownerId = this.requireOwner()
    const request = eventCorrectionSchema.parse(raw)
    return this.transaction(() => {
      const encoded = JSON.stringify(request)
      const replay = this.db
        .prepare("SELECT owner_id,request,body FROM processing_event_corrections WHERE id=?")
        .get(request.requestId)
      if (replay) {
        if (replay.owner_id !== ownerId || replay.request !== encoded)
          throw new EventRegistryError("revision_conflict")
        return (JSON.parse(String(replay.body)) as CorrectionRecord).result
      }
      const action = request.action
      const undoRow =
        action.type === "undo"
          ? this.db
              .prepare("SELECT body FROM processing_event_corrections WHERE id=? AND owner_id=?")
              .get(action.correctionRequestId, ownerId)
          : undefined
      const undo = undoRow ? (JSON.parse(String(undoRow.body)) as CorrectionRecord) : undefined
      if (action.type === "undo" && !undo) throw new EventRegistryError("invalid_target")
      const ids =
        action.type === "rename" || action.type === "remove" || action.type === "split"
          ? [action.eventId]
          : action.type === "move"
            ? [action.fromEventId, action.toEventId]
            : action.type === "merge"
              ? [...action.sourceEventIds, action.targetEventId]
              : Object.keys(undo!.afterRevisions)
      if (new Set(ids).size !== ids.length) throw new EventRegistryError("invalid_target")
      for (const id of ids) {
        if (!this.queryEvent(id, scope)) throw new EventRegistryError("invalid_target")
        const event = this.event(id)!
        if (request.expectedRevisions[id] !== event.revision)
          throw new EventRegistryError("revision_conflict")
        if (action.type === "undo" && undo!.afterRevisions[id] !== event.revision)
          throw new EventRegistryError("revision_conflict")
      }
      const current = this.currentMembers()
      const currentKeys = new Set(current.map((member) => membershipKey(member, member.mentionId)))
      const scopedKeys = new Set(
        this.scopedMembers(scope).map((member) => membershipKey(member, member.mentionId)),
      )
      // 合并或拆分是事件级变更，不能把预览范围外的仍有效成员隐式一起改动。
      if (
        (action.type === "merge" || action.type === "split") &&
        current.some(
          (member) =>
            ids.includes(member.eventId) &&
            member.state !== "excluded" &&
            !scopedKeys.has(membershipKey(member, member.mentionId)),
        )
      )
        throw new EventRegistryError("invalid_target")
      // 旧正文、旧决定或未完成的新代际不得因撤销恢复；历史纠错不能改写当前材料。
      if (undo && undo.affectedKeys.some((key) => !currentKeys.has(key)))
        throw new EventRegistryError("revision_conflict")
      const rows = this.memberRows().filter((member) => ids.includes(member.membership.eventId))
      const before: ChangeSnapshot = {
        events: ids.map((id) => this.savedEvent(id)!),
        members: rows,
      }
      const changed = new Set(ids)
      const newEventIds: string[] = []
      const affectedKeys = new Set<string>()
      const touch = (row: MemberRow, changes: Partial<RegistryMembership>) => {
        this.saveMember({ ...row, membership: { ...row.membership, ...changes, origin: "manual" } })
        affectedKeys.add(row.key)
      }
      const find = (eventId: string, inputSeq: number, mentionId: string) => {
        const member = rows.find(
          (row) =>
            row.membership.eventId === eventId &&
            row.membership.inputSeq === inputSeq &&
            row.membership.mentionId === mentionId,
        )
        if (
          !member ||
          !this.scopedMembers(scope).some(
            (row) =>
              row.inputSeq === inputSeq && row.mentionId === mentionId && row.eventId === eventId,
          )
        )
          throw new EventRegistryError("invalid_target")
        return member
      }
      if (action.type === "rename") {
        const event = this.event(action.eventId)!
        this.saveEvent(
          { ...event, title: action.title, aliases: [...new Set([...event.aliases, event.title])] },
          // 人工名称优先，不再被随后首篇 reports 的自动标题覆盖。
          true,
        )
      } else if (action.type === "remove") {
        touch(find(action.eventId, action.inputSeq, action.mentionId), { state: "excluded" })
      } else if (action.type === "move") {
        if (["merged", "split"].includes(this.event(action.toEventId)!.status))
          throw new EventRegistryError("invalid_target")
        touch(find(action.fromEventId, action.inputSeq, action.mentionId), {
          eventId: action.toEventId,
          state: "confirmed",
        })
      } else if (action.type === "merge") {
        if (ids.some((id) => ["merged", "split"].includes(this.event(id)!.status)))
          throw new EventRegistryError("invalid_target")
        for (const sourceId of action.sourceEventIds) {
          const source = this.event(sourceId)!
          this.saveEvent(
            { ...source, status: "merged", mergedInto: action.targetEventId, splitInto: [] },
            this.savedEvent(sourceId)!.firstReport,
          )
          for (const row of rows.filter(
            (row) =>
              row.membership.eventId === sourceId &&
              currentKeys.has(row.key) &&
              scopedKeys.has(row.key),
          ))
            touch(row, { eventId: action.targetEventId })
        }
      } else if (action.type === "split") {
        const event = this.event(action.eventId)!
        if (["merged", "split"].includes(event.status))
          throw new EventRegistryError("invalid_target")
        const seen = new Set<string>()
        for (const group of action.groups) {
          const groupRows = group.members.map((ref) =>
            find(action.eventId, ref.inputSeq, ref.mentionId),
          )
          for (const row of groupRows) {
            if (seen.has(row.key)) throw new EventRegistryError("invalid_target")
            seen.add(row.key)
          }
          const groupIdentities = groupRows.map((row) => this.identityForMember(row))
          if (
            groupIdentities.includes(null) ||
            groupIdentities.some((identity, index) =>
              groupIdentities
                .slice(index + 1)
                .some(
                  (other) =>
                    !compatibleEvents(identity!, other!) ||
                    !officialReferencesMatch(identity!, other!),
                ),
            )
          )
            throw new EventRegistryError("invalid_target")
          const child: RegistryEvent = {
            ...event,
            // 新事件采用本组原始证据对应的身份，不继承父事件另一版本的身份。
            identity: groupIdentities[0]!,
            id: `evt_${randomUUID()}`,
            title: group.title,
            aliases: [],
            revision: 1,
            mergedInto: null,
            splitInto: [],
          }
          this.saveEvent(child, true)
          newEventIds.push(child.id)
          changed.add(child.id)
          for (const row of groupRows) touch(row, { eventId: child.id })
        }
        const visibleMembers = this.scopedMembers(scope).filter(
          (row) => row.eventId === action.eventId && row.state !== "excluded",
        )
        if (visibleMembers.length) throw new EventRegistryError("invalid_target")
        this.saveEvent(
          { ...event, status: "split", splitInto: newEventIds, mergedInto: null },
          this.savedEvent(event.id)!.firstReport,
        )
      } else {
        for (const saved of undo!.before.events) {
          const current = this.event(saved.event.id)!
          this.saveEvent({ ...saved.event, revision: current.revision }, saved.firstReport)
        }
        for (const row of undo!.before.members.filter((row) =>
          undo!.affectedKeys.includes(row.key),
        )) {
          // 只恢复原纠错实际触及的成员，不覆盖随后新增的无关文章或其它事件。
          this.saveMember(row)
          affectedKeys.add(row.key)
        }
        const parent = undo!.before.events[0]?.event.id
        for (const id of undo!.newEventIds) {
          const child = this.event(id)!
          this.saveEvent(
            { ...child, status: "merged", mergedInto: parent ?? null, splitInto: [] },
            this.savedEvent(id)!.firstReport,
          )
        }
      }
      for (const id of changed) this.bumpEvent(id)
      const affectedInputSeqs = [
        ...new Set([
          ...rows
            .filter((row) => affectedKeys.has(row.key) || action.type === "rename")
            .map((row) => row.membership.inputSeq),
          ...(action.type === "undo" ? undo!.result.affectedInputSeqs : []),
        ]),
      ]
      const eventIds = [...changed]
      const result: CorrectionResult = {
        correctionId: request.requestId,
        eventIds,
        affectedInputSeqs,
        events: eventIds.map((id) => this.event(id)!),
      }
      const record: CorrectionRecord = {
        before,
        afterRevisions: Object.fromEntries(
          result.events.map((event) => [event.id, event.revision]),
        ),
        newEventIds,
        affectedKeys: [...affectedKeys],
        result,
      }
      this.db
        .prepare("INSERT INTO processing_event_corrections VALUES(?,?,?,?)")
        .run(request.requestId, ownerId, encoded, JSON.stringify(record))
      // 关联 Story 的同步副作用与纠错同事务，只在首次请求执行；重放直接返回保存的结果。
      afterChange?.(result)
      return result
    })
  }

  private currentMembers(inputSeqs?: readonly number[]): RegistryMembership[] {
    if (inputSeqs && !inputSeqs.length) return []
    // 按原文主键缩小成员读取，同时继续核验当前正文、发布代次和决定指针。
    const inputFilter = inputSeqs
      ? ` WHERE members.input_seq IN (${inputSeqs.map(() => "?").join(",")})`
      : ""
    return this.db
      .prepare(
        `SELECT members.body FROM processing_event_members members JOIN processing_inputs current ON current.seq=members.input_seq AND current.current=1 AND current.status='succeeded' AND current.content_version=members.content_version AND current.decision_id=members.decision_id JOIN entry_decisions decisions ON decisions.id=current.decision_id AND decisions.generation=current.generation AND decisions.release_version=current.release_version${
          inputFilter
        }`,
      )
      .all(...(inputSeqs ?? []))
      .map((row) => JSON.parse(String(row.body)) as RegistryMembership)
  }
  private scopedMembers(scope: EventScope) {
    return this.currentMembers().filter(
      (member) =>
        scope.activeSources.has(member.sourceKey) && !scope.excludedInputSeqs?.has(member.inputSeq),
    )
  }
  private visibleEventIds(scope: EventScope) {
    const scoped = this.scopedMembers(scope)
    const ids = new Set(scoped.map((member) => member.eventId))
    const visibleKeys = new Set(scoped.map((member) => membershipKey(member, member.mentionId)))
    // 手工移出后原事件可能暂时没有成员；当前授权材料的关系历史仍允许打开原链接并撤销。
    for (const row of this.db.prepare("SELECT body FROM processing_event_corrections").all()) {
      const correction = JSON.parse(String(row.body)) as CorrectionRecord
      for (const previous of correction.before.members)
        if (visibleKeys.has(previous.key)) ids.add(previous.membership.eventId)
    }
    // 合并和拆分前的链接沿后继可寻址，不泄漏不在当前来源授权内的事件。
    for (let step = 0; step < 20; step++) {
      let changed = false
      for (const event of this.events())
        if (
          !ids.has(event.id) &&
          (event.mergedInto ? ids.has(event.mergedInto) : event.splitInto.some((id) => ids.has(id)))
        ) {
          ids.add(event.id)
          changed = true
        }
      if (!changed) break
    }
    return ids
  }
  // 当前正文/结果指针失效不一定递增事件修订号，快照仍必须拒绝已失效材料。
  private memberPointerSignature(members: readonly RegistryMembership[]) {
    return members
      .map((member) =>
        JSON.stringify([
          member.eventId,
          member.inputSeq,
          member.sourceKey,
          member.itemId,
          member.contentVersion,
          member.decisionId,
          member.mentionId,
          member.state,
        ]),
      )
      .sort()
  }

  private scopeKey(scope: EventScope) {
    return {
      activeSources: [...scope.activeSources].sort(),
      excludedInputSeqs: [...(scope.excludedInputSeqs ?? [])].sort((a, b) => a - b),
    }
  }
  private event(id: string): RegistryEvent | null {
    return this.savedEvent(id)?.event ?? null
  }
  private savedEvent(id: string): SavedEvent | null {
    const row = this.db
      .prepare("SELECT body,first_report FROM processing_events WHERE id=?")
      .get(id)
    return row
      ? {
          event: JSON.parse(String(row.body)) as RegistryEvent,
          firstReport: Boolean(row.first_report),
        }
      : null
  }
  private events(): RegistryEvent[] {
    return this.db
      .prepare("SELECT body FROM processing_events ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.body)) as RegistryEvent)
  }
  private saveEvent(event: RegistryEvent, firstReport: boolean) {
    this.db
      .prepare(
        "INSERT INTO processing_events VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,first_report=excluded.first_report",
      )
      .run(event.id, JSON.stringify(event), Number(firstReport))
  }
  private bumpEvent(id: string) {
    const saved = this.savedEvent(id)!
    this.saveEvent({ ...saved.event, revision: saved.event.revision + 1 }, saved.firstReport)
  }
  private memberRows(): MemberRow[] {
    return this.db
      .prepare("SELECT member_key,identity_key,body FROM processing_event_members")
      .all()
      .map((row) => ({
        key: String(row.member_key),
        identityKey: String(row.identity_key),
        membership: JSON.parse(String(row.body)) as RegistryMembership,
      }))
  }
  private saveMember(row: MemberRow) {
    const member = row.membership
    this.db
      .prepare(
        "INSERT INTO processing_event_members VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(member_key) DO UPDATE SET event_id=excluded.event_id,input_seq=excluded.input_seq,decision_id=excluded.decision_id,identity_key=excluded.identity_key,body=excluded.body",
      )
      .run(
        row.key,
        member.eventId,
        member.inputSeq,
        member.sourceKey,
        member.itemId,
        member.contentVersion,
        member.decisionId,
        row.identityKey,
        JSON.stringify(member),
      )
  }
  private identityForMember(row: MemberRow): EventIdentity | null {
    // 人工覆盖可能沿用较早模型证据；从相同材料版本的不可变决定恢复原始字段及 quote。
    const member = row.membership
    const decisions = this.db
      .prepare(
        "SELECT decisions.body FROM entry_decisions decisions JOIN processing_inputs inputs ON inputs.seq=decisions.input_seq WHERE inputs.source_key=? AND inputs.item_id=? AND inputs.content_version=? ORDER BY decisions.generation DESC",
      )
      .all(member.sourceKey, member.itemId, member.contentVersion)
    for (const saved of decisions) {
      const decision = JSON.parse(String(saved.body)) as ProcessingDecision
      if (!decision.semantic) continue
      const mention = normalizeEventMentions(decision.semantic).find(
        (item) => identityKey(item.identity) === row.identityKey,
      )
      if (mention) return { ...mention.identity, kind: "event" }
    }
    return null
  }

  private identityTitle(identity: EventIdentity) {
    return `${identity.subject.value} ${actionNames[identity.action.value]} ${identity.object.value}${identity.version ? ` ${identity.version.value}` : ""}`
  }
  private validOfficialReference(identity: EventIdentity, input: ProcessingInput) {
    if (identity.anchor?.kind !== "official_reference") return true
    const reference = canonicalReference(identity.anchor.value)
    if (!reference) return false
    const raw = `${input.body.content ?? ""}\n${input.body.originalContent ?? ""}`
    const urls = [...raw.matchAll(/https?:\/\/[^\s<>"']+/gu)].map((match) =>
      match[0].replace(/[。，；！?)）\],.;]+$/gu, ""),
    )
    if (input.body.url) urls.push(input.body.url)
    for (const link of input.body.linkedMaterials ?? [])
      if (link.status === "complete") {
        urls.push(link.url)
        if (link.resolvedUrl) urls.push(link.resolvedUrl)
      }
    return urls.some((url) => canonicalReference(url.replaceAll("&amp;", "&")) === reference)
  }
  private snapshot<T>(id: string | undefined, key: string, create: () => T[]) {
    const owner = this.requireOwner()
    this.cleanSnapshots()
    if (id) {
      const row = this.db
        .prepare("SELECT body,query FROM processing_event_snapshots WHERE id=? AND owner_id=?")
        .get(id, owner)
      if (!row) throw new EventRegistryError("invalid_target")
      if (row.query !== key) {
        const previous = JSON.parse(String(row.query)) as Record<string, unknown>
        const current = JSON.parse(key) as Record<string, unknown>
        delete previous.revision
        delete current.revision
        delete previous.scope
        delete current.scope
        throw new EventRegistryError(
          JSON.stringify(previous) === JSON.stringify(current)
            ? "revision_conflict"
            : "invalid_target",
        )
      }
      return { id, rows: JSON.parse(String(row.body)) as T[] }
    }
    const rows = create()
    id = randomUUID()
    this.db
      .prepare("INSERT INTO processing_event_snapshots VALUES(?,?,?,?,?)")
      .run(id, owner, key, JSON.stringify(rows), new Date().toISOString())
    this.cleanSnapshots()
    return { id, rows }
  }
  private cleanSnapshots() {
    this.db
      .prepare("DELETE FROM processing_event_snapshots WHERE created_at<=?")
      .run(new Date(Date.now() - 86_400_000).toISOString())
    this.db
      .prepare(
        "DELETE FROM processing_event_snapshots WHERE id IN (SELECT id FROM processing_event_snapshots ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 100)",
      )
      .run()
  }
  private requireOwner() {
    const owner = this.ownerId()
    if (!owner) throw new EventRegistryError("owner_required")
    return owner
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT event_registry_write")
    try {
      const result = operation()
      this.db.exec("RELEASE event_registry_write")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK TO event_registry_write; RELEASE event_registry_write")
      throw error
    }
  }
}
