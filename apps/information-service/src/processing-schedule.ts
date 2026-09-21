import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { ScheduleScope } from "@follow/information-core"
import { scheduleScopeSchema } from "@follow/information-core"

export const defaultScheduleTimes = ["08:00", "12:00", "15:00", "20:00", "23:00"] as const

export type ProcessingScheduleInput = {
  /** 运行范围描述符（§2 D4）。旧调用方只传 sourceKeys 时退化为 fixed。 */
  scope?: ScheduleScope
  sourceKeys: readonly string[]
  historySince: string
  timeZone: string
  enabled: boolean
  times?: readonly string[]
  pollIntervalMinutes?: number | null
  readyBy?: { leadMinutes: number } | null
}

export type ProcessingScheduleConfig = {
  /** 运行范围描述符（§2 D4）。旧记录读为 fixed。 */
  scope: ScheduleScope
  /** 已解析的实际范围名单；fixed 与描述符一致，all/category 由 client 落库。 */
  sourceKeys: string[]
  historySince: string
  timeZone: string
  enabled: boolean
  times: string[]
  pollIntervalMinutes: number | null
  readyBy: { leadMinutes: number } | null
}

export type ProcessingScheduleSnapshot = {
  revision: number
  config: ProcessingScheduleConfig | null
}

export type ProcessingScheduleReadingStatus = {
  revision: number
  enabled: boolean
  timeZone: string | null
  nextScheduledStartLocal: string | null
  nextScheduledReadyLocal: string | null
  readyByLeadMinutes: number | null
  pollIntervalMinutes: number | null
  nextPollAt: string | null
}

export type ProcessingTriggerKind = "scheduled" | "catchup" | "poll" | "manual"
export type ProcessingTriggerStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "retry_wait"
  | "needs_context"
  | "deferred_budget"
  | "failed"
  | "cancelled"

export type ProcessingTrigger = {
  id: string
  kind: ProcessingTriggerKind
  dedupeKey: string
  configRevision: number
  sourceKeys: string[]
  historySince: string
  timeZone: string
  scheduledFor: string | null
  cutoffAt: string
  status: ProcessingTriggerStatus
  leaseToken: string | null
  leaseUntil: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export class ProcessingScheduleError extends Error {
  constructor(
    public readonly code:
      | "owner_required"
      | "owner_mismatch"
      | "revision_conflict"
      | "invalid_schedule"
      | "invalid_time"
      | "invalid_timezone"
      | "invalid_source_keys"
      | "invalid_dedupe_key",
  ) {
    super(code)
    this.name = "ProcessingScheduleError"
  }
}

type LocalTime = { date: string; minute: number }
type TriggerDraft = Omit<
  ProcessingTrigger,
  "id" | "status" | "leaseToken" | "leaseUntil" | "startedAt" | "finishedAt" | "error"
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function parseIso(value: unknown, code: "invalid_schedule" | "invalid_time"): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new ProcessingScheduleError(code)
  return new Date(value).toISOString()
}

function parseTime(value: unknown): { value: string; minute: number } {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))
    throw new ProcessingScheduleError("invalid_schedule")
  const hour = Number(value.slice(0, 2))
  const minute = Number(value.slice(3, 5))
  return { value, minute: hour * 60 + minute }
}

function sourceKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string"))
    throw new ProcessingScheduleError("invalid_source_keys")
  const keys = unique(value)
  if (
    !keys.length ||
    keys.some(
      (key) =>
        !/^(?:(?:feed|list|inbox)\/[^/\s]+|x\/search\/[^/\s]+)$/u.test(key) || key.length > 300,
    )
  )
    throw new ProcessingScheduleError("invalid_source_keys")
  return keys.sort()
}

function timeZone(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ProcessingScheduleError("invalid_timezone")
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format()
    return value
  } catch {
    throw new ProcessingScheduleError("invalid_timezone")
  }
}

