import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createEntryModelSelectionSchema, entryModelOutputSchema } from "./processing-decision"
import type { EventSelection } from "./processing-event"
import { materializeEvent, traceableEvent, traceableRelatedEvent } from "./processing-event"
import {
  eventMentionEvidenceIds,
  eventMentionsSelectionForCatalog,
  factsForPrimaryEvent,
  materializeEventMentions,
  normalizeEventMentions,
  remapEventMentionEvidence,
  validateEventMentionRelationship,
} from "./processing-event-mentions"
import { createEvidenceCatalog } from "./processing-evidence"

const original = "OpenAI 发布 GPT 5.2，官方公告 https://openai.com/notice/52 。"
const catalog = createEvidenceCatalog(original)
const identity: EventSelection = {
  kind: "event",
  subject: { value: "OpenAI", evidenceId: "E000001" },
  action: { value: "product_release", evidenceId: "E000001" },
  object: { value: "GPT", evidenceId: "E000001" },
  version: { value: "5.2", evidenceId: "E000001" },
  round: null,
  anchor: null,
}
const mention = { identity, role: "reports" as const, isPrimary: true }
const base = {
  entryId: "entry",
  title: "标题",
  summary: "摘要",
  disposition: "keep",
  reason: "具体发布",
  aggregation: true,
  rewrite: false,
  labels: [],
  facts: [],
  event: identity,
}
const assessment = {
  tagId: "topic:ai",
  definitionVersion: 1,
  state: "present",
  confidence: 0.99,
  reason: "GPT发布",
  evidenceIds: ["E000001"],
}

function v5() {
  return createEntryModelSelectionSchema("entry", catalog, ["topic:ai"])
}

describe("可追溯的少量事件提及", () => {
  it("legacy v4保留原请求，新v5必须显式提供数组且空数组合法", () => {
    expect(createEntryModelSelectionSchema("entry", catalog).safeParse(base).success).toBe(true)
    expect(v5().safeParse({ ...base, entities: [], tagAssessments: [assessment] }).success).toBe(
      false,
    )
    expect(
      v5().safeParse({
        ...base,
        entities: [],
        tagAssessments: [assessment],
        eventMentions: [mention],
      }).success,
    ).toBe(true)
    expect(
      v5().safeParse({
        ...base,
        entities: [],
        event: null,
        tagAssessments: [assessment],
        eventMentions: [],
      }).success,
    ).toBe(true)
    const json = z.toJSONSchema(v5())
    expect(json.required).toContain("eventMentions")
  })
  it("主事件唯一且与legacy逐字段一致，多事件可没有主事件", () => {
    const input = { ...base, entities: [], tagAssessments: [assessment], eventMentions: [mention] }
    for (const eventMentions of [
      [mention, mention],
      [{ ...mention, isPrimary: false }],
      [{ ...mention, identity: { ...identity, version: { value: "5.3", evidenceId: "E000001" } } }],
      Array.from({ length: 5 }, () => ({ ...mention, isPrimary: false })),
    ])
      expect(v5().safeParse({ ...input, eventMentions }).success).toBe(false)
    expect(v5().safeParse({ ...input, event: null }).success).toBe(false)
    expect(
      v5().safeParse({ ...input, event: null, eventMentions: [{ ...mention, isPrimary: false }] })
        .success,
    ).toBe(true)
  })
  it("每个字段绑定本条目录，不能引用别条证据或返回自由quote", () => {
    const selected = eventMentionsSelectionForCatalog(catalog)
    expect(selected.safeParse([mention]).success).toBe(true)
    expect(
      selected.safeParse([
        {
          ...mention,
          identity: { ...identity, subject: { ...identity.subject, evidenceId: "otherE000001" } },
        },
      ]).success,
    ).toBe(false)
    expect(
      selected.safeParse([
        {
          ...mention,
          identity: { ...identity, subject: { ...identity.subject, quote: original } },
        },
      ]).success,
    ).toBe(false)
    expect(
      eventMentionsSelectionForCatalog(createEvidenceCatalog("")).safeParse([mention]).success,
    ).toBe(false)
    const restored = materializeEventMentions(catalog, [mention])
    expect(restored[0]!.identity.subject.quote).toBe(original)
    expect(eventMentionEvidenceIds([mention])).toEqual(["E000001"])
    expect(
      remapEventMentionEvidence([mention], () => "FE000001")[0]!.identity.subject.evidenceId,
    ).toBe("FE000001")
  })
  it("缺少发生身份可保留次要候选，分析和教程的related身份不授予Story报道资格", () => {
    for (const kind of ["analysis", "tutorial"] as const) {
      const restored = materializeEventMentions(catalog, [
        {
          ...mention,
          isPrimary: false,
          identity: { ...identity, kind },
          role: kind === "analysis" ? "analysis_of" : "tutorial_for",
        },
      ])[0]!
      expect(traceableRelatedEvent(restored.identity, original)).toEqual(restored.identity)
      expect(traceableEvent(restored.identity, original)).toBeNull()
    }
    const candidate = { ...mention, isPrimary: false, identity: { ...identity, version: null } }
    expect(eventMentionsSelectionForCatalog(catalog).safeParse([candidate]).success).toBe(true)
    expect(
      traceableRelatedEvent(materializeEventMentions(catalog, [candidate])[0]!.identity, original),
    ).toBeNull()
  })
  it("普通报道缺发生锚点仍可保留明确主次，但主身份不会被确认或自动归并", () => {
    const candidate = { ...identity, version: null }
    const selection = {
      ...base,
      event: candidate,
      entities: [],
      tagAssessments: [assessment],
      eventMentions: [{ ...mention, identity: candidate }],
    }
    expect(v5().safeParse(selection).success).toBe(true)
    const event = materializeEvent(catalog, candidate)!
    expect(normalizeEventMentions({ event })[0]?.isPrimary).toBe(true)
    expect(traceableEvent(event, original)).toBeNull()
    expect(traceableRelatedEvent(event, original)).toBeNull()
  })
  it("同目录编号并不能证明虚构规范值或官方URL，记忆别名和拼写近似保持候选", () => {
    const verified = materializeEvent(catalog, identity)!
    for (const field of [
      { ...verified, subject: { value: "Open-AI", quote: original } },
      { ...verified, subject: { value: "OpenA", quote: original } },
      { ...verified, object: { value: "ChatGPT", quote: original } },
      { ...verified, version: { value: "5.3", quote: original } },
      {
        ...verified,
        anchor: { kind: "official_reference", value: "https://invented.test/52", quote: original },
      },
    ])
      expect(traceableRelatedEvent(field, original)).toBeNull()
    expect(
      traceableRelatedEvent(
        {
          ...verified,
          anchor: {
            kind: "official_reference",
            value: "https://openai.com/notice/52",
            quote: original,
          },
        },
        original,
      ),
    ).not.toBeNull()
    expect(traceableRelatedEvent(verified, "另一个条目的正文")).toBeNull()
  })
  it("旧缓存缺新字段按单event回退，显式空数组不制造新提及", () => {
    const event = materializeEvent(catalog, identity)!
    expect(normalizeEventMentions({ event })).toEqual([
      { identity: event, role: "reports", isPrimary: true },
    ])
    expect(normalizeEventMentions({ event: null })).toEqual([])
    expect(normalizeEventMentions({ event, eventMentions: [] })).toEqual([])
    expect(entryModelOutputSchema.safeParse({ ...base, event }).success).toBe(true)
    expect(
      entryModelOutputSchema.safeParse({
        ...base,
        event,
        eventMentions: [{ identity: event, role: "reports", isPrimary: true }],
      }).success,
    ).toBe(true)
    expect(validateEventMentionRelationship({ event, eventMentions: [] })).toBe(false)
  })
})

