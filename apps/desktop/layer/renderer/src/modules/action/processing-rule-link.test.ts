import type { AutomationRule } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import {
  buildProcessingRuleUrl,
  findProcessingRuleForContext,
  parseProcessingRuleContext,
  prepareProcessingRuleContext,
  processingRuleCondition,
} from "./processing-rule-link"

const rule = (when: AutomationRule["when"]): AutomationRule => ({
  id: "rule-1",
  ownerId: "owner-1",
  name: "Rule",
  enabled: true,
  order: 0,
  version: 1,
  executionLocation: "processing_service",
  when,
  actions: [{ type: "ai_transform", prompt: "" }],
})

describe("processing rule context links", () => {
  it("round-trips source, category and view contexts", () => {
    const contexts = [
      { kind: "source", sourceId: "feed/feed-1" },
      { kind: "category", view: 1, name: "Blockchain & AI" },
      { kind: "view", view: 2 },
    ] as const

    for (const context of contexts) {
      const url = new URL(buildProcessingRuleUrl(context), "https://local.folo.is")
      expect(parseProcessingRuleContext(url.search)).toEqual(context)
    }
  })

  it("rejects incomplete and unsupported contexts", () => {
    expect(parseProcessingRuleContext("?processingContext=source")).toBeNull()
    expect(parseProcessingRuleContext("?processingContext=category&view=1")).toBeNull()
    expect(parseProcessingRuleContext("?processingContext=view&view=6")).toBeNull()
  })

  it("creates the expected stable conditions", () => {
    expect(processingRuleCondition({ kind: "source", sourceId: "feed/feed-1" })).toEqual({
      anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["feed/feed-1"] }] }],
    })
    expect(processingRuleCondition({ kind: "category", view: 0, name: "Blockchain" })).toEqual({
      anyOf: [
        {
          allOf: [
            {
              field: "category_ref",
              operator: "eq",
              value: { view: 0, name: "Blockchain" },
            },
          ],
        },
      ],
    })
  })

  it("finds an existing rule that contains the requested context", () => {
    const existing = rule({
      anyOf: [
        {
          allOf: [
            { field: "source_id", operator: "in", value: ["feed/feed-1", "feed/feed-2"] },
            { field: "platform", operator: "eq", value: "x" },
          ],
        },
      ],
    })

    expect(
      findProcessingRuleForContext([existing], { kind: "source", sourceId: "feed/feed-2" }),
    ).toBe(existing)
    expect(
      findProcessingRuleForContext([existing], { kind: "source", sourceId: "feed/missing" }),
    ).toBeNull()
  })

  it("focuses an existing rule or prepares an unsaved contextual draft", () => {
    const existing = rule({
      anyOf: [{ allOf: [{ field: "view", operator: "eq", value: 1 }] }],
    })
    const ruleSet = {
      formatVersion: 4 as const,
      ownerId: "owner-1",
      global: { markdown: "", version: 1 },
      rules: [existing],
    }

    const focused = prepareProcessingRuleContext(
      ruleSet,
      { kind: "view", view: 1 },
      {
        id: "unused",
        name: "Unused",
      },
    )
    expect(focused).toMatchObject({ ruleSet, ruleId: existing.id, created: false })

    const prepared = prepareProcessingRuleContext(
      ruleSet,
      { kind: "category", view: 0, name: "Blockchain" },
      { id: "new-rule", name: "Context rule" },
    )
    expect(prepared).toMatchObject({ ruleId: "new-rule", created: true })
    expect(prepared.ruleSet.rules).toHaveLength(2)
    expect(prepared.ruleSet.rules[1]).toMatchObject({
      id: "new-rule",
      name: "Context rule",
      order: 1,
      when: processingRuleCondition({ kind: "category", view: 0, name: "Blockchain" }),
    })
    expect(ruleSet.rules).toHaveLength(1)
  })
})
