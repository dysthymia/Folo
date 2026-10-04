import { useEntry } from "@follow/store/entry/hooks"
import { getSubscriptionByEntryId } from "@follow/store/subscription/getter"
import { useWhoami } from "@follow/store/user/hooks"
import { atom, useAtom } from "jotai"
import { nanoid } from "nanoid"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"

import { ReadingRequestError } from "./processing-reader-client"
import type { ResearchPack } from "./research-client"
import { loadResearchPacks } from "./research-client"
import type {
  ResearchSelectionEntry,
  ResearchSelectionPreview,
  ResearchSelectionRequest,
} from "./research-selection-client"
import {
  loadResearchSelection,
  previewResearchSelection,
  runResearchSelection,
} from "./research-selection-client"

type SelectedMaterial = ResearchSelectionEntry & { title: string }
const contextReasonKeys = {
  text: "information.selection.context_text",
  quote: "information.selection.context_quote",
  thread: "information.selection.context_thread",
  images: "information.selection.context_images",
  links: "information.selection.context_links",
  hydration_failed: "information.selection.context_hydration_failed",
  not_hydrated: "information.selection.context_not_hydrated",
} as const
// 选材只存当前账号的内存，切换原文仍保留；换账号立即停止显示旧材料。
const selectionAtom = atom<{ owner: string | null; entries: SelectedMaterial[] }>({
  owner: null,
  entries: [],
})

