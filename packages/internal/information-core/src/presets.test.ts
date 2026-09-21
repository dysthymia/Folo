import { describe, expect, it } from "vitest"

import {
  applyPreset,
  comparePresetVersion,
  mergePresetApplication,
  preset,
  presetIds,
  promptPresets,
} from "./presets"

describe("共享 Prompt 预设目录", () => {
  it("完整提供 P00 至 P15 的稳定 ID、版本和中文元数据", () => {
    expect(presetIds).toEqual([
      "P00",
      "P01",
      "P02",
      "P03",
      "P04",
      "P05",
      "P06",
      "P07",
      "P08",
      "P09",
      "P10",
      "P11",
      "P12",
      "P13",
      "P14",
      "P15",
    ])
    expect(promptPresets).toHaveLength(16)
    for (const item of promptPresets) {
      expect(item.version).toBe(1)
      expect(item.name).not.toBe("")
      expect(item.description).not.toBe("")
      expect(item.prompt).not.toBe("")
    }
  })

  it("展开明确参数，拒绝超范围、错误类型和未声明参数", () => {
    expect(applyPreset("P01").prompt).toContain("少于50")
    expect(applyPreset("P01", { N: 800 }).prompt).toContain("少于800")
    expect(() => applyPreset("P01", { N: 0 })).toThrow("invalid_preset_parameter:N")
    expect(() => applyPreset("P01", { N: "50" })).toThrow("invalid_preset_parameter:N")
    expect(applyPreset("P13").prompt).toContain("提供简体中文")
    expect(applyPreset("P13", { targetLanguage: "English" }).prompt).toContain("提供English")
    expect(applyPreset("P09", { summaryMaxGraphemes: 800 }).display).toEqual({
      type: "display",
      summaryMaxGraphemes: 800,
    })
    expect(applyPreset("P09", { summaryMaxGraphemes: 200 }).display).toEqual({
      type: "display",
      summaryMaxGraphemes: 200,
    })
    expect(() => applyPreset("P09", { summaryMaxGraphemes: 200.5 })).toThrow(
      "invalid_preset_parameter:summaryMaxGraphemes",
    )
    expect(() => applyPreset("P09", { unknown: 200 })).toThrow("unknown_preset_parameter")
    expect(() => applyPreset("P15")).toThrow("missing_preset_parameter:topicScope")
  })

  it("P06 与 P07 分别只返回同一聚合动作的创建和更新字段", () => {
    const create = applyPreset("P06")
    const update = applyPreset("P07")

    expect(create).toMatchObject({
      target: "ai_aggregate.createPrompt",
      patch: { presets: { create: { id: "P06", version: 1 } } },
    })
    expect(update).toMatchObject({
      target: "ai_aggregate.updatePrompt",
      patch: { presets: { update: { id: "P07", version: 1 } } },
    })
    expect("createPrompt" in update.patch).toBe(false)
    expect("updatePrompt" in create.patch).toBe(false)
  })

  it("每次应用返回用户副本，目录和已有私人 Prompt 都不会被模板改写", () => {
    const first = applyPreset("P01")
    const privatePrompt = { prompt: "用户自己修改后的 Prompt", preset: first.presetRef }
    const second = applyPreset("P01", { N: 200 })

    expect(first).not.toBe(second)
    expect(first.prompt).toContain("少于50")
    expect(second.prompt).toContain("少于200")
    expect(privatePrompt.prompt).toBe("用户自己修改后的 Prompt")
    expect(preset("P01").prompt).toContain("少于{N}")
  })

  it("按正整数版本识别升级，并让追加预览与最终 patch 保持一致", () => {
    expect(comparePresetVersion({ id: "P01", version: 1 }, { id: "P01", version: 2 })).toBe(
      "upgrade",
    )
    expect(comparePresetVersion({ id: "P01", version: 3 }, { id: "P01", version: 2 })).toBe("newer")
    const merged = mergePresetApplication(applyPreset("P01", { N: 80 }), "私人要求", "append")
    expect(merged.prompt).toMatch(/^私人要求\n\n/)
    expect(merged.patch).toMatchObject({ type: "ai_transform", prompt: merged.prompt })
  })
})
