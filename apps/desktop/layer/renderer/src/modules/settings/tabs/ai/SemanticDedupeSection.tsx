import type { SemanticDedupeReasoningEffort } from "@follow/shared/settings/interface"
import type { ChangeEvent } from "react"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { setAISetting, useAISettingValue } from "~/atoms/settings/ai"

import {
  SettingDescription,
  SettingInput,
  SettingSwitch,
  SettingTabbedSegment,
} from "../../control"

const reasoningEffortOptions: SemanticDedupeReasoningEffort[] = ["minimal", "low", "medium", "high"]

export const SemanticDedupeSection = () => {
  const { t } = useTranslation("ai")
  const settings = useAISettingValue()
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
        <SettingSwitch
          checked={settings.semanticDedupeEnabled}
          label={t("semantic_dedupe.enabled.label")}
          onCheckedChange={(checked) => setAISetting("semanticDedupeEnabled", checked)}
        />
        <SettingDescription className="-mt-2">
          {t("semantic_dedupe.enabled.description")}
        </SettingDescription>
      </div>

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
            value={settings.semanticDedupeReasoningEffort}
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
