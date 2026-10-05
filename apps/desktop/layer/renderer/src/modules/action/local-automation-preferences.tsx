import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useSettingModal } from "~/modules/settings/modal/use-setting-modal-hack"

import { getOneTimeToken } from "../ai-chat/local-provider"
import { notifyLocalAutomationChanged } from "./local-automation-events"
import type {
  EffectiveProcessing,
  ProcessingEditor,
  ProcessingSchedule,
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
      runOnListLoad !== (schedule.config.runOnListLoad !== false))
  // 同页切换公共设置也必须保护草稿，由父编辑器统一管理离开提示。
  useEffect(() => {
    onDirty(markdown !== baseline || scheduleDirty)
    return () => onDirty(false)
  }, [markdown, baseline, scheduleDirty, onDirty])
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
      )
      if (controller.signal.aborted) return
      onSaved(result)
      setBaseline(markdown)
      setActiveMarkdown(result.effectiveConfig.global.markdown)
      setSaved(true)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const saveTiming = async () => {
    // 先保留旧计划范围，再允许把调度切换到按规则选源。
    if (!schedule?.config || migrationRequired) return
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError(false)
    setSaved(false)
    try {
      // 此处只管何时运行，来源自动跟随规则，用户无需重复选择分类和订阅。
      const value = await client.saveSchedule(
        {
          ...schedule.config,
          scope: { mode: "rules" },
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
        <button
          type="button"
          disabled={markdown === activeMarkdown}
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
