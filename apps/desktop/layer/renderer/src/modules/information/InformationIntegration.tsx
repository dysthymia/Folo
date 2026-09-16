import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type {
  ExportPreview,
  ExternalExport,
  IntegrationSettings,
} from "./information-integration-client"
import {
  confirmExport,
  IntegrationRequestError,
  loadIntegrationSettings,
  prepareExport,
  reconcileExport,
  saveIntegrationSettings,
} from "./information-integration-client"

type InformationIntegrationProps = {
  /** 没有 storyId 时只显示私有配置入口；传入 storyId 时显示该 Story 的手动保存流程。 */
  storyId?: string
}

const emptySettings: IntegrationSettings = {
  notion: { enabled: false, parentPageId: null },
}

const errorKey = (error: unknown) => {
  if (error instanceof IntegrationRequestError) return error.kind
  return "request"
}

export function InformationIntegration({ storyId }: InformationIntegrationProps) {
  const { t } = useTranslation("app")
  const translate = (key: string) => t(key as never)
  const [settings, setSettings] = useState<IntegrationSettings>(emptySettings)
  const [enabled, setEnabled] = useState(false)
  const [parentPageId, setParentPageId] = useState("")
  const [token, setToken] = useState("")
  const [destinationPageId, setDestinationPageId] = useState("")
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [exportRecord, setExportRecord] = useState<ExternalExport | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller
    setLoading(true)
    setError(null)
    void loadIntegrationSettings(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setSettings(data.integrations)
        setEnabled(data.integrations.notion.enabled)
        setParentPageId(data.integrations.notion.parentPageId ?? "")
        if (!storyId) setDestinationPageId(data.integrations.notion.parentPageId ?? "")
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorKey(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [storyId])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const data = await saveIntegrationSettings(
        {
          notion: {
            enabled,
            ...(parentPageId.trim() ? { parentPageId: parentPageId.trim() } : {}),
            ...(token.trim() ? { token: token.trim() } : {}),
          },
        },
        controllerRef.current?.signal ?? new AbortController().signal,
      )
      setSettings(data.integrations)
      setEnabled(data.integrations.notion.enabled)
      setParentPageId(data.integrations.notion.parentPageId ?? "")
      if (!storyId) setDestinationPageId(data.integrations.notion.parentPageId ?? "")
    } catch (cause) {
      setError(errorKey(cause))
    } finally {
      // 秘密只在提交请求期间存在于输入状态，成功或失败都不回显服务端 token。
      setToken("")
      setSaving(false)
    }
  }

  const prepare = async () => {
    if (!storyId || !destinationPageId.trim()) return
    setPreparing(true)
    setError(null)
    setPreview(null)
    setExportRecord(null)
    try {
      const result = await prepareExport(
        storyId,
        destinationPageId.trim(),
        controllerRef.current?.signal ?? new AbortController().signal,
      )
      if ("disabled" in result) {
        setSettings(result.integrations)
        setError("disabled")
      } else {
        setPreview(result.preview)
        setExportRecord(result.export)
      }
    } catch (cause) {
      setError(errorKey(cause))
    } finally {
      setPreparing(false)
    }
  }

  const confirm = async () => {
    if (!exportRecord || exportRecord.status !== "prepared") return
    setConfirming(true)
    setError(null)
    try {
      const result = await confirmExport(
        exportRecord.id,
        controllerRef.current?.signal ?? new AbortController().signal,
      )
      setExportRecord(result.export)
    } catch (cause) {
      setError(errorKey(cause))
    } finally {
      setConfirming(false)
    }
  }

  const reconcile = async () => {
    if (!exportRecord || exportRecord.status !== "unknown") return
    setReconciling(true)
    setError(null)
    try {
      const result = await reconcileExport(
        exportRecord.id,
        controllerRef.current?.signal ?? new AbortController().signal,
      )
      setExportRecord(result.export)
    } catch (cause) {
      setError(errorKey(cause))
    } finally {
      setReconciling(false)
    }
  }

  return (
    <section
      aria-labelledby={storyId ? "information-notion-export" : "information-notion-settings"}
      className="space-y-5 rounded-xl border border-fill-secondary bg-material-thick p-5 sm:p-6"
    >
      <div className="space-y-1">
        <h2
          id={storyId ? "information-notion-export" : "information-notion-settings"}
          className="text-lg font-semibold"
        >
          {t(storyId ? "information.integration.export_title" : "information.integration.title")}
        </h2>
        <p className="text-sm leading-6 text-text-secondary">
          {t(
            storyId
              ? "information.integration.export_description"
              : "information.integration.description",
          )}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red">
          {translate(`information.integration.error.${error}`)}
        </p>
      )}

      {!storyId && (
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t("information.integration.enabled")}
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            <span>{t("information.integration.parent_page")}</span>
            <input
              value={parentPageId}
              onChange={(event) => setParentPageId(event.target.value)}
              placeholder={t("information.integration.parent_page_placeholder")}
              autoComplete="off"
              className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            <span>{t("information.integration.token")}</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={t("information.integration.token_placeholder")}
              autoComplete="new-password"
              className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
            />
          </label>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <p className="text-xs text-text-secondary">
              {settings.notion.enabled
                ? t("information.integration.configured")
                : t("information.integration.not_configured")}
            </p>
            <button
              type="submit"
              disabled={loading || saving || (enabled && !parentPageId.trim())}
              className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? t("information.integration.saving") : t("information.integration.save")}
            </button>
          </div>
        </form>
      )}

      {storyId && (
        <div className="space-y-4">
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t("information.integration.destination")}</span>
            <input
              value={destinationPageId}
              onChange={(event) => setDestinationPageId(event.target.value)}
              placeholder={t("information.integration.destination_placeholder")}
              autoComplete="off"
              className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
            />
          </label>
          <button
            type="button"
            disabled={preparing || !destinationPageId.trim()}
            onClick={() => void prepare()}
            className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {preparing
              ? t("information.integration.preparing")
              : t("information.integration.preview")}
          </button>

          {preview && exportRecord && (
            <div className="space-y-3 rounded-lg border border-fill-secondary p-4">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <strong>{preview.title}</strong>
                <span className="text-text-secondary">
                  {t("information.integration.revision", { revision: preview.revision })}
                </span>
              </div>
              <p className="text-xs text-text-secondary">
                {t("information.integration.frozen_preview")}
              </p>
              <textarea
                readOnly
                value={preview.markdown}
                aria-label={t("information.integration.markdown_preview")}
                className="min-h-52 w-full resize-y rounded-lg border border-fill bg-fill-secondary p-3 font-mono text-xs leading-5 text-text"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-text-secondary">
                  {translate(`information.integration.status.${exportRecord.status}`)}
                </span>
                {exportRecord.status === "prepared" && (
                  <button
                    type="button"
                    disabled={confirming}
                    onClick={() => void confirm()}
                    className="rounded-lg bg-green px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {confirming
                      ? t("information.integration.confirming")
                      : t("information.integration.confirm")}
                  </button>
                )}
                {exportRecord.status === "unknown" && (
                  <>
                    <p className="basis-full text-sm text-orange">
                      {t("information.integration.unknown_hint")}
                    </p>
                    <button
                      type="button"
                      disabled={reconciling}
                      onClick={() => void reconcile()}
                      className="rounded-lg border border-orange/40 px-4 py-2 text-sm font-medium disabled:opacity-50"
                    >
                      {reconciling
                        ? t("information.integration.reconciling")
                        : t("information.integration.reconcile")}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