describe("主事件逐事实证据范围", () => {
  const event = materializeEvent(catalog, identity)!
  const background = "Beta 发布 Tool 3.0。"
  const secondary = {
    ...event,
    subject: { value: "Beta", quote: background },
    action: { value: "product_release" as const, quote: background },
    object: { value: "Tool", quote: background },
    version: { value: "3.0", quote: background },
  }
  const semantic = {
    event,
    eventMentions: [
      { identity: event, role: "reports" as const, isPrimary: true },
      { identity: secondary, role: "mentions" as const, isPrimary: false },
    ],
  }
  const facts = [{ quote: original }, { quote: background }]
  it("保留主报道事实并隔离背景事件，同片段或重复摘引不能证明归属", () => {
    expect(factsForPrimaryEvent(facts, semantic, `${original}\n${background}`)).toEqual([facts[0]])
    expect(
      factsForPrimaryEvent(facts, semantic, `${original}\n${original}\n${background}`),
    ).toEqual([])
    const mixed = `${original}\n${background}`
    const contaminated = { ...event, subject: { ...event.subject, quote: mixed } }
    expect(
      factsForPrimaryEvent(
        [{ quote: mixed }],
        {
          event: contaminated,
          eventMentions: [
            { ...semantic.eventMentions[0]!, identity: contaminated },
            semantic.eventMentions[1]!,
          ],
        },
        mixed,
      ),
    ).toEqual([])
  })
  it("周报无主事件、分析关系或缺背景证据时仍不进入主事件综合", () => {
    expect(
      factsForPrimaryEvent(
        facts,
        {
          event: null,
          eventMentions: semantic.eventMentions.map((mention) => ({
            ...mention,
            isPrimary: false,
          })),
        },
        `${original}\n${background}`,
      ),
    ).toEqual([])
    expect(
      factsForPrimaryEvent(
        facts,
        {
          ...semantic,
          eventMentions: [
            { ...semantic.eventMentions[0]!, role: "analysis_of" },
            semantic.eventMentions[1]!,
          ],
        },
        `${original}\n${background}`,
      ),
    ).toEqual([])
    expect(factsForPrimaryEvent(facts, semantic, original)).toEqual([])
  })
})

it("融资金额排版不妨碍连续证据验证，数字及拉丁名称边界仍严格区分", () => {
  const quote = "Spiko 完成 9,000 万美元 B 轮融资。"
  const event = {
    kind: "event" as const,
    subject: { value: "Spiko", quote },
    action: { value: "transaction" as const, quote },
    object: { value: "9000万美元B轮融资", quote },
    version: null,
    round: { value: "B", quote },
    anchor: null,
  }
  expect(traceableRelatedEvent(event, quote)).toEqual(event)
  for (const object of ["900万美元B轮融资", "90000万美元B轮融资", "9000万美元A轮融资"])
    expect(traceableRelatedEvent({ ...event, object: { value: object, quote } }, quote)).toBeNull()
  const brokenQuote = "Spi ko 完成 9,000 万美元 B 轮融资。"
  expect(
    traceableRelatedEvent(
      { ...event, subject: { value: "Spiko", quote: brokenQuote } },
      brokenQuote,
    ),
  ).toBeNull()
})
