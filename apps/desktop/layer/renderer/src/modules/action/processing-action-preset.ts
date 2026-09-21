import type { AutomationRule, PresetApplication } from "@follow/information-core"

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
