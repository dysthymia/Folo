import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { ProcessingDecisionsSettings } from "~/modules/action/processing-client"
import { createProcessingClient } from "~/modules/action/processing-client"
import {
  processingButtonClass,
  processingInputClass,
} from "~/modules/action/processing-condition-editor"
import { getOneTimeToken } from "~/modules/ai-chat/local-provider"

const client = createProcessingClient(getOneTimeToken)

export function DecisionsSettingsSection() {
  const { t } = useTranslation("app")
  const [settings, setSettings] = useState<ProcessingDecisionsSettings | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof client.loadDecisionsAudit>> | null>(
    null,
  )
  const [error, setError] = useState<"settings" | "save" | null>(null)
  const [auditError, setAuditError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  const saveRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    setAuditError(false)
    setSaved(false)
    void Promise.allSettled([
      client.loadDecisionsSettings(controller.signal),
      client.loadDecisionsAudit(controller.signal),
    ]).then(([value, records]) => {
      if (controller.signal.aborted) return
      if (value.status === "fulfilled") setSettings(value.value)
      else {
        setSettings(null)
        setError("settings")
      }
      if (records.status === "fulfilled") setAudit(records.value)
      else {
        setAudit(null)
        setAuditError(true)
      }
    })
    return () => {
      controller.abort()
      saveRef.current?.abort()
    }
  }, [reload])
  const save = async () => {
    if (!settings || busy || !validNumbers) return
    const controller = new AbortController()
    saveRef.current = controller
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      const { hasApiKey: _hasKey, endpoint: _endpoint, model: _model, ...input } = settings
      const value = await client.saveDecisionsSettings(
        { ...input, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
        controller.signal,
      )
      if (!controller.signal.aborted) {
        setSettings(value)
        setSaved(true)
      }
    } catch {
      if (!controller.signal.aborted) setError("save")
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false)
        setApiKey("")
      }
    }
  }
  const records = audit?.records ?? []
  const dedupeRecords = audit?.dedupeRecords ?? []
  const validNumbers =
    settings !== null &&
    Number.isFinite(settings.threshold) &&
    // 输入范围与前后端校验保持一致。
    settings.threshold >= 0.85 &&
    settings.threshold <= 0.999 &&
    Number.isInteger(settings.maxInputChars) &&
    settings.maxInputChars >= 500 &&
    settings.maxInputChars <= 60_000 &&
    Number.isInteger(settings.maxRequestsPerRun) &&
    settings.maxRequestsPerRun >= 1 &&
    settings.maxRequestsPerRun <= 100 &&
    Number.isInteger(settings.dedupeObservation.maxPairsPerTrigger) &&
    settings.dedupeObservation.maxPairsPerTrigger >= 1 &&
    settings.dedupeObservation.maxPairsPerTrigger <= 24
  const attempted = [...records, ...dedupeRecords].filter((record) => record.attempted)
  const knownCost = attempted.reduce((sum, record) => sum + (record.usage?.cost ?? 0), 0)
  const unknownCost = attempted.filter((record) => record.usage?.cost == null).length
  return (
    <section
      className="my-5 space-y-3 rounded-xl border border-fill-secondary p-4"
      aria-label={t("automation.decisions.title")}
    >
      <h3 className="font-medium">{t("automation.decisions.title")}</h3>
      <p className="text-xs leading-relaxed text-text-secondary">
        {t("automation.decisions.boundary")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-red">
          {t(
            error === "settings"
              ? "automation.decisions.settings_error"
              : "automation.decisions.save_error",
          )}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-green">
          {t("automation.decisions.saved")}
        </p>
      )}
      {settings && (
        <fieldset disabled={busy} className="space-y-3" onChange={() => setSaved(false)}>
          <p className="break-all text-xs text-text-secondary">
            {settings.model} · {settings.endpoint}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
            <span>{t("automation.decisions.enabled")}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.classificationEnabled !== false}
              onChange={(event) =>
                setSettings({ ...settings, classificationEnabled: event.target.checked })
              }
            />
            <span>{t("automation.decisions.classification_enabled")}</span>
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("automation.decisions.dedupe_model")}</span>
            <select
              className={processingInputClass}
              value={
                settings.dedupeObservation.enabled
                  ? (settings.dedupeObservation.mode ?? "observe")
                  : "generation"
              }
              onChange={(event) =>
                setSettings({
                  ...settings,
                  dedupeObservation: {
                    ...settings.dedupeObservation,
                    enabled: event.target.value !== "generation",
                    mode: event.target.value === "apply" ? "apply" : "observe",
                  },
                })
              }
            >
              <option value="generation">{t("automation.decisions.dedupe_generation")}</option>
              <option value="observe">{t("automation.decisions.dedupe_observe")}</option>
              <option value="apply">{t("automation.decisions.dedupe_apply")}</option>
            </select>
          </label>
          <p className="text-xs leading-relaxed text-text-secondary">
            {t("automation.decisions.dedupe_boundary")}
          </p>
          {/* 复核会增加普通模型用量，单独展示并要求显式选择。 */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.dedupeObservation.generationFallback === true}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  dedupeObservation: {
                    ...settings.dedupeObservation,
                    generationFallback: event.target.checked,
                  },
                })
              }
            />
            <span>{t("automation.decisions.dedupe_fallback")}</span>
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("automation.decisions.dedupe_limit")}</span>
            <input
              type="number"
              className={processingInputClass}
              min={1}
              max={24}
              step={1}
              value={settings.dedupeObservation.maxPairsPerTrigger}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  dedupeObservation: {
                    ...settings.dedupeObservation,
                    maxPairsPerTrigger: Number(event.target.value),
                  },
                })
              }
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("automation.decisions.mode")}</span>
            <select
              className={processingInputClass}
              value={settings.mode}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  mode: event.target.value === "apply" ? "apply" : "observe",
                })
              }
            >
              <option value="observe">{t("automation.decisions.observe")}</option>
              <option value="apply">{t("automation.decisions.apply")}</option>
            </select>
          </label>
          {(
            [
              ["threshold", 0.85, 0.999, 0.001],
              ["maxInputChars", 500, 60_000, 1],
              ["maxRequestsPerRun", 1, 100, 1],
            ] as const
          ).map(([key, min, max, step]) => (
            <label key={key} className="block space-y-1 text-sm">
              <span>{t(`automation.decisions.${key}`)}</span>
              <input
                className={processingInputClass}
                type="number"
                min={min}
                max={max}
                step={step}
                value={settings[key]}
                onChange={(event) =>
                  setSettings({ ...settings, [key]: Number(event.target.value) })
                }
              />
            </label>
          ))}
          <label className="block space-y-1 text-sm">
            <span>{t("automation.decisions.key")}</span>
            <input
              className={processingInputClass}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <p className="text-xs text-text-secondary">
            {t(
              settings.hasApiKey
                ? "information.model_settings.key_configured"
                : "information.model_settings.key_missing",
            )}
          </p>
          <button
            type="button"
            className={processingButtonClass}
            disabled={!validNumbers || (settings.enabled && !settings.hasApiKey && !apiKey.trim())}
            onClick={save}
          >
            {t("automation.decisions.save")}
          </button>
          {!validNumbers && (
            <p role="alert" className="text-sm text-red">
              {t("automation.decisions.invalid_numbers")}
            </p>
          )}
        </fieldset>
      )}
      {auditError && (
        <p role="alert" className="text-sm text-red">
          {t("automation.decisions.audit_error")}
        </p>
      )}
      {audit && (
        <p className="text-xs text-text-secondary">
          {t("automation.decisions.cost", {
            requests: attempted.length,
            cost: knownCost.toFixed(6),
            unknown: unknownCost,
          })}
        </p>
      )}
      {audit && (
        <p className="text-xs text-text-secondary">
          {t("automation.decisions.dedupe_counts", {
            pairs: dedupeRecords.length,
            agree: dedupeRecords.filter((record) => record.comparison === "agree").length,
            disagree: dedupeRecords.filter((record) => record.comparison === "disagree").length,
            unknown: dedupeRecords.filter((record) => record.comparison === "unavailable").length,
          })}
        </p>
      )}
      <button
        type="button"
        className={processingButtonClass}
        disabled={busy}
        onClick={() => setReload((value) => value + 1)}
      >
        {t("processing.report.refresh")}
      </button>
      {records.length > 0 && (
        <details className="text-xs text-text-secondary">
          <summary>{t("automation.decisions.audit")}</summary>
          <ul className="mt-2 space-y-1">
            {records.map((record, index) => (
              <li key={`${record.inputSeq}-${index}`}>
                <details>
                  <summary>
                    #{record.inputSeq} · {record.model ?? "—"} · {record.status} ·{" "}
                    {record.code ?? "—"} · {record.usage?.input_tokens ?? "?"}/
                    {record.usage?.output_tokens ?? "?"} · ${record.usage?.cost ?? "?"}
                  </summary>
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(
                      {
                        contentVersion: record.contentVersion,
                        generation: record.generation,
                        ruleIds: record.ruleIds,
                        fingerprint: record.fingerprint,
                        tagIds: record.tagIds,
                        answers: record.answers,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
      {dedupeRecords.length > 0 && (
        <details className="text-xs text-text-secondary">
          <summary>{t("automation.decisions.dedupe_audit")}</summary>
          <ul className="mt-2 space-y-1">
            {dedupeRecords.map((record) => (
              <li key={record.evidenceKey}>
                <details>
                  <summary>
                    {record.inputs.map((input) => `#${input.seq}`).join(" / ")} ·{" "}
                    {t(`automation.decisions.comparison_${record.comparison}`)} · {record.status} ·{" "}
                    {record.code ?? "—"} · ${record.usage?.cost ?? "?"}
                  </summary>
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(record, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
