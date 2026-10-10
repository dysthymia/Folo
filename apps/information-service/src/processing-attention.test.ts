import type {
  AttentionInterest,
  RuleSet,
  SemanticTagId,
  TagAssessment,
} from "@follow/information-core"
import { compileInstructions } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import {
  extractAttentionDeadlines,
  mergeAttention,
  processingAttention,
} from "./processing-attention"
import type { ProcessingDecision } from "./processing-decision"

const now = Date.parse("2026-10-09T00:00:00Z")
const assessment = (tagId: SemanticTagId, patch: Partial<TagAssessment> = {}): TagAssessment => ({
  tagId,
  definitionVersion: 1,
  state: "present",
  confidence: 0.96,
  reason: "原文有证据",
  evidenceIds: ["E1"],
  ...patch,
})
function config(): RuleSet {
  return {
    formatVersion: 5,
    ownerId: "owner",
    global: {
      markdown: "",
      version: 1,
      attention: {
        enabled: true,
        watchlist: [{ id: "acme", name: "Acme", aliases: ["ACME token"] }],
        nearDeadlineHours: 48,
      },
    },
    rules: [],
  }
}
function decision(quote = "Acme 发布了有据实质变化"): ProcessingDecision {
  return {
    schemaVersion: 2,
    fingerprint: "v1",
    generatedAt: "2026-10-09T00:00:00Z",
    durationMs: 1,
    provider: "codex",
    model: "test",
    usage: null,
    status: "keep",
    title: "Acme 新闻",
    summary: "新闻摘要",
    reason: "保留原文",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "reporting",
    context: { contextId: "test", source_id: "feed/1" },
    facts: [],
    semantic: null,
    reused: false,
    semanticProfile: {
      schemaVersion: 2,
      contentVersion: "v1",
      materialDigest: "material",
      definitionDigest: "definition",
      coverage: "complete",
      assessedTagIds: [],
      assessments: [assessment("event:feature_update")],
      evidence: { E1: quote },
      entities: [
        {
          kind: "project",
          name: "Acme",
          parentName: null,
          aliases: [],
          confidence: 0.97,
          evidenceIds: ["E1"],
        },
      ],
    },
  }
}

