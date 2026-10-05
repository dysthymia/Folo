import { useWhoami } from "@follow/store/user/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { notifyLocalAutomationChanged } from "~/modules/action/local-automation-events"
import type {
  ProcessingModelCatalog,
  ProcessingModelSettings,
  ProcessingReasoningEffort,
} from "~/modules/action/processing-client"
import { createProcessingClient } from "~/modules/action/processing-client"
import {
  processingButtonClass,
  processingInputClass,
} from "~/modules/action/processing-condition-editor"
import { getOneTimeToken, isLocalFoloHost } from "~/modules/ai-chat/local-provider"

const client = createProcessingClient(getOneTimeToken)
const qianwenBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const effortLabels = {
  none: "automation.model.effort_none",
  minimal: "automation.model.effort_minimal",
  low: "automation.model.effort_low",
  medium: "automation.model.effort_medium",
  high: "automation.model.effort_high",
  xhigh: "automation.model.effort_xhigh",
  max: "automation.model.effort_max",
  ultra: "automation.model.effort_ultra",
} as const satisfies Record<ProcessingReasoningEffort, string>
const supportedEfforts = (model?: ProcessingModelCatalog["models"][number]) =>
  model?.reasoningEfforts.filter(
    (effort): effort is ProcessingReasoningEffort => effort in effortLabels,
  ) ?? []

// 只归一化基础地址，不把密码、查询参数或正文带进密钥复用判断。
function canonicalBaseUrl(value: string) {
  try {
    const url = new URL(value.trim())
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null
    return url.href.replace(/\/+$/u, "")
  } catch {
    return null
  }
}

export function LocalProcessingModelSection() {
  const ownerId = useWhoami()?.id
  return isLocalFoloHost() && ownerId ? <ProcessingModelEditor key={ownerId} /> : null
}

