import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { z } from "zod"

import { readingRequest } from "./processing-reader-client"

const count = z.number().nonnegative()
const distribution = z.object({ count, p50: count.nullable(), p95: count.nullable() }).strict()
const diagnosticsSchema = z
  .object({
    diagnostics: z
      .object({
        observedAt: z.iso.datetime(),
        scope: z
          .object({
            currentInputContexts: count,
            configuredInputContexts: count,
            completedContexts: count,
            uniqueCurrentItems: count,
          })
          .strict(),
        material: z
          .object({ complete: count, denominator: count, visibleCharacters: distribution })
          .strict(),
        backlog: z
          .object({
            contexts: count,
            oldestAgeSeconds: count.nullable(),
            bySource: z.array(
              z.object({ sourceKey: z.string(), contexts: count, pending: count }).strict(),
            ),
          })
          .strict(),
        decisions: z.object({ count, reused: count, durationMs: distribution }).strict(),
        modelCalls: z
          .object({
            ledgerAvailable: z.boolean(),
            observedFrom: z.iso.datetime().nullable(),
            calls: count,
            failedCalls: count,
            unknownUsageCalls: count,
            invalidRows: count,
            knownUsage: z
              .object({ inputTokens: count, outputTokens: count, cachedInputTokens: count })
              .strict(),
            completeUsage: z.boolean(),
            durationMs: z.record(z.string(), distribution),
          })
          .strict(),
        dailyCurrentContexts: z.array(
          z
            .object({ day: z.string(), currentContextsReceived: count, completedContexts: count })
            .strict(),
        ),
        capacityPerDay: z.null(),
        backlogRecoverySeconds: z.null(),
        semanticAcceptance: z.literal("awaiting_user_confirmed_samples"),
      })
      .strict(),
  })
  .strict()

export function ProcessingDiagnostics() {
  const { t } = useTranslation("app")
  const [data, setData] = useState<z.infer<typeof diagnosticsSchema>["diagnostics"] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    // 离开当前页面就清除诊断，重新查看必须重新验证账号。
    const clear = () => {
      request.current?.abort()
      setData(null)
      setLoading(false)
    }
    document.addEventListener("visibilitychange", clear)
    return () => {
      request.current?.abort()
      document.removeEventListener("visibilitychange", clear)
    }
  }, [])
  const refresh = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(false)
    setData(null)
    try {
      const result = await readingRequest("diagnostics", diagnosticsSchema, controller.signal)
      if (!controller.signal.aborted) setData(result.diagnostics)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  return (
    <section className="rounded-xl border border-fill-secondary p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">{t("information.diagnostics.title")}</h2>
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh()}
          className="text-accent disabled:opacity-50"
        >
          {t(loading ? "information.diagnostics.loading" : "information.diagnostics.refresh")}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-red">
          {t("information.diagnostics.error")}
        </p>
      )}
      {data && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-text-secondary">
            {t("information.diagnostics.scope", {
              completed: data.scope.completedContexts,
              total: data.scope.currentInputContexts,
              unique: data.scope.uniqueCurrentItems,
              configured: data.scope.configuredInputContexts,
            })}
          </p>
          <p>
            {t("information.diagnostics.material", {
              complete: data.material.complete,
              total: data.material.denominator,
            })}
          </p>
          <p>
            {t("information.diagnostics.backlog", {
              count: data.backlog.contexts,
              hours:
                data.backlog.oldestAgeSeconds === null
                  ? "—"
                  : (data.backlog.oldestAgeSeconds / 3600).toFixed(1),
            })}
          </p>
          <p>
            {t("information.diagnostics.calls", {
              count: data.modelCalls.calls,
              failed: data.modelCalls.failedCalls,
              unknown: data.modelCalls.unknownUsageCalls,
            })}
          </p>
          <p>
            {t("information.diagnostics.tokens", {
              input: data.modelCalls.knownUsage.inputTokens,
              output: data.modelCalls.knownUsage.outputTokens,
              cache: data.modelCalls.knownUsage.cachedInputTokens,
            })}
          </p>
          {!data.modelCalls.completeUsage && (
            <p className="text-text-secondary">{t("information.diagnostics.incomplete_usage")}</p>
          )}
          <p className="text-text-secondary">{t("information.diagnostics.unmeasured")}</p>
          <table className="w-full text-left">
            <caption className="mb-2 text-left text-text-secondary">
              {t("information.diagnostics.daily")}
            </caption>
            <thead>
              <tr>
                <th>{t("information.diagnostics.date")}</th>
                <th>{t("information.diagnostics.received")}</th>
                <th>{t("information.diagnostics.completed")}</th>
              </tr>
            </thead>
            <tbody>
              {data.dailyCurrentContexts.map((day) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td>{day.currentContextsReceived}</td>
                  <td>{day.completedContexts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
