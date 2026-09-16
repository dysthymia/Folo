import { describe, expect, it } from "vitest"

import { previewActionMigration } from "./action-migration"

const exportData = (rule: Record<string, unknown>) => ({
  version: "1.0",
  exportDate: "2026-09-12T00:00:00.000Z",
  rules: [rule],
})

describe("previewActionMigration", () => {
  it("把旧的无条件占位和显式 processing action 转成草稿规则", () => {
    const result = previewActionMigration(
      exportData({
        name: "AI rule",
        condition: [[{}]],
        result: { actions: [{ type: "ai_transform", prompt: "保留事实" }], summary: false },
      }),
    )

    expect(result.valid).toBe(true)
    expect(result.supported).toHaveLength(1)
    expect(result.supported[0]).toMatchObject({
      when: { all: true },
      actions: [{ type: "ai_transform", prompt: "保留事实" }],
      executionLocation: "processing_service",
    })
  })

  it("保留旧条件语义并转换旧表单的数值和集合值", () => {
    const result = previewActionMigration(
      exportData({
        name: "Filtered",
        condition: [
          [
            { field: "entry_media_length", operator: "gt", value: "2" },
            { field: "source_id", operator: "in", value: "feed:1" },
          ],
        ],
        result: { actions: [{ type: "display", summaryMaxGraphemes: 500 }] },
      }),
    )

    expect(result.supported[0]?.when).toEqual({
      anyOf: [
        {
          allOf: [
            { field: "entry_media_length", operator: "gt", value: 2 },
            { field: "source_id", operator: "in", value: ["feed:1"] },
          ],
        },
      ],
    })
  })

  it("未知字段逐条拒绝，且不会把条件变成 ALL", () => {
    const result = previewActionMigration(
      exportData({
        name: "Unknown",
        condition: [[{ field: "unknown_field", operator: "eq", value: "x" }]],
        result: { actions: [{ type: "ai_transform", prompt: "x" }] },
      }),
    )

    expect(result.rows[0]?.status).toBe("unsupported")
    expect(result.rows[0]?.rule).toBeUndefined()
    expect(result.rows[0]?.issues).toEqual([
      { code: "unsupported_condition", path: "rules[0].condition[0][0]" },
    ])
  })

  it("拒绝旧回溯正则，避免把不同引擎的文本语义默认为等价", () => {
    const result = previewActionMigration(
      exportData({
        name: "Regex",
        condition: [[{ field: "entry_title", operator: "regex", value: "(AI)" }]],
        result: { actions: [{ type: "ai_transform", prompt: "x" }] },
      }),
    )

    expect(result.rows[0]?.status).toBe("unsupported")
    expect(result.rows[0]?.issues).toContainEqual({
      code: "unsupported_condition",
      path: "rules[0].condition[0][0]",
    })
  })

  it("不吞掉已知旧动作的非法值", () => {
    const result = previewActionMigration(
      exportData({
        name: "Invalid action value",
        condition: [],
        result: { summary: "yes" },
      }),
    )

    expect(result.rows[0]?.status).toBe("unsupported")
    expect(result.rows[0]?.issues).toContainEqual({
      code: "unsupported_action",
      path: "rules[0].result.summary",
    })
  })

  it("把副作用动作标记为不可迁移，不静默删除", () => {
    const result = previewActionMigration(
      exportData({
        name: "Webhook",
        condition: [],
        result: { webhooks: ["https://example.test/hook"] },
      }),
    )

    expect(result.rows[0]?.status).toBe("unsupported")
    expect(result.rows[0]?.issues).toContainEqual({
      code: "external_side_effect",
      path: "rules[0].result.webhooks",
    })
  })

  it("拒绝非旧导出封装和额外字段", () => {
    expect(previewActionMigration({ version: "1.0", rules: [], extra: true }).fatalIssues).toEqual([
      { code: "invalid_export", path: "export" },
    ])
  })
})
