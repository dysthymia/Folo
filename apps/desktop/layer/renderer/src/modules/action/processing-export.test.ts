import type { RuleSet } from "@follow/information-core"
import { ruleSetSchema } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { processingExport } from "./processing-export"

const config: RuleSet = {
  formatVersion: 4,
  ownerId: "private-owner",
  global: { version: 1, markdown: "保持引用" },
  rules: [
    {
      id: "private-rule",
      ownerId: "private-owner",
      name: "私人来源规则",
      order: 0,
      version: 1,
      enabled: true,
      executionLocation: "processing_service",
      when: {
        anyOf: [
          {
            allOf: [
              { field: "source_id", operator: "in", value: ["private-source"] },
              { field: "subscription_tag", operator: "not_in", value: ["private-tag"] },
              { field: "category_ref", operator: "eq", value: { view: 0, name: "私人分类" } },
              { field: "view", operator: "eq", value: 0 },
            ],
          },
        ],
      },
      actions: [
        {
          type: "ai_aggregate",
          mode: "same_event",
          createPrompt: "整合事实",
          updatePrompt: "更新事实",
          scope: {
            anyOf: [{ allOf: [{ field: "list_id", operator: "in", value: ["private-list"] }] }],
          },
        },
      ],
    },
  ],
}

describe("规则导出范围", () => {
  it("公开模板移除主条件与聚合范围的私人身份，不改变原草稿且导入后保持停用", () => {
    const before = JSON.stringify(config)
    const exported = processingExport(config, "public")
    const text = JSON.stringify(exported)
    for (const privateValue of [
      "private-owner",
      "private-rule",
      "私人来源规则",
      "private-source",
      "private-tag",
      "private-list",
      "私人分类",
    ])
      expect(text).not.toContain(privateValue)
    expect(ruleSetSchema.safeParse(exported).success).toBe(true)
    expect(exported.rules[0]?.enabled).toBe(false)
    expect(exported.global.markdown).toBe(config.global.markdown)
    expect(exported.rules[0]?.when).toMatchObject({
      anyOf: [
        {
          allOf: [
            { field: "source_id", operator: "in", value: ["REPLACE_SOURCE_ID"] },
            { field: "subscription_tag", operator: "not_in", value: ["REPLACE_SUBSCRIPTION_TAG"] },
            { field: "category_ref", operator: "eq", value: { view: 0, name: "REPLACE_CATEGORY" } },
            { field: "view", operator: "eq", value: 0 },
          ],
        },
      ],
    })
    expect(JSON.stringify(config)).toBe(before)
  })
  it("明确选择私人备份时完整保留可恢复配置", () => {
    const backup = processingExport(config, "private")
    expect(backup).toEqual(config)
    expect(backup).not.toBe(config)
  })
})
