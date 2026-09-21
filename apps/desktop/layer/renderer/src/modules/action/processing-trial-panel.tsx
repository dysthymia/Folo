import type { RuleSet } from "@follow/information-core"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getOneTimeToken } from "../ai-chat/local-provider"
import type { ProcessingTrialResult } from "./processing-client"
import { createProcessingClient } from "./processing-client"
import { processingButtonClass } from "./processing-condition-editor"

const client = createProcessingClient(getOneTimeToken)

export function ProcessingTrialPanel({
  config,
  sourceKey,
  entryId,
  valid,
}: {
  config: RuleSet
  sourceKey?: string
  entryId?: string
  valid: boolean
}) {
  const { t } = useTranslation("app")
  const [result, setResult] = useState<ProcessingTrialResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    // 样本或草稿变化即取消旧试运行，避免把不同条件的结果当作当前预览。
    controllerRef.current?.abort()
    setResult(null)
    setFailed(false)
    setBusy(false)
    return () => controllerRef.current?.abort()
  }, [config, sourceKey, entryId])
  const run = async () => {
    if (!sourceKey || !entryId || !valid) return
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setFailed(false)
    setResult(null)
    try {
      const output = await client.trial(config, sourceKey, entryId, controller.signal)
      if (!controller.signal.aborted) setResult(output)
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t("processing.trial_hint")}</p>
      <button
        type="button"
        className={processingButtonClass}
        disabled={!sourceKey || !entryId || !valid || busy}
        onClick={() => void run()}
      >
        {t(busy ? "processing.trial_running" : "processing.trial_run")}
      </button>
      {failed && (
        <p role="alert" className="text-sm text-red">
          {t("processing.trial_failed")}
        </p>
      )}
      {result && (
        <section
          aria-label={t("processing.trial_comparison")}
          className="space-y-4 text-sm"
          aria-live="polite"
        >
          <p>
            {t("processing.trial_model", {
              model: result.model,
              input: result.usage?.inputTokens ?? "—",
              output: result.usage?.outputTokens ?? "—",
            })}
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {(["before", "after"] as const).map((key) => {
              const item = result[key]
              return (
                <article
                  key={key}
                  className="space-y-2 rounded-lg border border-fill-secondary p-3"
                >
                  <h4 className="font-medium">
                    {t(key === "before" ? "processing.trial_before" : "processing.trial_after")}
                  </h4>
                  {item ? (
                    <>
                      <p className="font-medium">{item.title}</p>
                      <p className="whitespace-pre-wrap">{item.summary}</p>
                      <p>
                        {t(`processing.trial_status.${item.status}`)} · {item.reason}
                      </p>
                      <details>
                        <summary>
                          {t("processing.trial_citations", { count: item.facts.length })}
                        </summary>
                        <ol className="space-y-3 p-3">
                          {item.facts.map((fact, index) => (
                            <li key={index}>
                              <p>{fact.text}</p>
                              <blockquote className="border-l-2 border-fill-secondary pl-3 text-text-secondary">
                                {fact.quote}
                              </blockquote>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </>
                  ) : (
                    <p>{t("processing.trial_no_before")}</p>
                  )}
                </article>
              )
            })}
          </div>
          {result.aggregation.map((group) => (
            <div key={group.ruleId}>
              <h4 className="font-medium">
                {t("processing.trial_candidates", {
                  name: config.rules.find((rule) => rule.id === group.ruleId)?.name ?? group.ruleId,
                  count: group.count,
                })}
              </h4>
              <p className="text-text-secondary">{t("processing.trial_candidates_hint")}</p>
              <ul className="list-inside list-disc">
                {group.candidates.map((item) => (
                  <li key={item.inputSeq}>{item.title}</li>
                ))}
              </ul>
              {group.count > group.candidates.length && (
                <p>
                  {t("processing.trial_candidates_more", {
                    count: group.count - group.candidates.length,
                  })}
                </p>
              )}
            </div>
          ))}
          <details>
            <summary>{t("processing.trial_original")}</summary>
            <h4 className="font-medium">{result.original.title}</h4>
            <p className="whitespace-pre-wrap">{result.original.text}</p>
          </details>
        </section>
      )}
    </div>
  )
}
