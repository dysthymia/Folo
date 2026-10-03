// @vitest-environment jsdom
import type { AutomationRule } from "@follow/information-core"
import { compileInstructions, ruleSetSchema } from "@follow/information-core"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { addLocalRuleAction, LocalRuleActions, removeLocalRuleAction } from "./local-rule-actions"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const render = (actions: AutomationRule["actions"]) =>
  renderToStaticMarkup(
    <LocalRuleActions
      actions={actions}
      onChange={vi.fn()}
      sources={[]}
      tags={[]}
      listMemberships={[]}
    />,
  )

describe("LocalRuleActions", () => {
  it("shows Prompt only after choosing an AI action, then removes exactly that action", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    let actions: AutomationRule["actions"] = []
    const draw = () =>
      root.render(
        <LocalRuleActions
          actions={actions}
          onChange={(next) => {
            actions = next
            draw()
          }}
          sources={[]}
          tags={[]}
          listMemberships={[]}
        />,
      )
    try {
      await act(async () => draw())
      const choose = async (kind: string) => {
        await act(async () => {
          const select = container.querySelector("select")!
          select.value = kind
          select.dispatchEvent(new Event("change", { bubbles: true }))
        })
      }
      await choose("block")
      expect(actions).toEqual([{ type: "local_filter", mode: "block" }])
      expect(container.querySelector("textarea")).toBeNull()
      await choose("filter")
      expect(actions[1]).toMatchObject({ type: "ai_transform" })
      expect(container.querySelector("textarea")?.value).toContain("disposition=hide")
      await act(async () => {
        container.querySelectorAll("button")[1]!.click()
      })
      expect(actions).toEqual([{ type: "local_filter", mode: "block" }])
      await choose("translate")
      expect(container.querySelector("textarea")?.value).toContain("逐段翻译为简体中文")
      expect(container.querySelectorAll("h4")[1]?.textContent).toBe("automation.action.translation")
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it("adds ordinary and AI actions without losing existing actions or leaving an empty Prompt", () => {
    const original: AutomationRule["actions"] = [
      { type: "presentation", policy: { rewrite: "deny" } },
      { type: "display", language: "ja" },
    ]
    const withBlock = addLocalRuleAction(original, "block")
    const withSummary = addLocalRuleAction(withBlock, "summary")
    expect(withSummary.slice(0, 3)).toEqual([...original, { type: "local_filter", mode: "block" }])
    expect(withSummary[3]).toMatchObject({ type: "ai_transform" })
    expect(withSummary[3]?.type === "ai_transform" && withSummary[3].prompt.length).toBeGreaterThan(
      0,
    )
    expect(removeLocalRuleAction(withSummary, 2)).toEqual([...original, withSummary[3]])
    expect(render(withSummary)).toContain("automation.action.remove")
  })

  it("保存重载后的翻译动作保留中文要求，并进入实际模型指令", () => {
    const original: AutomationRule["actions"] = [{ type: "local_filter", mode: "silence" }]
    const actions = addLocalRuleAction(original, "translate")
    const config = ruleSetSchema.parse(
      JSON.parse(
        JSON.stringify({
          formatVersion: 4,
          ownerId: "owner",
          global: { version: 1, markdown: "" },
          rules: [
            {
              id: "translation",
              ownerId: "owner",
              name: "翻译",
              enabled: true,
              order: 0,
              when: { all: true },
              actions,
              version: 1,
              executionLocation: "processing_service",
            },
          ],
        }),
      ),
    )
    expect(config.rules[0]!.actions[0]).toEqual(original[0])
    expect(config.rules[0]!.actions[1]).toMatchObject({
      type: "ai_transform",
      preset: { id: "P13" },
    })
    const compiled = compileInstructions(config, { source_id: "feed/1", contextId: "feed/1" })
    expect(compiled.transformations).toHaveLength(1)
    expect(compiled.transformations[0]!.prompt).toContain("逐段翻译为简体中文")
    expect(compiled.transformations[0]!.prompt).toContain("不要用摘要代替翻译")
    expect(compiled.transformations[0]!.prompt).toContain("不改变其他筛选规则的决定")
    expect(render(config.rules[0]!.actions)).toContain("automation.action.translation")
  })

  it("enables aggregation by default while preserving explicit policy and other actions", () => {
    const original: AutomationRule["actions"] = [
      { type: "local_filter", mode: "silence" },
      { type: "presentation", policy: { rewrite: "deny", standalone: "always" } },
    ]
    const next = addLocalRuleAction(original, "aggregate")
    expect(next[0]).toEqual(original[0])
    expect(next[1]).toEqual({
      type: "presentation",
      policy: { rewrite: "deny", standalone: "always", aggregation: "allow" },
    })
    expect(next[2]).toMatchObject({ type: "ai_aggregate", mode: "same_event" })
    expect(render(next)).toContain("automation.action.aggregate_policy_conflict")
    expect(addLocalRuleAction(next, "aggregate")).toBe(next)
  })

  it("keeps an explicit aggregation denial and exposes the existing action in advanced settings", () => {
    const original: AutomationRule["actions"] = [
      { type: "presentation", policy: { aggregation: "deny" } },
      { type: "ai_dedupe", scope: { all: true } },
    ]
    const next = addLocalRuleAction(original, "aggregate")
    expect(next[0]).toEqual(original[0])
    const html = render(next)
    expect(html).toContain("automation.action.aggregate_policy_conflict")
    expect(html).toContain("automation.action.dedupe_hint")
    expect(html).toContain("automation.action.advanced")
  })
})
