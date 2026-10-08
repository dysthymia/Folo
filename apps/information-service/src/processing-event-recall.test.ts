import { describe, expect, it } from "vitest"

import type { EventIdentity } from "./processing-event"
import {
  eventRecallPostingKeys,
  eventRecallReasons,
  validatedEventRecall,
} from "./processing-event-recall"
import type { SemanticDuplicateEntry } from "./semantic-dedupe"
import { getSemanticDuplicateCandidates } from "./semantic-dedupe"

const eventId = "evt_11111111-1111-4111-8111-111111111111"
const quote = "OpenAI 发布 GPT 5.2，轮次 R1；公告 https://official.test/gpt 。"
function identity(extra: Partial<EventIdentity> = {}, text = quote): EventIdentity {
  return {
    kind: "event",
    subject: { value: "OpenAI", quote: text },
    action: { value: "product_release", quote: text },
    object: { value: "GPT", quote: text },
    version: { value: "5.2", quote: text },
    round: { value: "R1", quote: text },
    anchor: { kind: "official_reference", value: "https://official.test/gpt", quote: text },
    ...extra,
  }
}
function entry(
  id: string,
  title: string,
  event: EventIdentity | null = identity(),
  hour = 0,
): SemanticDuplicateEntry {
  return {
    itemId: id,
    title,
    description: "",
    sourceTitle: "source",
    urlHost: "official.test",
    publishedAt: new Date(Date.parse("2026-10-06T00:00:00Z") + hour * 3600000).toISOString(),
    content: event?.subject.quote ?? quote,
    contentComplete: true,
    recall: { eventIds: [], identities: event ? [event] : [] },
  }
}

// 固定身份与原文样本仅验证召回；这里不发模型请求，也不从事件身份推断重复。
describe("事件及实体证据召回", () => {
  it("异语言低文本相似度通过规范实体与版本召回，保留可解释的原文身份", () => {
    const english = "OpenAI released GPT 5.2 in R1; announcement https://official.test/gpt ."
    const a = entry("zh", "新品来了", identity(), 1)
    const b = entry("en", "Independent launch report", identity({}, english))
    expect(
      getSemanticDuplicateCandidates([
        { ...a, recall: undefined },
        { ...b, recall: undefined },
      ]),
    ).toEqual([])
    expect(getSemanticDuplicateCandidates([a, b])[0]).toMatchObject({
      pairKey: "en::zh",
      recallReasons: [
        {
          type: "evidence_identity",
          subject: "OpenAI",
          anchors: ["version:5.2", "round:r1", "official:https://official.test/gpt"],
        },
      ],
    })
  })
  it("已确认 eventId 独立召回，标签与身份输出均非必需", () => {
    const a = entry("a", "新品来了", null, 1),
      b = entry("b", "Independent report", null)
    a.recall = b.recall = { eventIds: [eventId], identities: [] }
    expect(getSemanticDuplicateCandidates([a, b])[0]?.recallReasons).toEqual([
      { type: "confirmed_event", eventId },
    ])
    expect(eventRecallPostingKeys(validatedEventRecall(a))).toEqual([`event:${eventId}`])
  })
  it("同主题、缺发生标识、版本或轮次冲突和不同官方引用均不进入身份通路", () => {
    const a = validatedEventRecall(entry("a", "甲"))
    for (const changed of [
      identity({ version: null, round: null, anchor: null }),
      identity(
        { version: { value: "5.3", quote: "OpenAI GPT 5.3 R1 https://official.test/gpt" } },
        "OpenAI GPT 5.3 R1 https://official.test/gpt",
      ),
      identity(
        { round: { value: "R2", quote: "OpenAI GPT 5.2 R2 https://official.test/gpt" } },
        "OpenAI GPT 5.2 R2 https://official.test/gpt",
      ),
      identity(
        {
          anchor: {
            kind: "official_reference",
            value: "https://official.test/other",
            quote: "OpenAI GPT 5.2 R1 https://official.test/other",
          },
        },
        "OpenAI GPT 5.2 R1 https://official.test/other",
      ),
    ])
      expect(eventRecallReasons(a, validatedEventRecall(entry("b", "乙", changed)))).toEqual([])
  })
  it("伪造或不连续证据不召回，不完整正文也不以 eventId 绕过", () => {
    const forged = entry(
      "forged",
      "甲",
      identity({ version: { value: "5.2", quote: "凭空补写 5.2" } }),
    )
    expect(validatedEventRecall(forged).identities).toEqual([])
    const incomplete = {
      ...entry("incomplete", "乙"),
      contentComplete: false,
      recall: { eventIds: [eventId], identities: [identity()] },
    }
    expect(validatedEventRecall(incomplete)).toEqual({ eventIds: [], identities: [] })
  })
  it("事件召回仍受48小时、原文身份、targets、已判关系和settled预算前约束", () => {
    const a = entry("a", "新品来了", null, 1),
      b = entry("b", "Independent report", null)
    a.recall = b.recall = { eventIds: [eventId], identities: [] }
    for (const options of [
      { targetItemIds: new Set(["outside"]) },
      { decidedPairKeys: new Set(["a::b"]) },
      { settledItemIds: new Set(["a", "b"]) },
    ])
      expect(getSemanticDuplicateCandidates([a, b], options)).toEqual([])
    expect(
      getSemanticDuplicateCandidates([a, { ...b, publishedAt: "2026-10-01T00:00:00Z" }]),
    ).toEqual([])
    expect(
      getSemanticDuplicateCandidates([
        { ...a, originalIdentity: "same" },
        { ...b, originalIdentity: "same" },
      ]),
    ).toEqual([])
    expect(
      getSemanticDuplicateCandidates([a, b], { maxCandidates: 1, targetItemIds: new Set(["b"]) }),
    ).toHaveLength(1)
  })
})

