import { useState } from "react"
import { useTranslation } from "react-i18next"

import type { ResearchPack, ResearchTarget } from "./research-client"
import {
  loadResearchPacks,
  prepareResearchPack,
  ResearchRequestError,
  transitionResearchPack,
} from "./research-client"

type ResearchPanelProps = { target: ResearchTarget; targetTitle: string }

const sameTarget = (left: ResearchTarget, right: ResearchTarget) => {
  if (left.kind !== right.kind) return false
  if (left.kind === "story" && right.kind === "story") return left.storyId === right.storyId
  if (left.kind === "entry" && right.kind === "entry") return left.inputSeq === right.inputSeq
  return false
}

const errorKey = (error: unknown) =>
  error instanceof ResearchRequestError ? error.kind : "request"

export function ResearchPanel({ target, targetTitle }: ResearchPanelProps) {
  const { t } = useTranslation("app")
  const translate = (key: string) => t(key as never)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pack, setPack] = useState<ResearchPack | null>(null)
  const [question, setQuestion] = useState("")
  const [goal, setGoal] = useState("")
  const [knownQuestions, setKnownQuestions] = useState("")
  const [reference, setReference] = useState("")

  const openPanel = async () => {
    setOpen(true)
    setError(null)
    setBusy(true)
    try {
      const result = await loadResearchPacks(new AbortController().signal)
      const existing = result.packs.find((candidate) => sameTarget(candidate.target, target))
      if (existing) {
        setPack(existing)
        setQuestion(existing.question)
        setGoal(existing.goal)
        setKnownQuestions(existing.knownQuestions.join("\n"))
      }
    } catch (cause) {
      setError(errorKey(cause))
    } finally {
      setBusy(false)
    }
  }

  const prepare = async () => {
    if (!question.trim() || !goal.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await prepareResearchPack(
        {
          target,
          question: question.trim(),
          goal: goal.trim(),
          knownQuestions: knownQuestions
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean),
        },
        new AbortController().signal,
      )
      setPack(result.pack)
      setReference("")
    } catch (cause) {
      setError(errorKey(cause))
    } finally {
      setBusy(false)
    }
  }

  const transition = async (status: "submitted" | "completed") => {
    if (!pack || !reference.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await transitionResearchPack(
        pack.id,
        { expectedRevision: pack.revision, status, reference: reference.trim() },
        new AbortController().signal,
      )
      setPack(result.pack)
      setReference("")
    } catch (cause) {
      setError(errorKey(cause))
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    if (!pack) return
    const url = URL.createObjectURL(
      new Blob([pack.markdown], { type: "text/markdown;charset=utf-8" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `folo-research-${pack.id}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="rounded-lg border border-fill px-3 py-1.5 text-sm"
        onClick={() => void openPanel()}
      >
        {t("information.research.open")}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("information.research.title")}
          className="space-y-3 rounded-lg border border-fill-secondary bg-fill p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-medium">{t("information.research.title")}</h4>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-text-secondary"
            >
              {t("information.research.close")}
            </button>
          </div>
          <p className="text-sm text-text-secondary">{targetTitle}</p>
          {error && (
            <p role="alert" className="text-sm text-red">
              {translate(`information.research.error.${error}`)}
            </p>
          )}
          <label className="block space-y-1 text-sm">
            <span>{t("information.research.question")}</span>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("information.research.goal")}</span>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("information.research.known_questions")}</span>
            <textarea
              value={knownQuestions}
              onChange={(event) => setKnownQuestions(event.target.value)}
              placeholder={t("information.research.known_questions_placeholder")}
              className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
            />
          </label>
          <button
            type="button"
            disabled={busy || !question.trim() || !goal.trim()}
            onClick={() => void prepare()}
            className="rounded-lg bg-blue px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {t("information.research.prepare")}
          </button>
          {pack && (
            <div className="space-y-3 border-t border-fill-secondary pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <strong>{pack.title}</strong>
                <span>{translate(`information.research.status.${pack.status}`)}</span>
              </div>
              <textarea
                readOnly
                value={pack.markdown}
                aria-label={t("information.research.markdown")}
                className="min-h-48 w-full rounded border border-fill-secondary bg-fill-secondary p-2 font-mono text-xs"
              />
              <button
                type="button"
                onClick={download}
                className="rounded-lg border border-fill px-3 py-1.5 text-sm"
              >
                {t("information.research.download")}
              </button>
              {pack.status !== "completed" && (
                <label className="block space-y-1 text-sm">
                  <span>
                    {t(
                      pack.status === "prepared"
                        ? "information.research.submission_reference"
                        : "information.research.result_reference",
                    )}
                  </span>
                  <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    className="w-full rounded border border-fill-secondary bg-fill-secondary p-2"
                  />
                </label>
              )}
              {pack.status === "prepared" && (
                <button
                  type="button"
                  disabled={busy || !reference.trim()}
                  onClick={() => void transition("submitted")}
                  className="rounded-lg bg-blue px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  {t("information.research.submit")}
                </button>
              )}
              {pack.status === "submitted" && (
                <button
                  type="button"
                  disabled={busy || !reference.trim()}
                  onClick={() => void transition("completed")}
                  className="rounded-lg bg-green px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  {t("information.research.complete")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