/** 使用后台真实执行配置；本机对话共用该配置，原 Folo 云端/BYOK 配置保持独立。 */
export function ProcessingModelEditor() {
  const { t } = useTranslation("app")
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState<ProcessingModelSettings | null>(null)
  const [mode, setMode] = useState<"codex" | "custom">("custom")
  const [customProvider, setCustomProvider] = useState<"qianwen" | "openai-compatible">(
    "openai-compatible",
  )
  const [customModel, setCustomModel] = useState("")
  const [codexModel, setCodexModel] = useState("")
  const [reasoningEffort, setReasoningEffort] = useState<ProcessingReasoningEffort>("low")
  const [baseUrl, setBaseUrl] = useState(qianwenBaseUrl)
  const [catalog, setCatalog] = useState<ProcessingModelCatalog | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogReload, setCatalogReload] = useState(0)
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  const saveRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setError(false)
    void client
      .loadModelSettings(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        setSettings(value)
        setMode(value.provider === "codex" ? "codex" : "custom")
        if (value.provider === "codex") {
          setCodexModel(value.model)
          // 未保存过推理强度的旧配置沿用 low，不按模型默认值自动提高用量。
          setReasoningEffort(value.reasoningEffort ?? "low")
        } else {
          setCustomProvider(value.provider)
          setCustomModel(value.model)
          setBaseUrl(value.baseUrl ?? qianwenBaseUrl)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => {
      controller.abort()
      saveRef.current?.abort()
    }
  }, [reload])
  useEffect(() => {
    if (mode !== "codex") return
    const controller = new AbortController()
    setCatalogBusy(true)
    setCatalogError(false)
    void client
      .loadModelCatalog(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        setCatalog(value)
        // 只为尚未选过 Codex 的草稿预选，不能静默替换当前已保存模型。
        setCodexModel((previous) => previous || value.models[0]?.id || "")
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogBusy(false)
      })
    return () => controller.abort()
  }, [mode, catalogReload])
  const canonicalUrl = canonicalBaseUrl(baseUrl)
  const selectedCodexModel = catalog?.models.find((item) => item.id === codexModel)
  const allowedEfforts = supportedEfforts(selectedCodexModel)
  const previousUrl = settings?.provider === "qianwen" ? qianwenBaseUrl : settings?.baseUrl
  const retainedKey = Boolean(
    settings?.hasApiKey &&
    settings.provider === customProvider &&
    canonicalUrl &&
    canonicalUrl === canonicalBaseUrl(previousUrl ?? ""),
  )
  const validSelection =
    mode === "codex"
      ? !catalogBusy &&
        !catalogError &&
        catalog?.available &&
        selectedCodexModel &&
        allowedEfforts.includes(reasoningEffort)
      : Boolean(customModel.trim() && canonicalUrl && (apiKey.trim() || retainedKey))
  const selectedModel = mode === "codex" ? codexModel : customModel.trim()
  const save = async () => {
    if (!settings || busy || !validSelection) return
    const controller = new AbortController()
    saveRef.current = controller
    setBusy(true)
    setError(false)
    setSaved(false)
    try {
      const value = await client.saveModelSettings(
        mode === "codex"
          ? { provider: "codex", model: selectedModel, reasoningEffort }
          : {
              provider: customProvider,
              model: selectedModel,
              ...(customProvider === "openai-compatible" ? { baseUrl: canonicalUrl! } : {}),
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setSettings(value)
      setSaved(true)
      // 本机对话用同一模型配置，保存后刷新其缓存，防止模型指示器滞后。
      void queryClient.invalidateQueries({ queryKey: ["localAISettings"] })
      notifyLocalAutomationChanged()
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      // 密钥不进入客户端持久化，保存成功和失败都立即清空输入。
      if (!controller.signal.aborted) {
        setApiKey("")
        setBusy(false)
      }
    }
  }
  return (
    <section
      id="settings-ai-processing-model"
      className="my-5 space-y-3 rounded-xl border border-fill-secondary p-4"
    >
      <h3 className="font-medium">{t("automation.model.title")}</h3>
      <p className="text-xs leading-relaxed text-text-secondary">
        {t("automation.model.boundary")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-red">
          {t("automation.editor.error_request")}{" "}
          <button
            type="button"
            className={processingButtonClass}
            onClick={() => setReload((value) => value + 1)}
          >
            {t("processing.report.refresh")}
          </button>
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-green">
          {t("automation.model.saved")}
        </p>
      )}
      {settings && mode === "custom" && (
        <p className="text-xs text-text-secondary">
          {t(
            retainedKey
              ? "information.model_settings.key_configured"
              : "information.model_settings.key_missing",
          )}
        </p>
      )}
      <fieldset disabled={!settings || busy} className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span>{t("automation.model.source")}</span>
          <select
            className={processingInputClass}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as "codex" | "custom")
              setSaved(false)
              setApiKey("")
            }}
          >
            <option value="codex">{t("automation.model.codex")}</option>
            <option value="custom">{t("automation.model.custom")}</option>
          </select>
        </label>
        {mode === "codex" ? (
          <div className="space-y-2">
            <label className="block space-y-1 text-sm">
              <span>{t("automation.model.codex_model")}</span>
              <select
                className={processingInputClass}
                value={codexModel}
                disabled={catalogBusy || !catalog?.available}
                onChange={(event) => {
                  const next = event.target.value
                  const model = catalog?.models.find((item) => item.id === next)
                  const efforts = supportedEfforts(model)
                  setCodexModel(next)
                  // 用户切换模型时，原强度若不受支持则明确改为该模型支持的默认选项。
                  if (!efforts.includes(reasoningEffort))
                    setReasoningEffort(
                      efforts.find((effort) => effort === model?.defaultReasoningEffort) ??
                        efforts[0] ??
                        "low",
                    )
                  setSaved(false)
                }}
              >
                {!catalog?.models.some((item) => item.id === codexModel) && (
                  <option value={codexModel} disabled>
                    {codexModel || t("automation.model.catalog_loading")}
                  </option>
                )}
                {catalog?.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName === item.id ? item.id : `${item.displayName} · ${item.id}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("automation.model.reasoning_effort")}</span>
              <select
                className={processingInputClass}
                value={reasoningEffort}
                disabled={catalogBusy || !selectedCodexModel || allowedEfforts.length === 0}
                onChange={(event) => {
                  setReasoningEffort(event.target.value as ProcessingReasoningEffort)
                  setSaved(false)
                }}
              >
                {!allowedEfforts.includes(reasoningEffort) && (
                  <option value={reasoningEffort} disabled>
                    {reasoningEffort}
                  </option>
                )}
                {allowedEfforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {t(effortLabels[effort])} · {effort}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-text-secondary">{t("automation.model.effort_hint")}</p>
            {selectedCodexModel && !catalogBusy && !allowedEfforts.includes(reasoningEffort) && (
              <p role="alert" className="text-xs text-red">
                {t("automation.model.effort_unavailable")}
              </p>
            )}
            {catalogBusy ? (
              <p className="text-xs text-text-secondary">{t("automation.model.catalog_loading")}</p>
            ) : catalogError || !catalog?.available ? (
              <p role="alert" className="text-xs text-red">
                {t("automation.model.catalog_unavailable")}
              </p>
            ) : (
              <p className="text-xs text-text-secondary">
                {t(
                  catalog.stale
                    ? "automation.model.catalog_cached"
                    : "automation.model.catalog_live",
                )}
              </p>
            )}
            {catalog?.available &&
              codexModel &&
              !catalog.models.some((item) => item.id === codexModel) && (
                <p role="alert" className="text-xs text-red">
                  {t("automation.model.catalog_missing")}
                </p>
              )}
            <p className="text-xs text-text-secondary">
              {catalog?.models.find((item) => item.id === codexModel)?.description}
            </p>
            <button
              type="button"
              className={processingButtonClass}
              disabled={catalogBusy}
              onClick={() => setCatalogReload((value) => value + 1)}
            >
              {t("automation.model.catalog_refresh")}
            </button>
            <p className="text-xs text-text-secondary">{t("automation.model.codex_hint")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              className={processingButtonClass}
              onClick={() => {
                setCustomProvider("qianwen")
                setBaseUrl(qianwenBaseUrl)
                setCustomModel(settings?.provider === "qianwen" ? settings.model : "qwen3.8-flash")
                setApiKey("")
                setSaved(false)
              }}
            >
              {t("automation.model.qianwen_preset")}
            </button>
            <label className="block space-y-1 text-sm">
              <span>{t("automation.model.base_url")}</span>
              <input
                type="url"
                className={processingInputClass}
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => {
                  const next = event.target.value
                  // 地址变化后不复用旧提供商的密钥；同一千问地址继续兼容已有配置。
                  setCustomProvider(
                    settings?.provider === "qianwen" && canonicalBaseUrl(next) === qianwenBaseUrl
                      ? "qianwen"
                      : "openai-compatible",
                  )
                  setBaseUrl(next)
                  setApiKey("")
                  setSaved(false)
                }}
              />
            </label>
            <p className="text-xs text-text-secondary">{t("automation.model.custom_hint")}</p>
            <label className="block space-y-1 text-sm">
              <span>{t("information.model_settings.model")}</span>
              <input
                className={processingInputClass}
                value={customModel}
                onChange={(event) => {
                  setCustomModel(event.target.value)
                  setSaved(false)
                }}
              />
            </label>
          </div>
        )}
        {mode === "custom" && (
          <label className="block space-y-1 text-sm">
            <span>{t("information.model_settings.api_key")}</span>
            <input
              type="password"
              autoComplete="new-password"
              className={processingInputClass}
              value={apiKey}
              placeholder={t("information.model_settings.api_key_placeholder")}
              onChange={(event) => {
                setApiKey(event.target.value)
                setSaved(false)
              }}
            />
          </label>
        )}
        <button
          type="button"
          className={processingButtonClass}
          disabled={!validSelection}
          onClick={() => void save()}
        >
          {t(busy ? "information.model_settings.saving" : "information.model_settings.save")}
        </button>
        <p className="text-xs text-text-secondary">{t("automation.model.save_hint")}</p>
      </fieldset>
    </section>
  )
}
