import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { XQuery, XQueryInput, XSettings } from "./x-search-client"
import {
  createXQuery,
  deleteXQuery,
  loadX,
  saveXSettings,
  syncX,
  updateXQuery,
  XRequestError,
} from "./x-search-client"

type Operation = "delete" | "load" | "query" | "settings" | "sync" | null

const emptySettings: XSettings = {
  enabled: false,
  configured: false,
  access: "recent_search",
  billingNotice: "",
}

const emptyQuery: XQueryInput = {
  query: "",
  title: "",
  view: 0,
  category: null,
  enabled: true,
}

const errorKind = (cause: unknown) => (cause instanceof XRequestError ? cause.kind : "request")

export function XSearchPanel() {
  const { t, i18n } = useTranslation("app")
  const translate = (key: string, options?: Record<string, unknown>) => t(key as never, options)
  const [settings, setSettings] = useState<XSettings>(emptySettings)
  const [enabled, setEnabled] = useState(false)
  const [access, setAccess] = useState<XSettings["access"]>("recent_search")
  const [bearerToken, setBearerToken] = useState("")
  const [queries, setQueries] = useState<XQuery[]>([])
  const [draft, setDraft] = useState<XQueryInput>(emptyQuery)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [operation, setOperation] = useState<Operation>("load")
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)

  const clearAccountData = useCallback(() => {
    setSettings(emptySettings)
    setEnabled(false)
    setAccess("recent_search")
    setBearerToken("")
    setQueries([])
    setDraft(emptyQuery)
    setEditingId(null)
    setError(null)
  }, [])

  const startRequest = useCallback((nextOperation: Exclude<Operation, null>) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setOperation(nextOperation)
    setError(null)
    return controller
  }, [])

  const refresh = useCallback(async () => {
    const controller = startRequest("load")
    clearAccountData()
    try {
      const [nextSettings, data] = await loadX(controller.signal)
      if (controller.signal.aborted) return
      setSettings(nextSettings)
      setEnabled(nextSettings.enabled)
      setAccess(nextSettings.access)
      setQueries(data.queries)
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorKind(cause))
    } finally {
      if (!controller.signal.aborted) setOperation(null)
    }
  }, [clearAccountData, startRequest])

  useEffect(() => {
    void refresh()
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh()
      else {
        requestRef.current?.abort()
        clearAccountData()
        setOperation(null)
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      requestRef.current?.abort()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [clearAccountData, refresh])

  const saveSettings = async () => {
    const controller = startRequest("settings")
    try {
      const token = bearerToken.trim()
      const next = await saveXSettings(
        { enabled, access, ...(token ? { bearerToken: token } : {}) },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setSettings(next)
      setEnabled(next.enabled)
      setAccess(next.access)
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorKind(cause))
    } finally {
      // 私有凭据只在输入和提交期间保留，成功、失败或取消后都不回显。
      setBearerToken("")
      if (!controller.signal.aborted) setOperation(null)
    }
  }

  const resetDraft = () => {
    setDraft(emptyQuery)
    setEditingId(null)
  }

  const saveQuery = async () => {
    const query = draft.query.trim()
    const title = draft.title.trim()
    const category = draft.category?.trim() || null
    if (!query || !title || !Number.isInteger(draft.view) || draft.view < 0) return
    const controller = startRequest("query")
    const value = { ...draft, query, title, category }
    try {
      if (editingId) await updateXQuery(editingId, value, controller.signal)
      else await createXQuery(value, controller.signal)
      if (controller.signal.aborted) return
      resetDraft()
      await refresh()
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorKind(cause))
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) setOperation(null)
    }
  }

  const removeQuery = async (id: string) => {
    const controller = startRequest("delete")
    try {
      await deleteXQuery(id, controller.signal)
      if (controller.signal.aborted) return
      if (editingId === id) resetDraft()
      await refresh()
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorKind(cause))
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) setOperation(null)
    }
  }

  const synchronize = async () => {
    if (!settings.enabled || !settings.configured || settings.access === "full_archive") return
    const controller = startRequest("sync")
    try {
      await syncX(controller.signal)
      if (controller.signal.aborted) return
      await refresh()
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorKind(cause))
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) setOperation(null)
    }
  }

  const busy = operation !== null
  const syncDisabled =
    busy || !settings.enabled || !settings.configured || settings.access === "full_archive"
  const syncReason = !settings.enabled
    ? "disabled"
    : !settings.configured
      ? "unconfigured"
      : settings.access === "full_archive"
        ? "full_archive_unsupported"
        : null

  return (
    <section
      aria-labelledby="information-x-title"
      className="space-y-5 rounded-xl border border-fill-secondary bg-material-thick p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="information-x-title" className="text-lg font-semibold">
            {t("information.x.title")}
          </h2>
          <p className="text-sm leading-6 text-text-secondary">{t("information.x.description")}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded-lg border border-fill px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {operation === "load" ? t("information.x.loading") : t("information.x.refresh")}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red">
          {translate(`information.x.error.${error}`)}
        </p>
      )}
      {operation && (
        <p role="status" className="text-sm text-text-secondary">
          {t("information.x.request_in_progress")}
        </p>
      )}

      <form
        className="grid gap-4 rounded-lg border border-fill-secondary p-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void saveSettings()
        }}
      >
        <h3 className="font-medium sm:col-span-2">{t("information.x.settings")}</h3>
        <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2">
          <input
            name="x-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t("information.x.enabled")}
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>{t("information.x.bearer_token")}</span>
          <input
            name="x-bearer-token"
            type="password"
            value={bearerToken}
            onChange={(event) => setBearerToken(event.target.value)}
            placeholder={t("information.x.bearer_token_placeholder")}
            autoComplete="new-password"
            className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
          />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>{t("information.x.access_label")}</span>
          <select
            name="x-access"
            value={access}
            onChange={(event) => setAccess(event.target.value as XSettings["access"])}
            className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
          >
            <option value="recent_search">{t("information.x.access.recent_search")}</option>
            <option value="full_archive">{t("information.x.access.full_archive")}</option>
          </select>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
          <p className="text-xs text-text-secondary">
            {settings.configured ? t("information.x.configured") : t("information.x.unconfigured")}
          </p>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {operation === "settings" ? t("information.x.saving") : t("information.x.save")}
          </button>
        </div>
        {settings.billingNotice && (
          <p className="text-xs leading-5 text-text-secondary sm:col-span-2">
            {settings.billingNotice}
          </p>
        )}
      </form>

      <form
        className="grid gap-4 rounded-lg border border-fill-secondary p-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void saveQuery()
        }}
      >
        <h3 className="font-medium sm:col-span-2">
          {t(editingId ? "information.x.query.edit_title" : "information.x.query.create_title")}
        </h3>
        <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
          <span>{t("information.x.query.expression")}</span>
          <input
            name="x-query"
            value={draft.query}
            maxLength={512}
            onChange={(event) => setDraft((value) => ({ ...value, query: event.target.value }))}
            className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
          />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>{t("information.x.query.title")}</span>
          <input
            name="x-query-title"
            value={draft.title}
            maxLength={120}
            onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))}
            className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
          />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>{t("information.x.query.view")}</span>
          <input
            name="x-query-view"
            type="number"
            min={0}
            step={1}
            value={draft.view}
            onChange={(event) =>
              setDraft((value) => ({ ...value, view: Number(event.target.value) }))
            }
            className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
          />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>{t("information.x.query.category")}</span>
          <input
            name="x-query-category"
            value={draft.category ?? ""}
            maxLength={120}
            onChange={(event) =>
              setDraft((value) => ({ ...value, category: event.target.value || null }))
            }
            placeholder={t("information.x.query.category_optional")}
            className="w-full rounded-lg border border-fill bg-fill-secondary px-3 py-2 text-text"
          />
        </label>
        <label className="flex items-center gap-2 self-end py-2 text-sm font-medium">
          <input
            name="x-query-enabled"
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.checked }))}
          />
          {t("information.x.query.enabled")}
        </label>
        <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
          {editingId && (
            <button
              type="button"
              disabled={busy}
              onClick={resetDraft}
              className="rounded-lg border border-fill px-4 py-2 text-sm disabled:opacity-50"
            >
              {t("information.x.query.cancel")}
            </button>
          )}
          <button
            type="submit"
            disabled={
              busy ||
              !draft.query.trim() ||
              !draft.title.trim() ||
              !Number.isInteger(draft.view) ||
              draft.view < 0
            }
            className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {operation === "query"
              ? t("information.x.query.saving")
              : t(editingId ? "information.x.query.update" : "information.x.query.create")}
          </button>
        </div>
      </form>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-medium">{t("information.x.saved_queries")}</h3>
            {syncReason && (
              <p className="mt-1 text-xs text-text-secondary">
                {translate(`information.x.sync_disabled.${syncReason}`)}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={syncDisabled}
            onClick={() => void synchronize()}
            className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {operation === "sync" ? t("information.x.syncing") : t("information.x.sync")}
          </button>
        </div>

        {!operation && queries.length === 0 && (
          <p className="rounded-lg border border-fill-secondary p-4 text-sm text-text-secondary">
            {t("information.x.no_queries")}
          </p>
        )}
        {queries.map((item) => (
          <article key={item.id} className="space-y-2 rounded-lg border border-fill-secondary p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="font-medium">{item.title}</h4>
                <code className="mt-1 block break-all text-xs text-text-secondary">
                  {item.query}
                </code>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(item.id)
                    setDraft({
                      query: item.query,
                      title: item.title,
                      view: item.view,
                      category: item.category,
                      enabled: item.enabled,
                    })
                  }}
                  className="rounded border border-fill px-2 py-1 text-xs disabled:opacity-50"
                >
                  {t("information.x.query.edit")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeQuery(item.id)}
                  className="rounded border border-red/40 px-2 py-1 text-xs text-red disabled:opacity-50"
                >
                  {t("information.x.query.delete")}
                </button>
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
              <div>
                <dt className="inline">{t("information.x.query.view")}: </dt>
                <dd className="inline">{item.view}</dd>
              </div>
              <div>
                <dt className="inline">{t("information.x.query.category")}: </dt>
                <dd className="inline">{item.category ?? t("information.x.query.no_category")}</dd>
              </div>
              <div>
                <dt className="inline">{t("information.x.query.status")}: </dt>
                <dd className="inline">
                  {translate(`information.x.status.${item.state.status}`)}
                  {item.state.pending ? ` · ${t("information.x.pagination_pending")}` : ""}
                </dd>
              </div>
            </dl>
            {item.state.failure && (
              <p role="alert" className="text-xs text-red">
                {t("information.x.failure", { reason: item.state.failure })}
              </p>
            )}
            {item.state.retryAt && (
              <p className="text-xs text-orange">
                {t("information.x.retry_at", {
                  time: new Date(item.state.retryAt).toLocaleString(i18n.language),
                })}
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