export function ResearchSelectionControls({ entryId }: { entryId: string }) {
  const owner = useWhoami()?.id ?? null
  const entry = useEntry(entryId, (value) => value)
  const [selection, setSelection] = useAtom(selectionAtom)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const entries = selection.owner === owner ? selection.entries : []
  const subscription = getSubscriptionByEntryId(entryId)
  const sourceKey = subscription?.listId
    ? `list/${subscription.listId}`
    : entry?.inboxHandle
      ? `inbox/${entry.inboxHandle}`
      : entry?.feedId
        ? `feed/${entry.feedId}`
        : null
  const selected = entries.some((material) => material.entryId === entryId)

  useEffect(() => {
    setOpen(false)
    setBusy(false)
    setSelection((previous) => (previous.owner === owner ? previous : { owner, entries: [] }))
  }, [owner, setSelection])
  const { t } = useTranslation("app")
  if (!owner || !isLocalFoloHost() || !entry || !sourceKey) return null
  return (
    <div className="mx-5 mb-3 space-y-3 text-sm" data-hide-in-print>
      <div className="flex flex-wrap items-center gap-3 text-text-secondary">
        <button
          type="button"
          disabled={busy || (!selected && entries.length >= 20)}
          aria-pressed={selected}
          onClick={() =>
            setSelection((previous) => {
              const current = previous.owner === owner ? previous.entries : []
              return {
                owner,
                entries: current.some((material) => material.entryId === entryId)
                  ? current.filter((material) => material.entryId !== entryId)
                  : [...current, { sourceKey, entryId, title: entry.title ?? entryId }],
              }
            })
          }
        >
          {t(selected ? "information.selection.remove" : "information.selection.add")}
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          {t(entries.length ? "information.selection.open" : "information.selection.history", {
            count: entries.length,
          })}
        </button>
      </div>
      {open && selection.owner === owner && (
        <ResearchSelectionPanel
          key={owner}
          owner={owner}
          entries={entries}
          onBusy={setBusy}
          onRemove={(id) =>
            setSelection((previous) =>
              previous.owner === owner
                ? {
                    ...previous,
                    entries: previous.entries.filter((material) => material.entryId !== id),
                  }
                : previous,
            )
          }
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** 显式预览后只处理所选材料，研究结果独立保存，不发布到日常 Story 流。 */
export function ResearchSelectionPanel({
  owner,
  entries,
  onRemove,
  onClose,
  onBusy,
}: {
  owner: string
  entries: SelectedMaterial[]
  onRemove: (entryId: string) => void
  onClose: () => void
  onBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation("app")
  const currentOwner = useWhoami()?.id ?? null
  const [question, setQuestion] = useState("")
  const [goal, setGoal] = useState("")
  const [preview, setPreview] = useState<ResearchSelectionPreview | null>(null)
  const [pack, setPack] = useState<ResearchPack | null>(null)
  const [history, setHistory] = useState<ResearchPack[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const keyRef = useRef<string | null>(null)
  const input: ResearchSelectionRequest = {
    target: {
      kind: "selection",
      entries: entries.map(({ sourceKey, entryId, inputSeq }) => ({
        sourceKey,
        entryId,
        inputSeq,
      })),
    },
    question: question.trim(),
    goal: goal.trim(),
    knownQuestions: [],
  }
  const signature = JSON.stringify(input)
  const currentRef = useRef({ owner: currentOwner, signature })
  currentRef.current = { owner: currentOwner, signature }
  const valid = useCallback(
    (controller: AbortController, captured: string) =>
      !controller.signal.aborted &&
      owner === currentRef.current.owner &&
      captured === currentRef.current.signature,
    [owner],
  )

  useEffect(() => {
    requestRef.current?.abort()
    keyRef.current = null
    setPreview(null)
    setPack(null)
    setFailed(false)
    setBusy(false)
    return () => requestRef.current?.abort()
  }, [owner, signature])
  useEffect(() => {
    onBusy(busy)
  }, [busy, onBusy])
  useEffect(() => () => onBusy(false), [onBusy])
  useEffect(() => {
    const controller = new AbortController()
    void loadResearchPacks(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted && owner === currentRef.current.owner)
          setHistory(response.packs.filter((item) => item.target.kind === "selection").slice(0, 20))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [owner])

  // 重复执行正在运行的幂等请求时会返回 running，保持同一个保存结果并按需读取。
  useEffect(() => {
    if (pack?.status !== "running") return
    const controller = new AbortController()
    const captured = signature
    const poll = async () => {
      try {
        const response = await loadResearchSelection(pack.id, controller.signal)
        if (valid(controller, captured)) setPack(response.pack)
      } catch {
        if (valid(controller, captured)) setFailed(true)
      }
    }
    const timer = setInterval(() => void poll(), 10_000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [owner, pack?.id, pack?.status, signature, valid])

  const execute = async (run: boolean) => {
    if (busy || !input.question || !input.goal || !entries.length || owner !== currentOwner) return
    if (run && !preview?.canExecute) return
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    const captured = signature
    setBusy(true)
    setFailed(false)
    try {
      if (run && preview) {
        // 请求传输失败仍复用同一key；模型明确失败后的主动重试才创建新一次执行。
        if (!keyRef.current || pack?.status === "failed") keyRef.current = nanoid()
        const response = await runResearchSelection(
          { ...input, selectionToken: preview.selectionToken, idempotencyKey: keyRef.current },
          controller.signal,
        )
        if (!valid(controller, captured)) return
        setPack(response.pack)
        setHistory((previous) =>
          [response.pack, ...previous.filter((item) => item.id !== response.pack.id)].slice(0, 20),
        )
      } else {
        const response = await previewResearchSelection(input, controller.signal)
        if (!valid(controller, captured)) return
        setPreview(response.preview)
        setPack(null)
        keyRef.current = null
      }
    } catch (cause) {
      if (valid(controller, captured)) {
        setFailed(true)
        if (cause instanceof ReadingRequestError && cause.kind === "conflict") setPreview(null)
      }
    } finally {
      if (valid(controller, captured)) setBusy(false)
    }
  }
  const download = () => {
    if (!pack || pack.status !== "completed") return
    const url = URL.createObjectURL(
      new Blob([pack.markdown], { type: "text/markdown;charset=utf-8" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `folo-research-${pack.id}.md`
    link.click()
    URL.revokeObjectURL(url)
  }
  if (owner !== currentOwner) return null
  return (
    <section
      role="dialog"
      aria-label={t("information.selection.title")}
      className="space-y-3 rounded-lg border border-fill-secondary bg-fill-quinary p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <strong>{t("information.selection.title")}</strong>
        <button type="button" onClick={onClose}>
          {t("information.research.close")}
        </button>
      </div>
      <p className="text-xs text-text-secondary">{t("information.selection.description")}</p>
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.entryId} className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate">{entry.title}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(entry.entryId)}
              aria-label={`${t("information.selection.remove")} ${entry.title}`}
            >
              {t("information.selection.remove")}
            </button>
          </li>
        ))}
      </ul>
      <label className="block space-y-1">
        <span>{t("information.research.question")}</span>
        <textarea
          disabled={busy}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          className="w-full rounded border border-fill-secondary bg-fill p-2"
        />
      </label>
      <label className="block space-y-1">
        <span>{t("information.research.goal")}</span>
        <textarea
          disabled={busy}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          className="w-full rounded border border-fill-secondary bg-fill p-2"
        />
      </label>
      {failed && (
        <p role="alert" className="text-red">
          {t("information.selection.request_failed")}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || !question.trim() || !goal.trim() || !entries.length}
          onClick={() => void execute(false)}
        >
          {t("information.selection.preview")}
        </button>
        <button
          type="button"
          disabled={
            busy ||
            !preview?.canExecute ||
            pack?.status === "running" ||
            pack?.status === "completed"
          }
          onClick={() => void execute(true)}
          className="rounded bg-blue px-3 py-1.5 text-white disabled:opacity-50"
        >
          {t(
            pack?.status === "failed" ? "information.selection.retry" : "information.selection.run",
          )}
        </button>
      </div>
      {preview && (
        <div className="space-y-2 text-xs text-text-secondary">
          <p>
            {t("information.selection.estimate", {
              count: preview.selectionCount,
              characters: preview.totalCharacters,
              calls: preview.estimatedModelCalls,
            })}
          </p>
          {preview.missingContext.length > 0 && (
            <p className="text-orange">
              {t("information.selection.missing", { count: preview.missingContext.length })}
            </p>
          )}
          {preview.missingContext.map((missing) => (
            <p key={`${missing.sourceKey}/${missing.entryId}`}>
              {entries.find((entry) => entry.entryId === missing.entryId)?.title ?? missing.entryId}
              {" · "}
              {/* 展示可补全的具体材料类型，未知服务字段也不用技术错误码代替说明。 */}
              {missing.reasons
                .map((reason) =>
                  t(
                    Object.hasOwn(contextReasonKeys, reason)
                      ? contextReasonKeys[reason as keyof typeof contextReasonKeys]
                      : "information.selection.context_unknown",
                  ),
                )
                .join(" · ")}
            </p>
          ))}
          {!preview.canExecute && preview.missingContext.length === 0 && (
            <p className="text-orange">{t("information.selection.limit")}</p>
          )}
        </div>
      )}
      {pack && (
        <div className="space-y-2 border-t border-fill-secondary pt-3">
          <p role="status">
            {t(
              `information.selection.status_${pack.status === "running" ? "running" : pack.status === "failed" ? "failed" : "completed"}`,
            )}
          </p>
          {pack.status === "failed" && (
            <p role="alert" className="text-red">
              {t("information.selection.model_failed")}
            </p>
          )}
          {pack.status === "completed" && (
            <>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
                {pack.markdown}
              </pre>
              <button type="button" onClick={download}>
                {t("information.research.download")}
              </button>
            </>
          )}
          {pack.metrics && (
            <p className="text-xs text-text-secondary">
              {t("information.selection.usage", {
                calls: pack.metrics.modelCalls,
                seconds: (pack.metrics.durationMs / 1000).toFixed(1),
                input: pack.metrics.usage?.inputTokens ?? "—",
                output: pack.metrics.usage?.outputTokens ?? "—",
              })}
            </p>
          )}
        </div>
      )}
      {history.length > 0 && (
        <details>
          <summary className="cursor-pointer">{t("information.selection.history")}</summary>
          <ul className="mt-2 space-y-2">
            {history.map((saved) => (
              <li key={saved.id}>
                <button type="button" disabled={busy} onClick={() => setPack(saved)}>
                  {saved.title}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
