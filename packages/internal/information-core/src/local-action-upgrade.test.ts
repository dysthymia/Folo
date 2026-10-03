import { describe, expect, it } from "vitest"

import { convertLocalActionRule } from "./local-action-upgrade"
import { compileInstructions, matchConditions, ruleUsesAI } from "./rules"

const legacy = {
  localId: "stable-id",
  index: 0,
  name: "普通本地规则",
  condition: [[{ field: "entry_title", operator: "contains", value: "AI" }]],
  result: { block: true, silence: true },
}
const options = { ownerId: "owner", order: 0 }

describe("convertLocalActionRule", () => {
  it("转换普通动作并保持稳定 ID、停用状态和组间或/组内与语义", () => {
    const result = convertLocalActionRule(
      { ...legacy, result: { block: true, disabled: true } },
      options,
    )
    expect(result).toMatchObject({
      success: true,
      rule: {
        id: "local-stable-id",
        enabled: false,
        actions: [{ type: "local_filter", mode: "block" }],
        when: { anyOf: [{ allOf: [{ field: "entry_title", operator: "contains", value: "AI" }] }] },
      },
    })
  })

  it("普通动作不会触发模型，也不因未知条件阻塞 AI 展示", () => {
    const result = convertLocalActionRule(legacy, options)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(ruleUsesAI(result.rule)).toBe(false)
    const compiled = compileInstructions(
      {
        formatVersion: 4,
        ownerId: "owner",
        global: { markdown: "全局提示", version: 1 },
        rules: [result.rule],
      },
      { source_id: null, contextId: "test" },
    )
    expect(compiled.blocksFinalPresentation).toBe(false)
    expect(compiled.transformations).toEqual([])
    expect(compiled.aggregates).toEqual([])
    expect(compiled.dedupes).toEqual([])
  })

  it("只有真正无条件的 [] 可转换为 ALL，占位、未知动作和 regex 必须显式拒绝", () => {
    expect(convertLocalActionRule({ ...legacy, condition: [] }, options)).toMatchObject({
      success: true,
      rule: { when: { all: true } },
    })
    for (const condition of [[[{}]], [[]], [[{ field: "title", operator: "regex", value: "AI" }]]])
      expect(convertLocalActionRule({ ...legacy, condition }, options).success).toBe(false)
    expect(convertLocalActionRule({ ...legacy, localId: undefined }, options).success).toBe(false)
    expect(convertLocalActionRule({ ...legacy, result: { webhook: true } }, options).success).toBe(
      false,
    )
  })

  it("收藏优先的旧状态在所有 read/collected 组合上保持原语义", () => {
    const comparisons = [
      ["eq", "read"],
      ["eq", "unread"],
      ["eq", "collected"],
      ["not_eq", "read"],
      ["contains", "read"],
      ["not_contains", "read"],
    ] as const
    for (const [operator, value] of comparisons) {
      const result = convertLocalActionRule(
        {
          ...legacy,
          condition: [[{ field: "status", operator, value }]],
        },
        options,
      )
      expect(result.success).toBe(true)
      if (!result.success) continue
      for (const read of [true, false])
        for (const collected of [true, false]) {
          const status = collected ? "collected" : read ? "read" : "unread"
          const expected =
            operator === "eq"
              ? status === value
              : operator === "not_eq"
                ? status !== value
                : operator === "contains"
                  ? status.includes(value)
                  : !status.includes(value)
          expect(
            matchConditions(result.rule.when, {
              source_id: "feed/1",
              contextId: "entry",
              read,
              collected,
            }).state,
          ).toBe(expected ? "match" : "no_match")
        }
    }
  })
})
