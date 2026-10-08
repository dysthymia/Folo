import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ProcessingSignals } from "./ProcessingSignals"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe("重点与覆盖说明", () => {
  it("规则待定、材料缺失和语义待定分开显示，贡献没有证据时保留未知", () => {
    const markup = renderToStaticMarkup(
      <ProcessingSignals
        signals={{
          pendingPolicyFields: ["aggregation"],
          materialCoverage: "complete",
          semanticAssessmentCoverage: "partial",
          contribution: { state: "present", confidence: 0.7, reason: "仍需核对", evidenceIds: [] },
        }}
      />,
    )
    expect(markup).toContain("processing.signals.pending_policy")
    expect(markup).toContain("processing.signals.assessment_partial")
    expect(markup).not.toContain("processing.signals.material_partial")
    expect(markup).toContain("processing.signals.contribution_unknown")
    expect(markup).not.toContain("processing.signals.contribution_present")
  })
  it("列表期限显示来源原文，不为无时区期限制造紧急；旧覆盖不反推材料缺失", () => {
    const markup = renderToStaticMarkup(
      <ProcessingSignals
        signals={{
          attention: {
            level: "none",
            reasons: [],
            matchedWatchIds: [],
            deadlines: [
              {
                status: "unknown",
                at: null,
                text: "领取截止10月10日",
                evidenceId: "E1",
                reason: "缺少年份及时间区",
              },
            ],
          },
        }}
        compact
      />,
    )
    expect(markup).toContain("领取截止10月10日")
    expect(markup).toContain("processing.attention.deadline_unknown")
    expect(markup).not.toContain('data-attention-level="urgent"')
    const legacy = renderToStaticMarkup(<ProcessingSignals signals={{}} />)
    expect(legacy).toContain("processing.signals.legacy_coverage")
    expect(legacy).not.toContain("processing.signals.material_partial")
  })
  it("紧急级别显示原因，完整结果保留可核对截止原文与明确时区", () => {
    const markup = renderToStaticMarkup(
      <ProcessingSignals
        signals={{
          attention: {
            level: "urgent",
            reasons: ["涉及关注对象；明确近期限"],
            matchedWatchIds: ["watch"],
            deadlines: [
              {
                status: "known",
                at: "2026-10-10T12:00:00+08:00",
                text: "领取截至2026年10月10日12:00北京时间",
                evidenceId: "E1",
                reason: "原文有时区",
              },
            ],
          },
        }}
      />,
    )
    expect(markup).toContain('data-attention-level="urgent"')
    expect(markup).toContain("涉及关注对象")
    expect(markup).toContain("领取截至2026年10月10日12:00北京时间")
    expect(markup).toContain("2026-10-10T12:00:00+08:00")
  })
})
