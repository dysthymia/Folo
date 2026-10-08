import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createEntryModelSelectionSchema } from "./processing-decision"
import type { EventIdentity, EventSelection } from "./processing-event"
import {
  compatibleEvents,
  eventIdentitySchema,
  materializeEvent,
  traceableEvent,
  traceableRelatedEvent,
} from "./processing-event"
import { createEvidenceCatalog } from "./processing-evidence"

function selected(evidenceId: string): EventSelection {
  const field = (value: string) => ({ value, evidenceId })
  return {
    kind: "event",
    subject: field("OpenAI"),
    action: { value: "product_release", evidenceId },
    object: field("GPT"),
    version: field("5.2"),
    round: null,
    anchor: null,
  }
}

describe("可追溯的事件身份", () => {
  it("单篇和批量模型格式的嵌套属性均必填，未知时区用 null 且兼容旧身份记录", () => {
    const catalog = createEvidenceCatalog("OpenAI 于 2026-10-04 发布 GPT 5.2。")
    const single = createEntryModelSelectionSchema("entry-1", catalog)
    const batch = z.object({
      items: z.array(z.union([single, createEntryModelSelectionSchema("entry-2", catalog)])),
    })
    // 这是官方严格结构化输出的请求条件，不能只验证本地 Zod 能解析返回值。
    const verifyRequiredProperties = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(verifyRequiredProperties)
      if (!value || typeof value !== "object") return
      const node = value as Record<string, unknown>
      if (node.type === "object" && node.properties && typeof node.properties === "object")
        expect(node.required).toEqual(expect.arrayContaining(Object.keys(node.properties)))
      Object.values(node).forEach(verifyRequiredProperties)
    }
    verifyRequiredProperties(z.toJSONSchema(single))
    verifyRequiredProperties(z.toJSONSchema(batch))
    const selection = {
      ...selected(catalog.fragments[0]!.evidenceId),
      anchor: {
        value: "2026-10-04",
        evidenceId: catalog.fragments[0]!.evidenceId,
        kind: "event_date" as const,
        timeZone: null,
      },
    }
    const identity = materializeEvent(catalog, selection)!
    const { timeZone: _zone, ...legacyAnchor } = identity.anchor!
    expect(eventIdentitySchema.safeParse({ ...identity, anchor: legacyAnchor }).success).toBe(true)
  })
  it("中英文原文通过材料明示的版本和实体识别同事件，事件日期缺失仍可综合", () => {
    const chinese = "OpenAI 发布 GPT 5.2，原始公告 https://openai.com/index/gpt-5-2/ 。"
    const english =
      "OpenAI released GPT 5.2. Official announcement: https://openai.com/index/gpt-5-2/ ."
    const events = [chinese, english].map((text) => {
      const catalog = createEvidenceCatalog(text)
      const selection = selected(catalog.fragments[0]!.evidenceId)
      const event = materializeEvent(catalog, selection)!
      expect(event.subject.quote).toBe(catalog.fragments[0]!.quote)
      expect(traceableEvent(event, text)).toEqual(event)
      return event
    })
    expect(events[0]!.subject.quote).not.toBe(events[1]!.subject.quote)
    expect(compatibleEvents(events[0]!, events[1]!)).toBe(true)
  })

  it("未知版本/日期可用同一官方原帖，跟踪参数不改身份而公告ID必须保留", () => {
    const quote = "官方原帖的可核对事件。"
    const base: EventIdentity = {
      kind: "event",
      subject: { value: "issuer", quote },
      action: { value: "announcement", quote },
      object: { value: "campaign", quote },
      version: null,
      round: null,
      anchor: {
        kind: "official_reference",
        value: "https://example.test/notice?id=12&utm_source=x",
        quote,
      },
    }
    const same = {
      ...base,
      anchor: { ...base.anchor!, value: "https://example.test/notice?id=12" },
    }
    expect(compatibleEvents(base, same)).toBe(true)
    expect(
      compatibleEvents(base, {
        ...same,
        anchor: { ...same.anchor, value: "https://example.test/notice?id=13" },
      }),
    ).toBe(false)
    expect(traceableEvent({ ...base, anchor: null }, quote)).toBeNull()
  })

  it("动作、轮次、模型版本与发生日期冲突分别阻断，未知材料不能桥接不同版本", () => {
    const catalog = createEvidenceCatalog("OpenAI 发布 GPT 5.2，活动轮次一于2026-10-01开始。")
    const base = materializeEvent(catalog, selected(catalog.fragments[0]!.evidenceId))!
    const quote = base.subject.quote
    for (const other of [
      { ...base, action: { value: "death" as const, quote } },
      { ...base, version: { value: "5.3", quote } },
      { ...base, round: { value: "二", quote } },
      {
        ...base,
        anchor: { kind: "event_date" as const, value: "2026-10-02", timeZone: "UTC", quote },
      },
    ]) {
      expect(
        compatibleEvents(
          {
            ...base,
            round: { value: "一", quote },
            anchor: { kind: "event_date", value: "2026-10-01", timeZone: "UTC", quote },
          },
          other,
        ),
      ).toBe(false)
    }
    expect(compatibleEvents(base, { ...base, version: null })).toBe(false)
    expect(
      traceableEvent(
        { ...base, anchor: { kind: "event_date", value: "2026-02-30", quote } },
        quote,
      ),
    ).toBeNull()
  })

  it("原文明示时区的中英发生时刻跨日可归一，不能把邻接日或报道日期当共同锚", () => {
    const originals = [
      "Bitget 确认钱包攻击发生在北京时间2026年9月25日00:31。",
      "Bitget confirms the wallet attack occurred September 24, 2026 at 12:31 UTC-04:00.",
    ]
    const events = originals.map((text, index) => {
      const catalog = createEvidenceCatalog(text)
      const evidenceId = catalog.fragments[0]!.evidenceId
      const field = (value: string) => ({ value, evidenceId })
      const event = materializeEvent(catalog, {
        kind: "event",
        subject: field("Bitget"),
        action: { value: "security_incident", evidenceId },
        object: field("Bitget wallet"),
        version: null,
        round: null,
        anchor: {
          kind: "event_time",
          value: index === 0 ? "2026-09-25T00:31:00+08:00" : "2026-09-24T12:31:00-04:00",
          timeZone: null,
          evidenceId,
        },
      })!
      expect(traceableEvent(event, text)).toEqual(event)
      return event
    })
    expect(compatibleEvents(events[0]!, events[1]!)).toBe(true)
    const dated = (value: string, timeZone: string | null): EventIdentity => ({
      ...events[0]!,
      anchor: { kind: "event_date", value, timeZone, quote: originals[0]! },
    })
    expect(compatibleEvents(dated("2026-09-25", "Asia/Shanghai"), events[1]!)).toBe(true)
    expect(compatibleEvents(dated("2026-09-25", "+08:00"), events[1]!)).toBe(true)
    expect(compatibleEvents(dated("2026-09-25", "UTC"), events[1]!)).toBe(false)
    expect(compatibleEvents(dated("2026-09-24", null), dated("2026-09-25", null))).toBe(false)
    expect(compatibleEvents(dated("2026-09-25", null), events[1]!)).toBe(false)
    // 只有发布时间的材料不会凭元数据产生发生锚点，仍保持身份未知。
    expect(
      traceableEvent({ ...events[0]!, anchor: null }, "Published September 25, 2026."),
    ).toBeNull()
    for (const invalid of [
      "2026-09-24T12:31:00",
      "2026-02-30T12:31:00Z",
      "2026-09-24T12:31:00+15:00",
    ])
      expect(
        traceableEvent(
          { ...events[0]!, anchor: { ...events[0]!.anchor!, value: invalid } },
          originals[0]!,
        ),
      ).toBeNull()
    expect(traceableEvent(dated("2026-09-25", "America/Unknown"), originals[0]!)).toBeNull()
  })

  it("明示时区日期在夏令时边界按本地日期比较，已知发生区间冲突不能被版本桥接", () => {
    const quote = "事件发生于2026年11月1日America/New_York，版本一。"
    const event = materializeEvent(createEvidenceCatalog(quote), selected("E000001"))!
    const day: EventIdentity = {
      ...event,
      anchor: { kind: "event_date", value: "2026-11-01", timeZone: "America/New_York", quote },
    }
    const instant = (value: string): EventIdentity => ({
      ...event,
      anchor: { kind: "event_time", value, quote },
    })
    expect(traceableEvent(day, quote)).toEqual(day)
    expect(compatibleEvents(day, instant("2026-11-02T04:59:00Z"))).toBe(true)
    expect(compatibleEvents(day, instant("2026-11-02T05:00:00Z"))).toBe(false)
  })

  it("模型不能跨输入选择身份引用，空目录只允许未知；持久化quote也必须属于原文", () => {
    const catalog = createEvidenceCatalog("实际原文。")
    const event = selected("E999999")
    const output = {
      entryId: "entry",
      title: "标题",
      summary: "摘要",
      disposition: "keep",
      reason: "依据",
      aggregation: true,
      rewrite: true,
      labels: [],
      facts: [],
      event,
    }
    expect(createEntryModelSelectionSchema("entry", catalog).safeParse(output).success).toBe(false)
    expect(() => materializeEvent(catalog, event)).toThrow("invalid_event_evidence")
    expect(
      createEntryModelSelectionSchema("entry", createEvidenceCatalog("")).safeParse({
        ...output,
        event: null,
      }).success,
    ).toBe(true)
    const verified = materializeEvent(catalog, selected("E000001"))!
    expect(traceableEvent(verified, "另一条原文。")).toBeNull()
    expect(traceableEvent(undefined, "实际原文。")).toBeNull()
  })
})

