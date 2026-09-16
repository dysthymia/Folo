import { useState } from "react"
import { useTranslation } from "react-i18next"

import type { FeedbackKind, NewFeedback } from "./processing-feedback-client"
import { FeedbackRequestError, saveProcessingFeedback } from "./processing-feedback-client"

type ProcessingFeedbackPanelProps = {
  target: NewFeedback["target"]
  referenceIds?: string[]
}

const feedbackKinds: FeedbackKind[] = [
  "should_keep",
  "wrong_merge",
  "should_merge",
  "missing_point",
  "unsupported_citation",
  "rule_exception",
  "value",
  "known",
  "irrelevant",
]

export function ProcessingFeedbackPanel({
  target,
  referenceIds = [],
}: ProcessingFeedbackPanelProps) {
  const { t } = useTranslation("app")
  const translate = (key: string) => t(key as never)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<FeedbackKind>("should_keep")
  const [explanation, setExplanation] = useState("")
  const [suggestion, setSuggestion] = useState("")
  const [references, setReferences] = useState(referenceIds.join("\n"))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    const input: NewFeedback = {
      kind,
      target,
      ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
      ...(suggestion.trim() ? { suggestion: suggestion.trim() } : {}),
      ...(target.kind === "story"
        ? {
            referenceIds: references
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
          }
        : {}),
    }
    try {
      await saveProcessingFeedback(input, new AbortController().signal)
      setSaved(true)
      setExplanation("")
      setSuggestion("")
      if (target.kind === "story") setReferences(referenceIds.join("\n"))
    } catch (cause) {
      // 400/409 都可能意味着 snapshot 已过期；保留全部输入，要求用户刷新后重新判断。
      setError(cause instanceof FeedbackRequestError ? cause.kind : "request")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="rounded-lg border border-fill px-3 py-1.5 text-sm"
        onClick={() => {
          setOpen(true)
          setError(null)
          setSaved(false)
        }}
      >
        {t("information.feedback.open")}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("information.feedback.title")}
          className="space-y-3 rounded-lg border border-fill-secondary bg-fill p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-medium">{t("information.feedback.title")}</h4>
            <button
              type="button"
              className="text-sm text-text-secondary"
              onClick={() => setOpen(false)}
            >
              {t("information.feedback.close")}
            </button>
          </div>
          <p className="text-sm text-text-secondary">
            {target.kind === "entry"
              ? t("information.feedback.entry_anchor", { inputSeq: target.inputSeq })
              : t("information.feedback.story_anchor", { revision: target.storyRevision })}
          </p>
          <label className="block space-y-1 text-sm">
            <span>{t("information.feedback.kind_label")}</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as FeedbackKind)}
              className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
            >
              {feedbackKinds.map((value) => (
                <option key={value} value={value}>
                  {translate(`information.feedback.kind.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("information.feedback.explanation")}</span>
            <textarea
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
            />
          </label>
          {target.kind === "story" && (
            <label className="block space-y-1 text-sm">
              <span>{t("information.feedback.references")}</span>
              <textarea
                value={references}
                onChange={(event) => setReferences(event.target.value)}
                placeholder={t("information.feedback.references_placeholder")}
                className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
              />
            </label>
          )}
          <label className="block space-y-1 text-sm">
            <span>{t("information.feedback.suggestion")}</span>
            <textarea
              value={suggestion}
              onChange={(event) => setSuggestion(event.target.value)}
              className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
            />
          </label>
          <p className="text-xs text-text-secondary">{t("information.feedback.review_only")}</p>
          {error && (
            <p role="alert" className="text-sm text-red">
              {translate(`information.feedback.error.${error}`)}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-green">
              {t("information.feedback.saved")}
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-lg bg-blue px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {busy ? t("information.feedback.saving") : t("information.feedback.save")}
          </button>
        </div>
      )}
    </div>
  )
}
