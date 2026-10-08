import type { AttentionSettings } from "@follow/information-core"
import { attentionSettingsSchema } from "@follow/information-core"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useSettingModal } from "~/modules/settings/modal/use-setting-modal-hack"

import { getOneTimeToken } from "../ai-chat/local-provider"
import { notifyLocalAutomationChanged } from "./local-automation-events"
import { ProcessingAttentionSettings } from "./processing-attention-settings"
import { ProcessingClassificationSettings } from "./processing-classification-settings"
import type {
  EffectiveProcessing,
  ProcessingEditor,
  ProcessingSchedule,
  ProcessingScheduleConfig,
  RuleActivation,
} from "./processing-client"
import { createProcessingClient } from "./processing-client"
import { processingButtonClass, processingInputClass } from "./processing-condition-editor"
import { ProcessingExportControls } from "./processing-export-controls"

const client = createProcessingClient(getOneTimeToken)

export function LocalAutomationPreferences({
  editor,
  effective,
  onSaved,
  onDirty,
  onBusy,
  migrationRequired,
  onHistory,
}: {
  editor: ProcessingEditor
  effective: EffectiveProcessing | null
  onSaved: (result: RuleActivation) => void
  onDirty: (dirty: boolean) => void
  onBusy: (busy: boolean) => void
  migrationRequired: boolean
  onHistory: () => void
}) {
  const { t } = useTranslation("app")
  const showSettings = useSettingModal()
  // 展示已保存的草稿（含模板G00），启用比较单独使用发布版本，不用旧正文遮住待启用内容。
  const initial = editor.config.global.markdown
  const [markdown, setMarkdown] = useState(initial)
  const [baseline, setBaseline] = useState(initial)
  const [activeMarkdown, setActiveMarkdown] = useState(effective?.config?.global.markdown ?? null)
  const [attention, setAttention] = useState<AttentionSettings | undefined>(
    editor.config.global.attention,
  )
  const [attentionBaseline, setAttentionBaseline] = useState(
    JSON.stringify(editor.config.global.attention),
  )
  const [activeAttention, setActiveAttention] = useState(
    JSON.stringify(effective?.config?.global.attention),
  )
  const attentionValue = JSON.stringify(attention)
  const attentionValid =
    attention === undefined || attentionSettingsSchema.safeParse(attention).success
  const [classification, setClassification] =
    useState<ProcessingScheduleConfig["classification"]>(undefined)
  const [schedule, setSchedule] = useState<ProcessingSchedule | null>(null)
  const [times, setTimes] = useState("")
  const [timeZone, setTimeZone] = useState("")
  const [enabled, setEnabled] = useState(false)
  const [runOnListLoad, setRunOnListLoad] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const scheduleDirty =
    !!schedule?.config &&
    (times !== schedule.config.times.join(", ") ||
      timeZone !== schedule.config.timeZone ||
      enabled !== schedule.config.enabled ||
      runOnListLoad !== (schedule.config.runOnListLoad !== false) ||
      JSON.stringify(classification) !== JSON.stringify(schedule.config.classification))
  // 同页切换公共设置也必须保护草稿，由父编辑器统一管理离开提示。
  useEffect(() => {
    onDirty(markdown !== baseline || attentionValue !== attentionBaseline || scheduleDirty)
    return () => onDirty(false)
  }, [markdown, baseline, attentionValue, attentionBaseline, scheduleDirty, onDirty])
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  useEffect(() => {
    const controller = new AbortController()
    void client
      .loadSchedule(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        setSchedule(value)
        setClassification(value.config?.classification)
        setTimes(value.config?.times.join(", ") ?? "")
        setTimeZone(value.config?.timeZone ?? "")
        setRunOnListLoad(value.config?.runOnListLoad !== false)
        setEnabled(value.config?.enabled ?? false)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => {
      controller.abort()
      controllerRef.current?.abort()
    }
  }, [])
  const saveGlobal = async () => {
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError(false)
    setSaved(false)
    try {
      // 公共要求单独生效，不顺带发布规则列表里的其它草稿。
      const result = await client.activateGlobal(
        markdown,
        editor.revision,
        crypto.randomUUID(),
        controller.signal,
        attention,
      )
      if (controller.signal.aborted) return
      onSaved(result)
      setBaseline(markdown)
      setAttentionBaseline(JSON.stringify(result.config.global.attention))
      setAttention(result.config.global.attention)
      setActiveAttention(JSON.stringify(result.effectiveConfig.global.attention))
      setActiveMarkdown(result.effectiveConfig.global.markdown)
      setSaved(true)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const saveTiming = async () => {
    // 迁移确认前禁止保存，避免公共设置改变尚未确认的旧计划。
    if (!schedule?.config || migrationRequired) return
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError(false)
    setSaved(false)
    try {
      // 仅替换当前控件字段，保留计划范围、历史起点以及主动分类首次启用水位。
      const value = await client.saveSchedule(
        {
          ...schedule.config,
          ...(classification === undefined ? {} : { classification }),
          times: times.split(/[,，\s]+/).filter(Boolean),
          timeZone,
          enabled,
          runOnListLoad,
        },
        schedule.revision,
        controller.signal,
      )
      if (controller.signal.aborted) return
      setSchedule(value)
      setClassification(value.config?.classification)
      setTimes(value.config?.times.join(", ") ?? "")
      setRunOnListLoad(value.config?.runOnListLoad !== false)
      setSaved(true)
      notifyLocalAutomationChanged()
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 overflow-y-auto pb-6">
      <p className="text-sm text-text-secondary">{t("automation.editor.preferences_hint")}</p>
      {error && (
        <p role="alert" className="text-sm text-red">
          {t("automation.editor.error_request")}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-green">
          {t("automation.editor.saved")}
        </p>
      )}
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-fill-secondary p-5">
        <label className="block space-y-2 text-sm">
          <span className="font-medium">{t("automation.editor.global")}</span>
          <textarea
            rows={5}
            maxLength={60000}
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            className={processingInputClass}
          />
        </label>
        <p className="text-xs text-text-secondary">{t("automation.editor.global_hint")}</p>
        <ProcessingAttentionSettings value={attention} onChange={setAttention} />
        <button
          type="button"
          disabled={
            !attentionValid || (markdown === activeMarkdown && attentionValue === activeAttention)
          }
          className={processingButtonClass}
          onClick={() => void saveGlobal()}
        >
          {t("automation.editor.save_global")}
        </button>
      </fieldset>
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-fill-secondary p-5">
        <h3 className="font-medium">{t("automation.editor.schedule")}</h3>
        <p className="text-sm text-text-secondary">{t("automation.editor.scope_hint")}</p>
        {schedule?.config ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              {t("automation.editor.schedule_enabled")}
            </label>
            {/* 列表与定时共用已发布规则和总开关，允许独立关闭列表触发。 */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={runOnListLoad}
                onChange={(event) => setRunOnListLoad(event.target.checked)}
              />
              {t("processing.run.on_list_load")}
            </label>
            <p className="text-xs text-text-secondary">{t("processing.run.on_list_load_hint")}</p>
            <ProcessingClassificationSettings value={classification} onChange={setClassification} />
            <label className="block space-y-2 text-sm">
              <span>{t("automation.editor.times")}</span>
              <input
                className={processingInputClass}
                value={times}
                onChange={(event) => setTimes(event.target.value)}
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>{t("automation.editor.timezone")}</span>
              <input
                className={processingInputClass}
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!scheduleDirty || migrationRequired}
              className={processingButtonClass}
              onClick={() => void saveTiming()}
            >
              {t("automation.editor.save_schedule")}
            </button>
          </>
        ) : (
          <p className="text-sm text-text-secondary">{t("automation.editor.no_schedule")}</p>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={processingButtonClass} onClick={() => showSettings("ai")}>
          {t("automation.editor.model")}
        </button>
        <a className={processingButtonClass} href="/action?scope=processing_service&advanced=1">
          {t("automation.editor.advanced")}
        </a>
        <button type="button" className={processingButtonClass} onClick={onHistory}>
          {t("automation.editor.history")}
        </button>
      </div>
      <details className="rounded-lg border border-fill-secondary p-4">
        <summary className="cursor-pointer text-sm">{t("automation.editor.export")}</summary>
        <div className="mt-3">
          <ProcessingExportControls config={effective?.config ?? editor.config} />
        </div>
      </details>
    </div>
  )
}
