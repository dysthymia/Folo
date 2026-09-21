import { applyPreset } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { applyPresetToAction } from "./processing-action-preset"

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
})
