import type { SemanticDedupeReasoningEffort } from "@follow/shared/settings/interface"
import type { ChangeEvent } from "react"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { setAISetting, useAISettingValue } from "~/atoms/settings/ai"
import { useSemanticDedupeEvaluatorAvailability } from "~/providers/semantic-dedupe-provider"

import {
  SettingDescription,
  SettingInput,
  SettingSwitch,
  SettingTabbedSegment,
} from "../../control"

const reasoningEffortOptions: SemanticDedupeReasoningEffort[] = ["low", "medium", "high", "xhigh"]

const normalizeReasoningEffort = (value: string): SemanticDedupeReasoningEffort =>
  reasoningEffortOptions.includes(value as SemanticDedupeReasoningEffort)
    ? (value as SemanticDedupeReasoningEffort)
    : "low"

export const SemanticDedupeSection = () => {
  const { t } = useTranslation("ai")
  const { t: tApp } = useTranslation("app")
  const settings = useAISettingValue()
  const availability = useSemanticDedupeEvaluatorAvailability()
  const reasoningEffort = normalizeReasoningEffort(settings.semanticDedupeReasoningEffort)
  const effortValues = useMemo(
    () =>
      reasoningEffortOptions.map((value) => ({
        label: t(`semantic_dedupe.effort.${value}`),
        value,
      })),
    [t],
  )

  const handleModelChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAISetting("semanticDedupeModel", event.target.value)
  }

  return (
    <div className="-mt-4 space-y-4">
      <div>
        <SettingDescription className="-mt-2">
          {tApp("processing.local_dedupe.description")}
        </SettingDescription>
      </div>

      <div>
        <SettingSwitch
          checked={settings.semanticDedupeEnabled}
          label={tApp("processing.local_dedupe.enabled.label")}
          onCheckedChange={(checked) => setAISetting("semanticDedupeEnabled", checked)}
        />
        <SettingDescription className="-mt-2">
          {tApp("processing.local_dedupe.enabled.description")}
        </SettingDescription>
      </div>

      {availability.available ? (
        <div className="rounded-md border border-border bg-fill-secondary px-3 py-2 text-xs leading-relaxed text-text-tertiary">
          {tApp(`processing.local_dedupe.availability.reason.${availability.reason}`)}
        </div>
      ) : (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
          <p className="font-medium text-amber-600 dark:text-amber-400">
            {tApp("processing.local_dedupe.availability.unavailable")}
          </p>
          <p className="mt-1 text-text-secondary">
            {tApp(`processing.local_dedupe.availability.reason.${availability.reason}`)}
          </p>
        </div>
      )}

      {settings.semanticDedupeEnabled && (
        <>
          <div>
            <SettingInput
              label={t("semantic_dedupe.model.label")}
              onChange={handleModelChange}
              type="text"
              value={settings.semanticDedupeModel}
            />
            <SettingDescription>{t("semantic_dedupe.model.description")}</SettingDescription>
          </div>

          <SettingTabbedSegment
            description={t("semantic_dedupe.effort.description")}
            label={t("semantic_dedupe.effort.label")}
            onValueChanged={(value) =>
              setAISetting("semanticDedupeReasoningEffort", value as SemanticDedupeReasoningEffort)
            }
            value={reasoningEffort}
            values={effortValues}
          />

          <div>
            <SettingSwitch
              checked={settings.semanticDedupeDebugPanel}
              label={t("semantic_dedupe.debug.label")}
              onCheckedChange={(checked) => setAISetting("semanticDedupeDebugPanel", checked)}
            />
            <SettingDescription className="-mt-2">
              {t("semantic_dedupe.debug.description")}
            </SettingDescription>
          </div>
        </>
      )}
    </div>
  )
}
