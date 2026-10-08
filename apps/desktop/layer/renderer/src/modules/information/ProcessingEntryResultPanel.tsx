import { entryProcessingSignalsSchema } from "@follow/information-core"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { z } from "zod"

import { EntryEventsPanel } from "./EntryEventsPanel"
import { EntrySemanticPanel } from "./EntrySemanticPanel"
import { readingRequest } from "./processing-reader-client"
import { entrySemanticProfileSchema } from "./processing-semantic-client"
import { ProcessingSignals } from "./ProcessingSignals"

const resultSchema = z.object({
  entry: z.object({
    ...entryProcessingSignalsSchema.shape,
    seq: z.number().int().positive(),
    sourceKey: z.string(),
    itemId: z.string(),
    decisionId: z.string().nullable(),
    contentVersion: z.string(),
    decision: z
      .object({
        status: z.enum(["keep", "hide", "needs_context"]),
        title: z.string(),
        summary: z.string(),
        reason: z.string(),
        semanticProfile: entrySemanticProfileSchema.optional(),
      })
      .nullable(),
  }),
})

export function ProcessingEntryResultPanel({
  inputSeq,
  decisionId,
  sourceKey,
  itemId,
  contentVersion,
}: {
  inputSeq: number
  decisionId: string
  sourceKey: string
  itemId: string
  contentVersion: string
}) {
  const { t } = useTranslation("app")
  const [result, setResult] = useState<z.infer<typeof resultSchema>["entry"] | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    setState("loading")
    setResult(null)
    void readingRequest(`processing/entries/${inputSeq}`, resultSchema, controller.signal)
      .then(({ entry }) => {
        if (controller.signal.aborted) return
        // 索引与详情的决定必须一致；刷新期间不展示上一版摘要。
        if (
          entry.seq !== inputSeq ||
          entry.sourceKey !== sourceKey ||
          entry.itemId !== itemId ||
          entry.contentVersion !== contentVersion ||
          entry.decisionId !== decisionId ||
          (entry.decision?.semanticProfile &&
            entry.decision.semanticProfile.contentVersion !== contentVersion)
        ) {
          setState("error")
          return
        }
        setResult(entry)
        setState("ready")
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error")
      })
    return () => controller.abort()
  }, [inputSeq, decisionId, sourceKey, itemId, contentVersion])

  if (state === "loading") return <p>{t("processing.result.loading")}</p>
  if (state === "error" || !result?.decision)
    return <p role="alert">{t("processing.result.unavailable")}</p>

  return (
    <div className="space-y-3 text-sm">
      <p className="text-text-secondary">{t("processing.result.note")}</p>
      <ProcessingSignals signals={result} />
      <h3 className="font-medium">{result.decision.title}</h3>
      <p className="whitespace-pre-wrap">{result.decision.summary}</p>
      <EntryEventsPanel
        key={`${inputSeq}:${contentVersion}:${decisionId}`}
        inputSeq={inputSeq}
        contentVersion={contentVersion}
        decisionId={decisionId}
      />
      {result.decision.semanticProfile && (
        <EntrySemanticPanel
          key={`${inputSeq}:${contentVersion}`}
          profile={result.decision.semanticProfile}
          inputSeq={inputSeq}
          contentVersion={contentVersion}
        />
      )}
      <details>
        <summary className="cursor-pointer text-text-secondary">
          {t("processing.result.reason")}
        </summary>
        <p className="whitespace-pre-wrap">{result.decision.reason}</p>
      </details>
    </div>
  )
}
