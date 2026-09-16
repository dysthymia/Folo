import type {
  PresetApplication,
  PresetId,
  PresetTarget,
  PromptPresetParameter,
} from "@follow/information-core"
import { applyPreset, promptPresets } from "@follow/information-core"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { processingButtonClass, processingInputClass } from "./processing-condition-editor"

const allTargets = [
  "global",
  "ai_transform",
  "ai_aggregate.createPrompt",
  "ai_aggregate.updatePrompt",
  "topic",
] as const satisfies readonly PresetTarget[]

export type ProcessingPresetPickerProps = {
  /** 允许调用方限制当前编辑场景可使用的目标字段。 */
  targets?: readonly PresetTarget[]
  initialTarget?: PresetTarget
  /** 当前文字非空时显示覆盖提示，但只有点击“应用”才会回传新 Prompt。 */
  currentPrompt?: string
  onApply: (application: PresetApplication) => void
}

const getInitialTarget = (
  targets: readonly PresetTarget[],
  initialTarget: PresetTarget | undefined,
): PresetTarget => {
  if (initialTarget && targets.includes(initialTarget)) return initialTarget
  return targets[0] ?? "global"
}

const getParameterValue = (
  parameter: PromptPresetParameter,
  values: Record<string, string>,
): string => {
  const value = values[parameter.key]
  if (value !== undefined) return value
  return parameter.defaultValue === undefined ? "" : String(parameter.defaultValue)
}

export function ProcessingPresetPicker({
  targets,
  initialTarget,
  currentPrompt,
  onApply,
}: ProcessingPresetPickerProps) {
  const { t } = useTranslation("app")
  const targetOptions = targets?.length ? targets : allTargets
  const [target, setTarget] = useState<PresetTarget>(() =>
    getInitialTarget(targetOptions, initialTarget),
  )
  const [presetId, setPresetId] = useState<PresetId | "">("")
  const [values, setValues] = useState<Record<string, string>>({})
  const presets = useMemo(() => promptPresets.filter((item) => item.target === target), [target])
  const selected = presets.find((item) => item.id === presetId)
  const selectedId = selected?.id
  const previewApplication = useMemo(() => {
    if (!selected) return null
    const resolvedValues: Record<string, string | number | undefined> = {}
    for (const parameter of selected.parameters) {
      const value = values[parameter.key] ?? ""
      resolvedValues[parameter.key] = parameter.type === "integer" && value ? Number(value) : value
    }
    try {
      return applyPreset(selected.id, resolvedValues)
    } catch {
      return null
    }
  }, [selected, values])

  useEffect(() => {
    if (targetOptions.includes(target)) return
    setTarget(getInitialTarget(targetOptions, initialTarget))
  }, [initialTarget, target, targetOptions])

  useEffect(() => {
    if (!selectedId) {
      setValues({})
      return
    }
    setValues({})
  }, [selectedId])

  const selectPreset = (nextId: PresetId | "") => {
    setPresetId(nextId)
    setValues({})
  }

  const apply = () => {
    if (!selected) return
    const resolvedValues: Record<string, string | number | undefined> = {}
    for (const parameter of selected.parameters) {
      const value = values[parameter.key] ?? ""
      resolvedValues[parameter.key] = parameter.type === "integer" && value ? Number(value) : value
    }
    try {
      const application = applyPreset(selected.id, resolvedValues)
      onApply(application)
    } catch {
      // applyPreset 统一校验必填项、整数范围和字符串长度，界面只展示可理解的提示。
      return
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-fill-secondary bg-fill-quinary p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t("processing.preset_target_label")}</span>
          <select
            className={processingInputClass}
            value={target}
            onChange={(event) => {
              const nextTarget = event.target.value as PresetTarget
              setTarget(nextTarget)
              selectPreset("")
            }}
          >
            {targetOptions.map((item) => (
              <option key={item} value={item}>
                {t(`processing.preset_target.${item}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>{t("processing.preset")}</span>
          <select
            className={processingInputClass}
            value={presetId}
            onChange={(event) => selectPreset(event.target.value as PresetId | "")}
          >
            <option value="">{t("processing.preset_choose")}</option>
            {presets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} v{item.version} · {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selected && (
        <>
          <p className="text-sm text-text-secondary">{selected.description}</p>
          <p className="text-xs text-text-tertiary">
            {t("processing.preset_conditions")}: {selected.suggestedConditions}
          </p>
          {selected.parameters.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {selected.parameters.map((parameter) => (
                <label key={parameter.key} className="space-y-1 text-sm">
                  <span>{parameter.label}</span>
                  <input
                    className={processingInputClass}
                    type={parameter.type === "integer" ? "number" : "text"}
                    min={parameter.type === "integer" ? parameter.minimum : undefined}
                    max={parameter.type === "integer" ? parameter.maximum : undefined}
                    minLength={parameter.type === "string" ? parameter.minimumLength : undefined}
                    maxLength={parameter.type === "string" ? parameter.maximumLength : undefined}
                    required={parameter.required}
                    value={getParameterValue(parameter, values)}
                    onChange={(event) =>
                      setValues((previous) => ({
                        ...previous,
                        [parameter.key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {currentPrompt?.trim() && (
            <p role="note" className="text-sm text-orange">
              {t("processing.preset_replace_notice")}
            </p>
          )}
          {!previewApplication && (
            <p role="alert" className="text-sm text-red">
              {t("processing.preset_invalid_parameters")}
            </p>
          )}
          <section aria-label={t("processing.preset_preview")} className="space-y-2">
            <h4 className="text-sm font-medium">{t("processing.preset_preview")}</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1 rounded border border-fill-secondary p-3">
                <p className="text-xs font-medium text-text-secondary">
                  {t("processing.preset_current")}
                </p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {currentPrompt?.trim() || t("processing.preset_current_empty")}
                </pre>
              </div>
              <div className="min-w-0 space-y-1 rounded border border-fill-secondary p-3">
                <p className="text-xs font-medium text-text-secondary">
                  {t("processing.preset_preview_version", {
                    id: selected.id,
                    version: selected.version,
                  })}
                </p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {previewApplication?.prompt || t("processing.preset_preview_unavailable")}
                </pre>
              </div>
            </div>
          </section>
        </>
      )}
      <button
        type="button"
        className={processingButtonClass}
        disabled={!selected || !previewApplication}
        onClick={apply}
      >
        {t("processing.preset_apply")}
      </button>
    </div>
  )
}
