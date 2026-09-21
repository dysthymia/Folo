import { actionSchema, applyPreset } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { applyPresetToAction, createSameEventAggregateAction } from "./processing-action-preset"

describe("processing action preset application", () => {
  it("把 P15 参数化模板应用到当前 topic 聚合动作", () => {
    const actions = [
      {
        type: "ai_aggregate" as const,
        mode: "same_event" as const,
        scope: { all: true as const },
        createPrompt: "原创建 Prompt",
        updatePrompt: "原更新 Prompt",
      },
    ]
    const application = applyPreset("P15", {
      topicScope: "AI 产品",
      cutoff: "每周日",
    })

    expect(applyPresetToAction(actions, 0, application)[0]).toMatchObject({
      type: "ai_aggregate",
      mode: "topic",
      createPrompt: expect.stringContaining("AI 产品"),
      updatePrompt: "原更新 Prompt",
      presets: { create: { id: "P15", version: 1 } },
    })
  })

  it("同事件综述默认动作自带创建与更新要求，并沿用规则范围", () => {
    const action = createSameEventAggregateAction()

    if (action.type !== "ai_aggregate") throw new Error("unexpected action type")

    // 用户不必先手写两段 Prompt 才能保存：默认动作必须直接通过 schema 校验。
    expect(actionSchema.safeParse(action).success).toBe(true)
    expect(action.mode).toBe("same_event")
    expect(action.scope).toEqual({ all: true })
    expect(action.createPrompt.length).toBeGreaterThan(0)
    expect(action.updatePrompt.length).toBeGreaterThan(0)
    expect(action.presets?.create?.id).toBe("P06")
    expect(action.presets?.update?.id).toBe("P07")
  })
})
