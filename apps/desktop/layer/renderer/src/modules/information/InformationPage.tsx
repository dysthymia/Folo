import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { oneTimeToken } from "~/lib/auth"

import { InformationIntegration } from "./InformationIntegration"
import { ProcessingDiagnostics } from "./ProcessingDiagnostics"
import { ProcessingReader } from "./ProcessingReader"
import type { InformationAISettings } from "./session"
import {
  InformationLoadError,
  loadInformationAISettings,
  loadInformationSnapshot,
  saveInformationAISettings,
} from "./session"
import type { InformationSnapshot } from "./snapshot"
import { XSearchPanel } from "./XSearchPanel"

type LoadError = InformationLoadError["kind"]
const statuses = ["queued", "running", "succeeded", "failed"] as const

export function InformationPage() {
  const { t, i18n } = useTranslation("app")
  const [snapshot, setSnapshot] = useState<InformationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadError | null>(null)
  const [settings, setSettings] = useState<InformationAISettings | null>(null)
  const [settingsError, setSettingsError] = useState<LoadError | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [provider, setProvider] = useState<InformationAISettings["provider"]>("qianwen")
  const [model, setModel] = useState("qwen3.8-flash")
  const [apiKey, setApiKey] = useState("")
  const requestRef = useRef<AbortController | null>(null)
  // 跟踪当前快照的所有者，用于回前台时核验账号是否变化（避免闭包拿到旧值）。
  const snapshotRef = useRef<InformationSnapshot | null>(null)
  snapshotRef.current = snapshot

  const refresh = useCallback(async () => {
    // 刷新时取消前一个请求，避免旧账号或旧快照覆盖最新响应。
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setSnapshot(null)
    setError(null)
    setSettings(null)
    setSettingsError(null)
    try {
      const data = await loadInformationSnapshot(() => oneTimeToken.generate(), controller.signal)
      if (controller.signal.aborted) return
      setSnapshot(data)
      // 登录校验完成后才读取模型设置，避免未授权状态额外访问本地服务。
      try {
        const nextSettings = await loadInformationAISettings(
          () => oneTimeToken.generate(),
          controller.signal,
        )
        if (!controller.signal.aborted) {
          setSettings(nextSettings)
          setProvider(nextSettings.provider)
          setModel(nextSettings.model)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSettingsError(error instanceof InformationLoadError ? error.kind : "request")
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setSnapshot(null)
        setError(error instanceof InformationLoadError ? error.kind : "request")
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 隐藏时只中止在途请求，不销毁子树（保留页码/滚动/所选条目）；
    // 回前台只核验账号：同账号复用既有快照与阅读进度，不重置；仅当账号变化才替换快照并重新初始化阅读器。
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        requestRef.current?.abort()
        return
      }
      void (async () => {
        requestRef.current?.abort()
        const controller = new AbortController()
        requestRef.current = controller
        try {
          const data = await loadInformationSnapshot(
            () => oneTimeToken.generate(),
            controller.signal,
          )
          if (controller.signal.aborted) return
          if (snapshotRef.current?.ownerId === data.ownerId) return
          // 账号变化：完整重新初始化（含设置与阅读器），等价于一次显式刷新。
          setSnapshot(data)
          setSettings(null)
          setSettingsError(null)
          try {
            const nextSettings = await loadInformationAISettings(
              () => oneTimeToken.generate(),
              controller.signal,
            )
            if (!controller.signal.aborted) {
              setSettings(nextSettings)
              setProvider(nextSettings.provider)
              setModel(nextSettings.model)
            }
          } catch (error) {
            if (!controller.signal.aborted)
              setSettingsError(error instanceof InformationLoadError ? error.kind : "request")
          }
        } catch (error) {
          if (controller.signal.aborted) return
          // 鉴权失败：清掉旧快照，避免展示其它账号或已失效的内容。
          setSnapshot(null)
          setError(error instanceof InformationLoadError ? error.kind : "request")
        }
      })()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      requestRef.current?.abort()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [refresh])

  const formatDate = (value: string) => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18n.language)
  }
  const sourceTitles = new Map(snapshot?.sources.map((source) => [source.key, source.title]))
  const items = new Map(snapshot?.items.map((item) => [item.id, item]))

  const saveSettings = async () => {
    setSavingSettings(true)
    setSettingsError(null)
    try {
      const nextSettings = await saveInformationAISettings(
        { provider, model, ...(apiKey.trim() && { apiKey: apiKey.trim() }) },
        () => oneTimeToken.generate(),
      )
      setSettings(nextSettings)
      setProvider(nextSettings.provider)
      setModel(nextSettings.model)
    } catch (error) {
      setSettingsError(error instanceof InformationLoadError ? error.kind : "request")
    } finally {
      // 密钥输入只存在于保存期间，完成或失败后都立即清空。
      setApiKey("")
      setSavingSettings(false)
    }
  }

  return (
    <main className="h-full overflow-y-auto bg-under-window-background text-text">
      <div className="mx-auto max-w-6xl space-y-8 px-5 py-10 sm:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary">
              Folo
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">{t("information.title")}</h1>
            <p className="text-sm leading-6 text-text-secondary">{t("information.description")}</p>
            {/* 规则统一回到现有 Actions 页面编辑，保持同域和同一份服务端草稿。 */}
            <a
              className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
              href="/action?scope=processing_service"
            >
              {t("processing.open_actions")}
              <i className="i-mgc-arrow-right-cute-re size-4" aria-hidden />
            </a>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-fill bg-fill-secondary px-4 py-2 text-sm font-medium transition-colors hover:bg-fill disabled:opacity-50"
          >
            <i className="i-mgc-refresh-2-cute-re size-4" aria-hidden />
            {loading ? t("information.loading") : t("information.refresh")}
          </button>
        </header>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-orange/30 bg-orange/10 p-5 text-sm leading-6"
          >
            <p className="font-medium">{t(`information.error.${error}`)}</p>
            {error === "authorization" && (
              <a href="/login" className="mt-2 inline-block font-medium text-accent underline">
                {t("information.login")}
              </a>
            )}
            {snapshot && <p>{t("information.stale")}</p>}
          </div>
        )}
        {loading && !snapshot && (
          <p role="status" className="py-12 text-center text-sm text-text-secondary">
            {t("information.loading")}
          </p>
        )}

        {snapshot && (
          <>
            <ProcessingReader key={snapshot.ownerId ?? "unknown"} />
            <XSearchPanel />
            <InformationIntegration />
            <ProcessingDiagnostics />
            <section
              id="model-settings"
              aria-labelledby="information-model-settings"
              className="rounded-xl border border-fill-secondary bg-material-thick p-5 sm:p-6"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 id="information-model-settings" className="text-lg font-semibold">
                    {t("information.model_settings.title")}
                  </h2>
                  <p className="max-w-2xl text-sm leading-6 text-text-secondary">
                    {t("information.model_settings.description")}
                  </p>
                </div>
                {settings && (
                  <span className="rounded bg-fill-secondary px-2 py-1 text-xs text-text-secondary">
                    {settings.hasApiKey
                      ? t("information.model_settings.key_configured")
                      : t("information.model_settings.key_missing")}
                  </span>
                )}
              </div>
              {settingsError && (
                <p role="alert" className="mt-4 text-sm text-red">
                  {t(`information.model_settings.error.${settingsError}` as never)}
                </p>
              )}
              <form
                className="mt-5 grid gap-4 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveSettings()
                }}
              >
                <label className="space-y-1.5 text-sm font-medium">
                  <span>{t("information.model_settings.provider")}</span>
                  <select
                    value={provider}
                    onChange={(event) =>
                      setProvider(event.target.value as InformationAISettings["provider"])
                    }
                    className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
                  >
                    <option value="qianwen">
                      {t("information.model_settings.provider_qianwen")}
                    </option>
                    <option value="codex">{t("information.model_settings.provider_codex")}</option>
                  </select>
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  <span>{t("information.model_settings.model")}</span>
                  <input
                    required
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
                  />
                </label>
                <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                  <span>{t("information.model_settings.api_key")}</span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={t("information.model_settings.api_key_placeholder")}
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
                  <p className="text-xs leading-5 text-text-secondary">
                    {t("information.model_settings.framework_notice")}
                  </p>
                  <button
                    type="submit"
                    disabled={savingSettings || !model.trim()}
                    className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50"
                  >
                    {savingSettings
                      ? t("information.model_settings.saving")
                      : t("information.model_settings.save")}
                  </button>
                </div>
              </form>
            </section>
            <section aria-label={t("information.overview")} className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-fill-secondary bg-material-thick p-5">
                <p className="text-xs text-text-secondary">{t("information.account")}</p>
                <p className="mt-2 font-semibold">
                  {snapshot.ownerId ? t("information.connected") : t("information.disconnected")}
                </p>
                <p className="mt-1 break-all text-xs text-text-secondary">
                  {snapshot.ownerId || t("information.connect_hint")}
                </p>
              </div>
              <div className="rounded-xl border border-fill-secondary bg-material-thick p-5">
                <p className="text-xs text-text-secondary">{t("information.sources")}</p>
                <p className="mt-2 text-2xl font-semibold">{snapshot.sources.length}</p>
              </div>
              <div className="rounded-xl border border-fill-secondary bg-material-thick p-5">
                <p className="text-xs text-text-secondary">{t("information.results")}</p>
                <p className="mt-2 text-2xl font-semibold">{snapshot.results.length}</p>
              </div>
            </section>

            <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <aside className="min-w-0 space-y-8">
                <section aria-labelledby="information-jobs" className="space-y-4">
                  <h2 id="information-jobs" className="text-lg font-semibold">
                    {t("information.jobs")}
                  </h2>
                  <dl className="grid grid-cols-2 gap-2">
                    {statuses.map((status) => (
                      <div key={status} className="rounded-lg bg-fill-quaternary p-3">
                        <dt className="text-xs text-text-secondary">
                          {t(`information.status.${status}`)}
                        </dt>
                        <dd className="mt-1 text-lg font-semibold">
                          {snapshot.jobs.filter((job) => job.status === status).length}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {snapshot.jobs.length === 0 ? (
                    <p className="text-sm text-text-secondary">{t("information.empty_jobs")}</p>
                  ) : (
                    <ul className="divide-y divide-fill-secondary">
                      {[...snapshot.jobs]
                        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                        .slice(0, 20)
                        .map((job) => (
                          <li key={job.id} className="space-y-2 py-3 text-xs">
                            <div className="flex justify-between gap-2">
                              <span className="font-medium">
                                {t(`information.kind.${job.kind}`)}
                              </span>
                              <span
                                className={
                                  job.status === "failed" ? "text-red" : "text-text-secondary"
                                }
                              >
                                {t(`information.status.${job.status}`)}
                              </span>
                            </div>
                            {job.sourceKey && (
                              <p className="break-words">
                                {sourceTitles.get(job.sourceKey) || job.sourceKey}
                              </p>
                            )}
                            {job.itemId && (
                              <p className="break-words text-text-secondary">
                                {items.get(job.itemId)?.title || job.itemId}
                              </p>
                            )}
                            {/* 区分任务执行状态与扫描范围，避免把成功误读为全历史已同步。 */}
                            {job.kind === "scan" && (job.pages !== undefined || job.coverage) && (
                              <p className="break-words leading-5 text-text-secondary">
                                {job.pages !== undefined &&
                                  t("information.scan_pages", { pages: job.pages })}
                                {job.pages !== undefined && job.coverage && " · "}
                                {job.coverage && t(`information.coverage.${job.coverage}`)}
                              </p>
                            )}
                            {job.error && <p className="break-words text-red">{job.error}</p>}
                            <time className="block text-text-secondary" dateTime={job.updatedAt}>
                              {formatDate(job.updatedAt)}
                            </time>
                          </li>
                        ))}
                    </ul>
                  )}
                  {snapshot.jobs.length > 20 && (
                    <p className="text-xs text-text-secondary">{t("information.recent_jobs")}</p>
                  )}
                </section>
                <section aria-labelledby="information-sources" className="space-y-4">
                  <h2 id="information-sources" className="text-lg font-semibold">
                    {t("information.sources")}
                  </h2>
                  {snapshot.sources.length === 0 ? (
                    <p className="text-sm text-text-secondary">{t("information.empty_sources")}</p>
                  ) : (
                    <ul className="divide-y divide-fill-secondary">
                      {snapshot.sources.map((source) => (
                        <li key={source.key} className="space-y-1 py-3">
                          <p className="break-words text-sm font-medium">{source.title}</p>
                          <p className="break-words text-xs text-text-secondary">
                            {t(`information.source_kind.${source.kind}` as never)}
                            {source.category ? ` · ${source.category}` : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </aside>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