function normalizeConfig(input: unknown): ProcessingScheduleConfig {
  if (!isRecord(input) || typeof input.enabled !== "boolean")
    throw new ProcessingScheduleError("invalid_schedule")
  const timesValue = input.times === undefined ? defaultScheduleTimes : input.times
  if (!Array.isArray(timesValue)) throw new ProcessingScheduleError("invalid_schedule")
  const times = unique(timesValue.map((value) => parseTime(value).value)).sort()
  if (!times.length || times.length > 10) throw new ProcessingScheduleError("invalid_schedule")
  const readyBy =
    input.readyBy === undefined || input.readyBy === null
      ? null
      : isRecord(input.readyBy) &&
          typeof input.readyBy.leadMinutes === "number" &&
          Number.isInteger(input.readyBy.leadMinutes) &&
          input.readyBy.leadMinutes > 0 &&
          input.readyBy.leadMinutes <= 720
        ? { leadMinutes: input.readyBy.leadMinutes }
        : (() => {
            throw new ProcessingScheduleError("invalid_schedule")
          })()
  // 首版将 ready_by 限制在同一当地日期，避免跨日启动被误写成前一天的计划时点。
  if (readyBy && readyBy.leadMinutes > Math.min(...times.map((value) => parseTime(value).minute)))
    throw new ProcessingScheduleError("invalid_schedule")
  const pollIntervalMinutes =
    input.pollIntervalMinutes === undefined || input.pollIntervalMinutes === null
      ? null
      : typeof input.pollIntervalMinutes === "number" &&
          Number.isInteger(input.pollIntervalMinutes) &&
          input.pollIntervalMinutes >= 5 &&
          input.pollIntervalMinutes <= 24 * 60
        ? input.pollIntervalMinutes
        : (() => {
            throw new ProcessingScheduleError("invalid_schedule")
          })()
  // 运行范围三态（§2 D4）：新格式显式带 mode 描述符；旧记录只有扁平 sourceKeys，等价 fixed。
  const parsedScope = isRecord(input.scope) ? scheduleScopeSchema.safeParse(input.scope) : null
  let scope: ScheduleScope
  let resolvedKeys: string[]
  if (parsedScope?.success) {
    scope = parsedScope.data
    if (scope.mode === "fixed") {
      resolvedKeys = sourceKeys(scope.sourceKeys)
      // 描述符是 fixed 的权威名单：顶层扁平字段与它不一致时以描述符为准，避免两份名单漂移。
      scope = { mode: "fixed", sourceKeys: resolvedKeys }
    } else {
      // all / category 的已解析名单由 client 落库；服务端只校验 + 排序，不做独立分类解析。
      resolvedKeys = sourceKeys(input.sourceKeys)
    }
  } else if (Array.isArray(input.sourceKeys)) {
    resolvedKeys = sourceKeys(input.sourceKeys)
    scope = { mode: "fixed", sourceKeys: resolvedKeys }
  } else {
    throw new ProcessingScheduleError("invalid_schedule")
  }
  return {
    scope,
    sourceKeys: resolvedKeys,
    historySince: parseIso(input.historySince, "invalid_schedule"),
    timeZone: timeZone(input.timeZone),
    enabled: input.enabled,
    times,
    pollIntervalMinutes,
    readyBy,
  }
}

function instant(value: Date | string): string {
  return value instanceof Date
    ? parseIso(value.toISOString(), "invalid_time")
    : parseIso(value, "invalid_time")
}

function localTime(iso: string, zone: string): LocalTime {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    fields.find((field) => field.type === type)!.value
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  }
}

function dayDifference(from: string, to: string): number {
  const atMidnight = (date: string) => Date.parse(`${date}T00:00:00.000Z`)
  return Math.round((atMidnight(to) - atMidnight(from)) / 86_400_000)
}

function slotId(date: string, time: string): string {
  return `${date}T${time}`
}

function addLocalDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

function localMinute(date: string, minute: number): string {
  const hour = String(Math.floor(minute / 60)).padStart(2, "0")
  const minutePart = String(minute % 60).padStart(2, "0")
  return `${date}T${hour}:${minutePart}`
}

// 计划时点按本地钟表比较：春季跳过的时刻会在下一次 tick 触发，秋季重复时刻共用同一个 slot ID。
function dueSlots(
  previous: string | null,
  now: string,
  config: ProcessingScheduleConfig,
): { slots: string[]; catchup: boolean } {
  const current = localTime(now, config.timeZone)
  const lead = config.readyBy?.leadMinutes ?? 0
  const scheduled = config.times.map((time) => ({
    time,
    triggerMinute: parseTime(time).minute - lead,
  }))
  const matching = (date: string, lowerExclusive: number, upperInclusive: number) =>
    scheduled
      .filter(
        ({ triggerMinute }) => triggerMinute > lowerExclusive && triggerMinute <= upperInclusive,
      )
      .map(({ time }) => slotId(date, time))
  if (!previous) {
    const slots = matching(current.date, -1, current.minute)
    return { slots, catchup: slots.length > 1 }
  }
  const prior = localTime(previous, config.timeZone)
  const days = dayDifference(prior.date, current.date)
  if (days < 0 || (days === 0 && current.minute < prior.minute)) {
    // 秋季回拨后仅观察当前钟表窗口；已创建的同日 slot 会由唯一键防止第二次运行。
    const slots = matching(current.date, -1, current.minute)
    return { slots, catchup: false }
  }
  if (days === 0) {
    const slots = matching(current.date, prior.minute, current.minute)
    return { slots, catchup: slots.length > 1 }
  }
  const first = matching(prior.date, prior.minute, 24 * 60)
  const last = matching(current.date, -1, current.minute)
  // 跨多日必然至少错过一个完整计划日，因此仍只提交一个合并追赶任务。
  return { slots: [...first, ...last], catchup: days > 1 || first.length + last.length > 1 }
}

