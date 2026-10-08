import type { RuleSet, SemanticTagId, TagAssessment } from "@follow/information-core"
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
    item.semanticProfile!.assessments = [assessment("form:tutorial")]
    const result = processingAttention({ config: settings, decision: item, now })
    expect(result.level).toBe("important")
    expect(result.reasons).toContain("关注具体可用经验")
    expect(compileInstructions(settings, item.context)).toMatchObject({
      policy: {},
      transformations: [],
      aggregates: [],
    })
    settings.rules[0]!.actions = [{ type: "attention", level: "important", reason: "按重要关注" }]
    item.semanticProfile!.assessments = [assessment("event:security_incident")]
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
