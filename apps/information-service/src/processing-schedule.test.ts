import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { ProcessingScheduleStore } from "./processing-schedule"

const databases: DatabaseSync[] = []

function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  return { db, schedule: new ProcessingScheduleStore(db, () => "owner") }
}

function configure(
  schedule: ProcessingScheduleStore,
  overrides: Partial<Parameters<ProcessingScheduleStore["save"]>[0]> = {},
) {
  return schedule.save(
    {
      sourceKeys: ["feed/a", "list/b", "inbox/c"],
      historySince: "2026-01-01T00:00:00.000Z",
      timeZone: "Asia/Shanghai",
      enabled: true,
      ...overrides,
    },
    0,
  )
}

afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
})

describe("处理计划", () => {
  it("保存显式范围、默认五时点与 CAS revision", () => {
    const { schedule } = fixture()
    expect(configure(schedule)).toMatchObject({
      revision: 1,
      config: { times: ["08:00", "12:00", "15:00", "20:00", "23:00"] },
    })
    expect(() => configure(schedule)).toThrow("revision_conflict")
  })

  it("跨天单一错过时点产生一份计划任务", () => {
    const { schedule } = fixture()
    configure(schedule, { times: ["23:00"] })
    expect(schedule.tick("2026-04-01T14:50:00.000Z")).toEqual([])
    const triggers = schedule.tick("2026-04-01T16:10:00.000Z")
    expect(triggers).toEqual([
      expect.objectContaining({ kind: "scheduled", scheduledFor: "2026-04-01T23:00" }),
    ])
  })

  it("浏览器关闭期间错过多个时点时，重启只合并追赶一次", () => {
    const { db, schedule } = fixture()
    configure(schedule)
    expect(schedule.tick("2026-04-01T23:00:00.000Z")).toEqual([]) // 上海 07:00
    const restarted = new ProcessingScheduleStore(db, () => "owner")
    const catchup = restarted.tick("2026-04-02T08:30:00.000Z") // 上海 16:30，错过 08/12/15
    expect(catchup).toEqual([expect.objectContaining({ kind: "catchup" })])
    expect(restarted.tick("2026-04-02T08:31:00.000Z")).toEqual([])
  })

  it("春季 DST 跳过的本地时刻在下一次 tick 启动，秋季重复时刻只运行一次", () => {
    const { schedule } = fixture()
    configure(schedule, { timeZone: "America/New_York", times: ["02:30"] })
    expect(schedule.tick("2026-03-08T06:55:00.000Z")).toEqual([]) // 01:55 EST
    expect(schedule.tick("2026-03-08T07:05:00.000Z")).toEqual([
      expect.objectContaining({ scheduledFor: "2026-03-08T02:30" }),
    ]) // 03:05 EDT，02:30 不存在

    const { schedule: fall } = fixture()
    configure(fall, { timeZone: "America/New_York", times: ["01:30"] })
    fall.tick("2026-11-01T05:10:00.000Z") // 01:10 EDT
    expect(fall.tick("2026-11-01T05:35:00.000Z")).toHaveLength(1) // 首个 01:35
    expect(fall.tick("2026-11-01T06:35:00.000Z")).toEqual([]) // 第二个 01:35 EST
  })

  it("ready_by 提前启动，定时与轮询重叠时只保留一个任务", () => {
    const { schedule } = fixture()
    configure(schedule, {
      times: ["08:00"],
      readyBy: { leadMinutes: 15 },
      pollIntervalMinutes: 15,
    })
    expect(schedule.tick("2026-04-01T23:44:00.000Z")).toHaveLength(1) // 首次轮询
    const triggers = schedule.tick("2026-04-01T23:45:00.000Z")
    expect(triggers).toEqual([
      expect.objectContaining({ kind: "scheduled", scheduledFor: "2026-04-02T08:00" }),
    ])
    expect(schedule.manual(triggers[0]!.dedupeKey, "2026-04-01T23:46:00.000Z").id).toBe(
      triggers[0]!.id,
    )
  })

  it("阅读状态分别报告真实提前启动时点和轮询时点", () => {
    const { schedule } = fixture()
    configure(schedule, {
      times: ["08:00"],
      readyBy: { leadMinutes: 15 },
      pollIntervalMinutes: 30,
    })
    expect(schedule.readingStatus("2026-04-01T23:30:00.000Z")).toMatchObject({
      enabled: true,
      timeZone: "Asia/Shanghai",
      nextScheduledStartLocal: "2026-04-02T07:45",
      nextScheduledReadyLocal: "2026-04-02T08:00",
      readyByLeadMinutes: 15,
      pollIntervalMinutes: 30,
      nextPollAt: "2026-04-01T23:30:00.000Z",
    })
  })

  it("相同手动键去重，过期租约可恢复并拒绝旧租约完成", () => {
    const { schedule } = fixture()
    configure(schedule)
    const first = schedule.manual("scope:2026-04-02T08:00", "2026-04-02T00:00:00.000Z")
    expect(schedule.manual("scope:2026-04-02T08:00", "2026-04-02T00:01:00.000Z").id).toBe(first.id)
    const claimed = schedule.claim("2026-04-02T00:00:00.000Z", 1_000)!
    expect(schedule.recover("2026-04-02T00:00:00.999Z")).toBe(0)
    expect(schedule.recover("2026-04-02T00:00:01.000Z")).toBe(1)
    const retried = schedule.claim("2026-04-02T00:00:01.000Z", 1_000)!
    expect(
      schedule.finish(claimed.id, claimed.leaseToken!, "succeeded", "2026-04-02T00:00:01.000Z"),
    ).toBe(false)
    expect(
      schedule.finish(retried.id, retried.leaseToken!, "succeeded", "2026-04-02T00:00:01.000Z"),
    ).toBe(true)
  })

  it("只传扁平 sourceKeys 的计划按 fixed 读回（向后兼容）", () => {
    const { schedule } = fixture()
    // 旧调用方只传 sourceKeys，不带范围描述符：等价 fixed，仍应可读可运行。
    configure(schedule)
    expect(schedule.snapshot().config).toMatchObject({
      // 描述符与已解析名单都按同一份排序结果落库，不保留两份可能漂移的名单。
      scope: { mode: "fixed", sourceKeys: ["feed/a", "inbox/c", "list/b"] },
      sourceKeys: ["feed/a", "inbox/c", "list/b"],
    })
  })

  it("新范围描述符（all）落库后 scope 与已解析名单都保留", () => {
    const { schedule } = fixture()
    schedule.save(
      {
        scope: { mode: "all" },
        sourceKeys: ["feed/a", "list/b", "inbox/c"],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: true,
        times: ["23:00"],
      },
      0,
    )
    const config = schedule.snapshot().config!
    expect(config.scope).toEqual({ mode: "all" })
    // 运行范围读取直接沿用已落库名单，不重复做分类解析。
    expect(schedule.tick("2026-04-01T14:50:00.000Z")).toEqual([])
    const triggers = schedule.tick("2026-04-01T16:10:00.000Z")
    expect(triggers[0]!.sourceKeys).toEqual(["feed/a", "inbox/c", "list/b"])
  })

  it("category 描述符落库后运行范围使用 client 解析后的名单", () => {
    const { schedule } = fixture()
    schedule.save(
      {
        scope: { mode: "category", view: 0, category: "tech" },
        // client 已把该分类下的源解析为名单落库；新来源不在此名单内。
        sourceKeys: ["feed/a"],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: true,
        times: ["23:00"],
      },
      0,
    )
    const config = schedule.snapshot().config!
    expect(config.scope).toEqual({ mode: "category", view: 0, category: "tech" })
    expect(schedule.tick("2026-04-01T14:50:00.000Z")).toEqual([])
    const triggers = schedule.tick("2026-04-01T16:10:00.000Z")
    expect(triggers[0]!.sourceKeys).toEqual(["feed/a"])
  })

  it("fixed 描述符是权威名单：与顶层扁平字段不一致时以描述符为准", () => {
    const { schedule } = fixture()
    schedule.save(
      {
        scope: { mode: "fixed", sourceKeys: ["feed/a"] },
        // 客户端本应保持一致；这里刻意不一致，验证落库口径唯一（不产生第二份名单）。
        sourceKeys: ["feed/a", "list/b"],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: true,
      },
      0,
    )
    expect(schedule.snapshot().config).toMatchObject({
      scope: { mode: "fixed", sourceKeys: ["feed/a"] },
      sourceKeys: ["feed/a"],
    })
  })
})