describe("私人重点关注与证据期限", () => {
  // 截图中的地缘攻击虽在 Blockchain 订阅出现，也不能绕过文章级个人相关性。
  it("宽泛关注规则和来源分类不能把无关地缘攻击升级为关注", () => {
    const settings = config()
    settings.global.attention!.watchlist = []
    settings.global.attention!.interests = ["blockchain", "ai", "personal_growth", "macro"]
    settings.rules = [
      {
        id: "security",
        ownerId: "owner",
        name: "安全事件",
        enabled: true,
        order: 0,
        version: 1,
        executionLocation: "processing_service",
        when: { all: true },
        actions: [{ type: "attention", level: "urgent", reason: "安全事件" }],
      },
    ]
    const item = decision("胡塞武装袭击沙特机场，飞机受损")
    item.context.category = "Blockchain"
    item.semanticProfile!.entities = []
    item.semanticProfile!.assessments = [assessment("event:security_incident")]
    expect(processingAttention({ config: settings, decision: item, now }).level).toBe("none")
  })

  it.each<[AttentionInterest, SemanticTagId]>([
    ["blockchain", "topic:blockchain"],
    ["ai", "topic:ai"],
    ["personal_growth", "topic:personal_growth"],
  ])("%s 的有据实质信息可重要关注，低置信或未知领域不能触发", (interest, topic) => {
    const settings = config()
    settings.global.attention!.watchlist = []
    settings.global.attention!.interests = [interest]
    const item = decision("原文给出可核对的领域方法及使用条件")
    item.semanticProfile!.assessments = [assessment(topic), assessment("form:tutorial")]
    expect(processingAttention({ config: settings, decision: item, now }).level).toBe("important")
    for (const patch of [
      { state: "unknown" as const },
      { confidence: 0.7 },
      { definitionVersion: 99 },
      { evidenceIds: ["missing"] },
    ]) {
      item.semanticProfile!.assessments = [assessment(topic, patch), assessment("form:tutorial")]
      expect(processingAttention({ config: settings, decision: item, now }).level).toBe("none")
    }
  })

  // 领域正证与风险引用直接相连时，仍保留必要的紧急提示。
  it("区块链领域内直接有据的安全事故可以紧急关注", () => {
    const settings = config()
    settings.global.attention!.watchlist = []
    settings.global.attention!.interests = ["blockchain"]
    const item = decision("某 DeFi 协议遭攻击，原文确认资金被盗")
    item.semanticProfile!.assessments = [
      assessment("topic:defi"),
      assessment("event:security_incident"),
    ]
    expect(processingAttention({ config: settings, decision: item, now }).level).toBe("urgent")
    settings.global.attention!.interests = []
    expect(processingAttention({ config: settings, decision: item, now }).level).toBe("none")
  })

  it("宏观市场相关性只能支持重要关注，不单独证明紧急风险", () => {
    const settings = config()
    settings.global.attention!.watchlist = []
    settings.global.attention!.interests = ["macro"]
    const item = decision("央行利率变化与地缘安全消息")
    item.semanticProfile!.assessments = [
      assessment("event:macro_change"),
      assessment("event:security_incident"),
    ]
    expect(processingAttention({ config: settings, decision: item, now })).toMatchObject({
      level: "important",
      reasons: expect.arrayContaining(["与你的关注领域相关：投资交易的宏观与市场信息"]),
    })
  })

  it("AI 方法和另一段安全事件不能共用紧急理由", () => {
    const settings = config()
    settings.global.attention!.watchlist = []
    settings.global.attention!.interests = ["ai"]
    settings.rules = [
      {
        id: "security",
        ownerId: "owner",
        name: "安全事件",
        enabled: true,
        order: 0,
        version: 1,
        executionLocation: "processing_service",
        when: {
          anyOf: [
            {
              allOf: [
                {
                  field: "entry_tag",
                  operator: "contains_any",
                  value: ["event:security_incident"],
                  minConfidence: 0.9,
                },
              ],
            },
          ],
        },
        actions: [{ type: "attention", level: "urgent", reason: "军事安全事件" }],
      },
    ]
    const item = decision("AI 工具教程与可核对的操作步骤")
    item.semanticProfile!.evidence.E2 = "另一条消息是机场受到攻击"
    item.semanticProfile!.assessments = [
      assessment("topic:ai"),
      assessment("form:tutorial"),
      assessment("event:security_incident", { evidenceIds: ["E2"] }),
    ]
    const result = processingAttention({ config: settings, decision: item, now })
    expect(result.level).toBe("important")
    expect(result.reasons).not.toContain("军事安全事件")
    expect(result.reasons).not.toContain("有原文证据支持的安全事件")
    // 个人相关性只影响注意力投影，不改原始安全标签。
    expect(item.semanticProfile!.assessments[2]!.state).toBe("present")
  })
  it("仅关注有据实体的实质变化，不推测持仓或改变原文policy", () => {
    const item = decision()
    expect(processingAttention({ config: config(), decision: item, now })).toMatchObject({
      level: "important",
      matchedWatchIds: ["acme"],
    })
    const empty = config()
    empty.global.attention!.watchlist = []
    expect(processingAttention({ config: empty, decision: item, now }).level).toBe("none")
    expect(item.policy.standalone).toBe("auto")
    item.semanticProfile!.entities![0]!.name = "Acme Labs"
    expect(processingAttention({ config: config(), decision: item, now }).level).toBe("none")
  })
  it("有据相关安全事故或明确时区临近期限才紧急，宣传不能触发", () => {
    const safety = decision("Acme 确认漏洞被利用并说明影响范围")
    safety.semanticProfile!.assessments = [assessment("event:security_incident")]
    expect(processingAttention({ config: config(), decision: safety, now }).level).toBe("urgent")
    const deadline = decision("Acme 领取截止 2026-10-09T14:00:00+08:00")
    deadline.semanticProfile!.assessments = [assessment("event:incentive_airdrop")]
    expect(processingAttention({ config: config(), decision: deadline, now })).toMatchObject({
      level: "urgent",
      deadlines: [{ status: "known", at: "2026-10-09T14:00:00+08:00" }],
    })
    const promo = decision("Acme 紧急领取，马上赚钱！")
    promo.semanticProfile!.assessments = [assessment("signal:pure_promotion")]
    expect(processingAttention({ config: config(), decision: promo, now })).toMatchObject({
      level: "none",
      deadlines: [],
    })
  })
  it("背景提到关注对象不能升级另一对象的安全事故或截止期限", () => {
    const item = decision("Acme 曾经参与过合作")
    item.semanticProfile!.evidence.E2 = "Beta 确认安全事故，领取截止2026-10-09T14:00:00+08:00"
    item.semanticProfile!.assessments = [
      assessment("event:security_incident", { evidenceIds: ["E2"] }),
    ]
    expect(processingAttention({ config: config(), decision: item, now }).level).toBe("none")
  })
  it("低置信、缺证据和旧定义不能触发重点；旧profile缺贡献不伪造贡献", () => {
    const item = decision()
    item.semanticProfile!.entities![0]!.confidence = 0.7
    expect(processingAttention({ config: config(), decision: item, now }).level).toBe("none")
    item.semanticProfile!.entities![0]!.confidence = 0.98
    for (const patch of [
      { confidence: 0.7 },
      { definitionVersion: 99 },
      { evidenceIds: ["missing"] },
      { state: "unknown" as const },
    ])
      expect(
        processingAttention({
          config: config(),
          decision: item,
          assessments: [assessment("event:security_incident", patch)],
          now,
        }).level,
      ).toBe("none")
  })
  it("attention规则独立于AI和presentation，urgent请求没有期限证据时降为important", () => {
    const settings = config()
    settings.global.attention!.watchlist = []
    settings.global.attention!.interests = ["ai"]
    settings.rules = [
      {
        id: "focus",
        ownerId: "owner",
        name: "教程关注",
        enabled: true,
        order: 0,
        version: 1,
        executionLocation: "processing_service",
        when: { all: true },
        actions: [{ type: "attention", level: "urgent", reason: "关注具体可用经验" }],
      },
    ]
    const item = decision()
    item.semanticProfile!.assessments = [assessment("topic:ai"), assessment("form:tutorial")]
    const result = processingAttention({ config: settings, decision: item, now })
    expect(result.level).toBe("important")
    expect(result.reasons).toContain("关注具体可用经验")
    expect(compileInstructions(settings, item.context)).toMatchObject({
      policy: {},
      transformations: [],
      aggregates: [],
    })
    settings.rules[0]!.actions = [{ type: "attention", level: "important", reason: "按重要关注" }]
    item.semanticProfile!.assessments = [
      assessment("topic:ai"),
      assessment("event:security_incident"),
    ]
    expect(processingAttention({ config: settings, decision: item, now }).level).toBe("important")
    settings.global.attention!.enabled = false
    expect(processingAttention({ config: settings, decision: item, now }).level).toBe("none")
  })
  it("缺年份、时区、时间和非法日期都只保留原文，明确过期期限不会紧急", () => {
    const texts = [
      "领取截止 10月10日12:00北京时间",
      "领取截止 2026-10-10 12:00",
      "领取截止 2026年10月10日",
      "领取截止 2026-02-30T12:00:00Z",
      "领取窗口2026-10-10T12:00:00Z开放",
    ]
    for (const text of texts)
      expect(extractAttentionDeadlines({ E1: text })).toEqual([
        expect.objectContaining({ status: "unknown", at: null, text }),
      ])
    const past = decision("Acme 领取截止 2026-10-08T12:00:00Z")
    expect(processingAttention({ config: config(), decision: past, now })).toMatchObject({
      level: "important",
      deadlines: [{ status: "known" }],
    })
    expect(extractAttentionDeadlines({ E1: "发布于2026-10-09T01:00:00Z，领取截止明天" })).toEqual([
      expect.objectContaining({ status: "unknown", text: "领取截止明天" }),
    ])
  })
  it("明确时区可以计算，多成员汇总不产生独立读态", () => {
    expect(extractAttentionDeadlines({ E1: "申领截至 2026年10月10日12:00北京时间" })).toEqual([
      expect.objectContaining({ status: "known", at: "2026-10-10T12:00:00+08:00" }),
    ])
    const one = processingAttention({ config: config(), decision: decision(), now })
    expect(mergeAttention([one, one])).toMatchObject({
      level: "important",
      matchedWatchIds: ["acme"],
      reasons: one.reasons,
    })
  })
})
