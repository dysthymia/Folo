import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { z } from "zod"

import { processingButtonClass } from "../action/processing-condition-editor"
import { buildProcessingRuleUrl } from "../action/processing-rule-link"
import { readingRequest } from "./processing-reader-client"

const explanationSchema = z
  .object({
    sourceId: z.string().nullable(),
    releaseVersion: z.number().int().positive().nullable(),
    globalInstructions: z.string().nullable(),
    pending: z.boolean(),
    rules: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          state: z.enum(["match", "no_match", "unknown"]),
        })
        .strict(),
    ),
    shadowed: z.array(
      z.object({ field: z.string(), ruleId: z.string(), winnerRuleId: z.string() }).strict(),
    ),
  })
  .strict()

export function ProcessingEntryExplanation({ inputSeq }: { inputSeq: number }) {
  const { t } = useTranslation("app")
  const [data, setData] = useState<z.infer<typeof explanationSchema> | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])
  const load = async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setFailed(false)
    try {
      const result = await readingRequest(
        `processing/entries/${inputSeq}/explanation`,
        explanationSchema,
        controller.signal,
      )
      if (!controller.signal.aborted) setData(result)
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="space-y-2 py-2">
      <button
        type="button"
        className={processingButtonClass}
        disabled={busy}
        onClick={() => void load()}
      >
        {t("processing.reader.show_rules")}
      </button>
      {failed && <p role="alert">{t("processing.reader.error.request")}</p>}
      {data && (
        <>
          <p>{t("processing.reader.applied_release", { version: data.releaseVersion ?? "—" })}</p>
          {data.pending && <p>{t("processing.reader.explanation_pending")}</p>}
          <p className="whitespace-pre-wrap">{data.globalInstructions}</p>
          <ul>
            {data.rules.map((rule) => (
              <li key={rule.id}>
                {rule.name} · {t(`processing.match.${rule.state}`)}
              </li>
            ))}
          </ul>
          {data.shadowed.map((item, index) => (
            <p key={index}>
              {t("processing.shadowed", {
                rule: data.rules.find((rule) => rule.id === item.ruleId)?.name,
                winner: data.rules.find((rule) => rule.id === item.winnerRuleId)?.name,
              })}{" "}
              · {item.field}
            </p>
          ))}
          {data.sourceId && (
            <a
              className="text-accent underline"
              href={buildProcessingRuleUrl({ kind: "source", sourceId: data.sourceId })}
            >
              {t("processing.reader.adjust_source_rules")}
            </a>
          )}
        </>
      )}
    </div>
  )
}