// related 校验允许明确时间格式归一，但日期、时刻和时区均不能靠元数据猜造。
it("related事件的归一时间仍须由同一引用明确支持", () => {
  const text = "OpenAI 于北京时间2026年9月25日00:31发布 GPT 5.2。"
  const event = materializeEvent(createEvidenceCatalog(text), selected("E000001"))!
  const timed: EventIdentity = {
    ...event,
    anchor: {
      kind: "event_time",
      value: "2026-09-25T00:31:00+08:00",
      timeZone: "Asia/Shanghai",
      quote: text,
    },
  }
  expect(traceableRelatedEvent(timed, text)).toEqual(timed)
  for (const value of [
    "2026-09-26T00:31:00+08:00",
    "2026-09-25T00:32:00+08:00",
    "2026-09-25T00:31:59+08:00",
    "2026-09-25T00:31:00Z",
  ])
    expect(
      traceableRelatedEvent({ ...timed, anchor: { ...timed.anchor!, value } }, text),
    ).toBeNull()
  expect(
    traceableRelatedEvent(
      { ...timed, anchor: { ...timed.anchor!, timeZone: "America/New_York" } },
      text,
    ),
  ).toBeNull()
})

it("related时区不能把UTC-04来源按子串认成UTC，并支持原文明示英文日期", () => {
  const text = "OpenAI released GPT 5.2 on September 24, 2026 at 12:31 UTC-04:00."
  const event = materializeEvent(createEvidenceCatalog(text), selected("E000001"))!
  const timed: EventIdentity = {
    ...event,
    anchor: {
      kind: "event_time",
      value: "2026-09-24T12:31:00-04:00",
      timeZone: "-04:00",
      quote: text,
    },
  }
  expect(traceableRelatedEvent(timed, text)).toEqual(timed)
  expect(
    traceableRelatedEvent({ ...timed, anchor: { ...timed.anchor!, timeZone: "UTC" } }, text),
  ).toBeNull()
  expect(
    traceableRelatedEvent(
      { ...timed, anchor: { ...timed.anchor!, value: "2026-09-24T12:31:00-04:30" } },
      text,
    ),
  ).toBeNull()
})