function temporalIdentity(text: string, day: string, extra: Partial<EventIdentity> = {}) {
  return identity(
    {
      version: null,
      round: null,
      anchor: { kind: "event_date", value: day, quote: text, timeZone: "UTC" },
      ...extra,
    },
    text,
  )
}

describe("有证据的发生时间与显式别名", () => {
  it("同一天中英报道可召回，另一发生日和不同主体动作对象不召回", () => {
    const zh = "OpenAI 于2026年10月5日 UTC 发布 GPT。"
    const en = "OpenAI released GPT on October 5, 2026 UTC."
    const a = entry("a", "新成果", temporalIdentity(zh, "2026-10-05"), 1)
    const b = entry("b", "A launch report", temporalIdentity(en, "2026-10-05"))
    expect(getSemanticDuplicateCandidates([a, b])).toHaveLength(1)
    const other = "OpenAI 于2026年10月6日 UTC 发布 GPT。"
    expect(
      getSemanticDuplicateCandidates([
        a,
        entry("c", "Another update", temporalIdentity(other, "2026-10-06")),
      ]),
    ).toEqual([])
    for (const changed of [
      { subject: { value: "Acme", quote: "Acme 于2026年10月5日 UTC 发布 GPT。" } },
      { action: { value: "announcement" as const, quote: zh } },
      { object: { value: "Other", quote: "OpenAI 于2026年10月5日 UTC 发布 Other。" } },
    ]) {
      const text = changed.subject?.quote ?? changed.object?.quote ?? zh
      expect(
        eventRecallReasons(
          validatedEventRecall(a),
          validatedEventRecall(entry("c", "另一条", temporalIdentity(text, "2026-10-05", changed))),
        ),
      ).toEqual([])
    }
  })

  it("日期与明确时区的同日时间可召回，非重叠时刻及报道元日期拒绝", () => {
    const day = "OpenAI 于2026年10月5日 UTC 发布 GPT。"
    const moment = "OpenAI 于2026-10-05T13:20:00Z 发布 GPT。"
    const a = entry("a", "新成果", temporalIdentity(day, "2026-10-05"), 1)
    const b = entry(
      "b",
      "A launch report",
      temporalIdentity(moment, "2026-10-05", {
        anchor: {
          kind: "event_time",
          value: "2026-10-05T13:20:00Z",
          quote: moment,
          timeZone: "Z",
        },
      }),
    )
    expect(getSemanticDuplicateCandidates([a, b])).toHaveLength(1)
    for (const text of [
      "Published on October 5, 2026 UTC. OpenAI released GPT.",
      "2026年10月5日消息，OpenAI 发布 GPT。",
      "报道时间2026年10月5日 UTC；OpenAI 发布 GPT。",
    ])
      expect(
        validatedEventRecall(entry("c", "Another update", temporalIdentity(text, "2026-10-05")))
          .identities,
      ).toEqual([])
  })

  it("同资产同统计区间跨语言召回，不同日周的统计期不混合", () => {
    const make = (id: string, start: string, end: string, title: string) => {
      const text = `OpenAI GPT 统计期间 ${start} 至 ${end} UTC 流入100美元。`
      return entry(
        id,
        title,
        temporalIdentity(text, end, { action: { value: "market_event", quote: text } }),
      )
    }
    const a = make("a", "2026-09-29", "2026-10-05", "资产统计")
    const en = "OpenAI GPT inflow period 2026-09-29 through 2026-10-05 UTC: 100 USD."
    const b = entry(
      "b",
      "Market observation",
      temporalIdentity(en, "2026-10-05", { action: { value: "market_event", quote: en } }),
    )
    expect(getSemanticDuplicateCandidates([a, b])).toHaveLength(1)
    for (const c of [
      make("c", "2026-09-30", "2026-10-05", "Weekly observation"),
      make("d", "2026-09-28", "2026-10-04", "Other interval"),
    ])
      expect(eventRecallReasons(validatedEventRecall(a), validatedEventRecall(c))).toEqual([])
  })

  it("只用原文明示别名召回，伪造、共现猜测与缩写碰撞不扩大身份", () => {
    const chinese = "开放人工智能（OpenAI）发布 GPT 5.2，轮次 R1；公告 https://official.test/gpt 。"
    const a = entry(
      "a",
      "新成果",
      identity({ subject: { value: "开放人工智能", quote: chinese } }, chinese),
      1,
    )
    const b = entry("b", "Launch observation", identity())
    const group = {
      name: "OpenAI",
      aliases: ["开放人工智能"],
      kind: "organization" as const,
      parentName: null,
      quotes: [chinese],
    }
    a.recall = { ...a.recall!, aliasGroups: [group] }
    expect(getSemanticDuplicateCandidates([a, b])).toHaveLength(1)
    expect(eventRecallReasons(validatedEventRecall(a), validatedEventRecall(b))[0]).toMatchObject({
      type: "evidence_identity",
    })
    for (const quotes of [["伪造中文别名OpenAI"], ["开放人工智能 与 OpenAI 各自发布 GPT。"]]) {
      const invalid = { ...a, recall: { ...a.recall, aliasGroups: [{ ...group, quotes }] } }
      expect(validatedEventRecall(invalid).aliasGroups).toBeUndefined()
    }
    const collision = { ...group, name: "Another project", kind: "project" as const }
    expect(
      eventRecallReasons(validatedEventRecall(a), validatedEventRecall(b), [group, collision]),
    ).toEqual([])
  })
})