// 独立调度基础层只保存任务意图、租约和范围快照；实际读取与模型执行由上层 worker 接入。
export class ProcessingScheduleStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: () => string | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processing_schedule (
        id INTEGER PRIMARY KEY CHECK(id=1), owner_id TEXT NOT NULL, revision INTEGER NOT NULL,
        body TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processing_schedule_state (
        id INTEGER PRIMARY KEY CHECK(id=1), last_tick_at TEXT, last_poll_at TEXT
      );
      CREATE TABLE IF NOT EXISTS processing_schedule_triggers (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL, config_revision INTEGER NOT NULL, source_keys TEXT NOT NULL,
        history_since TEXT NOT NULL, time_zone TEXT NOT NULL, scheduled_for TEXT,
        cutoff_at TEXT NOT NULL, status TEXT NOT NULL, lease_token TEXT, lease_until TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT,
        UNIQUE(owner_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS processing_schedule_trigger_claim
        ON processing_schedule_triggers(owner_id, status, lease_until, created_at);
      INSERT OR IGNORE INTO processing_schedule_state VALUES(1, NULL, NULL);
    `)
  }

  private transaction<T>(operation: () => T): T {
    // 可嵌入 Store 的外层事务，确保水位推进和触发记录不会半提交。
    this.db.exec("SAVEPOINT processing_schedule_write")
    try {
      const value = operation()
      this.db.exec("RELEASE processing_schedule_write")
      return value
    } catch (error) {
      this.db.exec("ROLLBACK TO processing_schedule_write; RELEASE processing_schedule_write")
      throw error
    }
  }

  private ownerId(): string {
    const ownerId = this.owner()
    if (!ownerId) throw new ProcessingScheduleError("owner_required")
    return ownerId
  }

  snapshot(): ProcessingScheduleSnapshot {
    const ownerId = this.ownerId()
    const row = this.db
      .prepare("SELECT owner_id,revision,body FROM processing_schedule WHERE id=1")
      .get()
    if (!row) return { revision: 0, config: null }
    if (String(row.owner_id) !== ownerId) throw new ProcessingScheduleError("owner_mismatch")
    return { revision: Number(row.revision), config: normalizeConfig(JSON.parse(String(row.body))) }
  }

  readingStatus(now: Date | string = new Date()): ProcessingScheduleReadingStatus {
    const snapshot = this.snapshot()
    const config = snapshot.config
    if (!config)
      return {
        revision: snapshot.revision,
        enabled: false,
        timeZone: null,
        nextScheduledStartLocal: null,
        nextScheduledReadyLocal: null,
        readyByLeadMinutes: null,
        pollIntervalMinutes: null,
        nextPollAt: null,
      }
    const at = instant(now)
    const current = localTime(at, config.timeZone)
    const lead = config.readyBy?.leadMinutes ?? 0
    const scheduled = config.times.map((time) => ({
      readyMinute: parseTime(time).minute,
      startMinute: parseTime(time).minute - lead,
    }))
    const nextToday = scheduled.find(({ startMinute }) => startMinute > current.minute)
    const next = nextToday ?? scheduled[0]!
    const nextDate = nextToday ? current.date : addLocalDays(current.date, 1)
    const state = this.db
      .prepare("SELECT last_poll_at FROM processing_schedule_state WHERE id=1")
      .get()
    const lastPollAt = state?.last_poll_at == null ? null : String(state.last_poll_at)
    const nextPollAt =
      config.enabled && config.pollIntervalMinutes !== null
        ? lastPollAt
          ? new Date(
              Math.max(
                Date.parse(at),
                Date.parse(lastPollAt) + config.pollIntervalMinutes * 60_000,
              ),
            ).toISOString()
          : at
        : null
    return {
      revision: snapshot.revision,
      enabled: config.enabled,
      timeZone: config.timeZone,
      // 固定计划展示 ready_by 后的真实启动钟点，同时保留目标就绪钟点供界面解释。
      nextScheduledStartLocal: config.enabled ? localMinute(nextDate, next.startMinute) : null,
      nextScheduledReadyLocal: config.enabled ? localMinute(nextDate, next.readyMinute) : null,
      readyByLeadMinutes: config.readyBy?.leadMinutes ?? null,
      pollIntervalMinutes: config.pollIntervalMinutes,
      nextPollAt,
    }
  }

  save(input: ProcessingScheduleInput, expectedRevision: number): ProcessingScheduleSnapshot {
    const config = normalizeConfig(input)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new ProcessingScheduleError("revision_conflict")
    return this.transaction(() => {
      const ownerId = this.ownerId()
      const previous = this.snapshot()
      if (previous.revision !== expectedRevision)
        throw new ProcessingScheduleError("revision_conflict")
      const revision = previous.revision + 1
      this.db
        .prepare("INSERT OR REPLACE INTO processing_schedule VALUES(1,?,?,?,?)")
        .run(ownerId, revision, JSON.stringify(config), new Date().toISOString())
      // 计划改动后重新观察当前本地日，只建立一个合并追赶而不按旧时点重复排队。
      this.db
        .prepare(
          "UPDATE processing_schedule_state SET last_tick_at=NULL,last_poll_at=NULL WHERE id=1",
        )
        .run()
      return { revision, config }
    })
  }

  tick(now: Date | string): ProcessingTrigger[] {
    const cutoffAt = instant(now)
    return this.transaction(() => {
      const snapshot = this.snapshot()
      if (!snapshot.config?.enabled) return []
      const config = snapshot.config
      const state = this.db
        .prepare("SELECT last_tick_at,last_poll_at FROM processing_schedule_state WHERE id=1")
        .get()!
      const due = dueSlots(
        state.last_tick_at === null ? null : String(state.last_tick_at),
        cutoffAt,
        config,
      )
      const created: ProcessingTrigger[] = []
      if (due.slots.length) {
        const kind: ProcessingTriggerKind = due.catchup ? "catchup" : "scheduled"
        const scheduledFor = due.catchup ? null : due.slots[0]!
        const key = due.catchup
          ? `catchup:${snapshot.revision}:${due.slots[0]}:${due.slots.at(-1)}`
          : `scheduled:${snapshot.revision}:${scheduledFor}`
        const trigger = this.createTrigger({
          kind,
          dedupeKey: key,
          configRevision: snapshot.revision,
          sourceKeys: config.sourceKeys,
          historySince: config.historySince,
          timeZone: config.timeZone,
          scheduledFor,
          cutoffAt,
          createdAt: cutoffAt,
        })
        if (trigger.created) created.push(trigger.trigger)
      }
      const lastPollAt = state.last_poll_at === null ? null : String(state.last_poll_at)
      const pollDue =
        config.pollIntervalMinutes !== null &&
        (!lastPollAt ||
          Date.parse(cutoffAt) - Date.parse(lastPollAt) >= config.pollIntervalMinutes * 60_000)
      // 固定计划优先，同一次 tick 不另开轮询任务，避免重复扫描同一窗口。
      if (pollDue && due.slots.length === 0) {
        const local = localTime(cutoffAt, config.timeZone)
        const bucket = Math.floor(Date.parse(cutoffAt) / (config.pollIntervalMinutes! * 60_000))
        const trigger = this.createTrigger({
          kind: "poll",
          dedupeKey: `poll:${snapshot.revision}:${bucket}`,
          configRevision: snapshot.revision,
          sourceKeys: config.sourceKeys,
          historySince: config.historySince,
          timeZone: config.timeZone,
          scheduledFor: `${local.date}T${String(Math.floor(local.minute / 60)).padStart(2, "0")}:${String(local.minute % 60).padStart(2, "0")}`,
          cutoffAt,
          createdAt: cutoffAt,
        })
        if (trigger.created) created.push(trigger.trigger)
      }
      this.db
        .prepare("UPDATE processing_schedule_state SET last_tick_at=?,last_poll_at=? WHERE id=1")
        .run(cutoffAt, pollDue ? cutoffAt : lastPollAt)
      return created
    })
  }

  manual(dedupeKey: string, now: Date | string): ProcessingTrigger {
    if (!dedupeKey.trim() || dedupeKey.length > 300)
      throw new ProcessingScheduleError("invalid_dedupe_key")
    const cutoffAt = instant(now)
    return this.transaction(() => {
      const snapshot = this.snapshot()
      if (!snapshot.config) throw new ProcessingScheduleError("invalid_schedule")
      return this.createTrigger({
        kind: "manual",
        dedupeKey,
        configRevision: snapshot.revision,
        sourceKeys: snapshot.config.sourceKeys,
        historySince: snapshot.config.historySince,
        timeZone: snapshot.config.timeZone,
        scheduledFor: null,
        cutoffAt,
        createdAt: cutoffAt,
      }).trigger
    })
  }

  recover(now: Date | string): number {
    const at = instant(now)
    return this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE processing_schedule_triggers SET status='pending',lease_token=NULL,lease_until=NULL WHERE owner_id=? AND status='running' AND lease_until<=?",
        )
        .run(this.ownerId(), at)
      return Number(result.changes)
    })
  }

  claim(now: Date | string, leaseMs = 60_000): ProcessingTrigger | null {
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 30 * 60_000)
      throw new ProcessingScheduleError("invalid_time")
    const at = instant(now)
    return this.transaction(() => {
      this.recover(at)
      const ownerId = this.ownerId()
      const row = this.db
        .prepare(
          "SELECT * FROM processing_schedule_triggers WHERE owner_id=? AND status='pending' ORDER BY created_at,id LIMIT 1",
        )
        .get(ownerId)
      if (!row) return null
      const id = String(row.id)
      const leaseToken = randomUUID()
      const leaseUntil = new Date(Date.parse(at) + leaseMs).toISOString()
      const result = this.db
        .prepare(
          "UPDATE processing_schedule_triggers SET status='running',lease_token=?,lease_until=?,started_at=? WHERE id=? AND status='pending'",
        )
        .run(leaseToken, leaseUntil, at, id)
      if (result.changes !== 1) return null
      return this.triggerFromRow(
        this.db.prepare("SELECT * FROM processing_schedule_triggers WHERE id=?").get(id)!,
      )
    })
  }

  finish(
    id: string,
    leaseToken: string,
    status: Exclude<ProcessingTriggerStatus, "pending" | "running">,
    now: Date | string,
    error: string | null = null,
  ): boolean {
    const at = instant(now)
    return this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE processing_schedule_triggers SET status=?,lease_token=NULL,lease_until=NULL,finished_at=?,error=? WHERE id=? AND owner_id=? AND status='running' AND lease_token=?",
        )
        .run(status, at, error, id, this.ownerId(), leaseToken)
      return result.changes === 1
    })
  }

  triggers(): ProcessingTrigger[] {
    const ownerId = this.ownerId()
    return this.db
      .prepare("SELECT * FROM processing_schedule_triggers WHERE owner_id=? ORDER BY created_at,id")
      .all(ownerId)
      .map((row) => this.triggerFromRow(row))
  }

  private createTrigger(draft: TriggerDraft): { trigger: ProcessingTrigger; created: boolean } {
    const ownerId = this.ownerId()
    const id = randomUUID()
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO processing_schedule_triggers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        ownerId,
        draft.dedupeKey,
        draft.kind,
        draft.configRevision,
        JSON.stringify(draft.sourceKeys),
        draft.historySince,
        draft.timeZone,
        draft.scheduledFor,
        draft.cutoffAt,
        "pending",
        null,
        null,
        draft.createdAt,
        null,
        null,
        null,
      )
    const row = this.db
      .prepare("SELECT * FROM processing_schedule_triggers WHERE owner_id=? AND dedupe_key=?")
      .get(ownerId, draft.dedupeKey)!
    return { trigger: this.triggerFromRow(row), created: result.changes === 1 }
  }

  private triggerFromRow(row: Record<string, unknown>): ProcessingTrigger {
    return {
      id: String(row.id),
      kind: String(row.kind) as ProcessingTriggerKind,
      dedupeKey: String(row.dedupe_key),
      configRevision: Number(row.config_revision),
      sourceKeys: sourceKeys(JSON.parse(String(row.source_keys))),
      historySince: parseIso(row.history_since, "invalid_schedule"),
      timeZone: timeZone(row.time_zone),
      scheduledFor: row.scheduled_for === null ? null : String(row.scheduled_for),
      cutoffAt: parseIso(row.cutoff_at, "invalid_time"),
      status: String(row.status) as ProcessingTriggerStatus,
      leaseToken: row.lease_token === null ? null : String(row.lease_token),
      leaseUntil: row.lease_until === null ? null : String(row.lease_until),
      createdAt: parseIso(row.created_at, "invalid_time"),
      startedAt: row.started_at === null ? null : String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      error: row.error === null ? null : String(row.error),
    }
  }
}
