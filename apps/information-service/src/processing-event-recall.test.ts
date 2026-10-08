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
