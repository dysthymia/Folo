import type { AutomationRule, PresetApplication } from "@follow/information-core"
import { applyPreset } from "@follow/information-core"

type Action = AutomationRule["actions"][number]

const mergePresentation = (actions: Action[], policy: { standalone: "always" }) => {
  const index = actions.findIndex((item) => item.type === "presentation")
  if (index < 0) return [...actions, { type: "presentation" as const, policy }]
  return actions.map((item, itemIndex) =>
    itemIndex === index && item.type === "presentation"
      ? { ...item, policy: { ...item.policy, ...policy } }
      : item,
  )
}

const mergeDisplay = (actions: Action[], summaryMaxGraphemes: number) => {
  const index = actions.findIndex((item) => item.type === "display")
  if (index < 0) return [...actions, { type: "display" as const, summaryMaxGraphemes }]
  return actions.map((item, itemIndex) =>
    itemIndex === index && item.type === "display" ? { ...item, summaryMaxGraphemes } : item,
  )
}

export const applyPresetToAction = (
  actions: Action[],
  index: number,
  application: PresetApplication,
): Action[] => {
  const current = actions[index]
  const patch = application.patch
  if (!current) return actions

  if (
    current.type === "ai_transform" &&
    application.target === "ai_transform" &&
    "type" in patch &&
    patch.type === "ai_transform"
  ) {
    // 预设只在用户明确应用后复制到当前动作，目录升级不会自动覆盖私人 Prompt。
    let nextActions = actions.map((item, itemIndex) =>
      itemIndex === index ? { ...current, prompt: patch.prompt, preset: patch.preset } : item,
    )
    if (application.presentation)
      nextActions = mergePresentation(nextActions, application.presentation.policy)
    if (application.display)
      nextActions = mergeDisplay(nextActions, application.display.summaryMaxGraphemes)
    return nextActions
  }

  if (current.type === "ai_aggregate" && application.target === "topic" && "mode" in patch)
    return actions.map((item, itemIndex) =>
      itemIndex === index && item.type === "ai_aggregate"
        ? {
            ...item,
            mode: patch.mode,
            createPrompt: patch.createPrompt,
            presets: { ...item.presets, create: patch.presets.create },
          }
        : item,
    )

  if (
    current.type === "ai_aggregate" &&
    application.target === "ai_aggregate.createPrompt" &&
    "createPrompt" in patch &&
    "mode" in patch === false
  )
    return actions.map((item, itemIndex) =>
      itemIndex === index && item.type === "ai_aggregate"
        ? {
            ...item,
            createPrompt: patch.createPrompt,
            presets: { ...item.presets, create: patch.presets.create },
          }
        : item,
    )

  if (
    current.type === "ai_aggregate" &&
    application.target === "ai_aggregate.updatePrompt" &&
    "updatePrompt" in patch
  )
    return actions.map((item, itemIndex) =>
      itemIndex === index && item.type === "ai_aggregate"
        ? {
            ...item,
            updatePrompt: patch.updatePrompt,
            presets: { ...item.presets, update: patch.presets.update },
          }
        : item,
    )

  return actions
}

/**
 * "同事件综述" 的默认动作。
 *
 * 用户不该为了建立一次跨文章整合先去理解单篇处理与跨篇聚合的区别，也不该被迫
 * 手写两段 Prompt：这里直接带上 P06/P07 预设，并让参与范围继承本条规则范围
 * （`{ all: true }` 在服务端表示不额外限制范围，见 story-engine 的 candidatesForAction）。
 */
export const createSameEventAggregateAction = (): Action => {
  const base: Action = {
    createPrompt: "",
    mode: "same_event",
    scope: { all: true },
    type: "ai_aggregate",
    updatePrompt: "",
  }
  const withCreate = applyPresetToAction([base], 0, applyPreset("P06"))[0]!

  return applyPresetToAction([withCreate], 0, applyPreset("P07"))[0]!
}
