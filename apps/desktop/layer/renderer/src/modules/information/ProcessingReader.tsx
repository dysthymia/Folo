import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { ZodType } from "zod"

import { processingButtonClass } from "../action/processing-condition-editor"
import { InformationIntegration } from "./InformationIntegration"
import type {
  ReadingEntryOverride,
  ReadingRequestError,
  ReadingSnapshotItem,
  ReadingStory,
  ReadingView,
} from "./processing-reader-client"
import {
  loadEntryOverrides,
  loadReadingSnapshot,
  loadReadingSnapshotPage,
  loadResearchPack,
  mutationSchemas,
  readingEntryPresentation,
  readingPendingMessageKey,
  readingRequest,
  ReadingRequestError as RequestError,
  readingStorySchema,
  refreshReadingSnapshot,
} from "./processing-reader-client"
import { ProcessingEntryExplanation } from "./ProcessingEntryExplanation"
import { ProcessingFeedbackPanel } from "./ProcessingFeedbackPanel"
import { ProcessingReadingModeSwitch } from "./ProcessingReadingModeSwitch"
import { ResearchPanel } from "./ResearchPanel"

type ReaderItem = ReadingSnapshotItem & {
  // 当前快照暂未返回纠偏版本，以下字段只用于提交 expectedRevision，不覆盖快照决定。
  override?: ReadingEntryOverride["override"]
  metadata?: ReadingEntryOverride["metadata"]
  review?: Pick<ReadingEntryOverride, "decision" | "reviewNeeded" | "issueCount">
}
type ReadingStatus = Omit<Awaited<ReturnType<typeof loadReadingSnapshot>>, "snapshot">
const pageLimit = 50

function formatStatusInstant(value: string, timeZone: string | null) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value))
}

function originalEntryUrl(sourceKey: string, itemId: string) {
  // X 的条目 ID 本身就是稳定状态 ID，直接生成 canonical 地址，避免伪造 Folo 时间线链接。
  if (
    sourceKey === "x" ||
    sourceKey.startsWith("x:") ||
    sourceKey.startsWith("x_search:") ||
    sourceKey.startsWith("x/search/")
  )
    return `https://x.com/i/status/${encodeURIComponent(itemId)}`
  return `/timeline/view-0/all/${encodeURIComponent(itemId)}`
}

export function ProcessingReader() {
  const { t } = useTranslation("app")
  const [snapshot, setSnapshot] = useState<
    Awaited<ReturnType<typeof loadReadingSnapshot>>["snapshot"] | null
  >(null)
  const [readingStatus, setReadingStatus] = useState<ReadingStatus | null>(null)
  const [items, setItems] = useState<ReaderItem[]>([])
  const [view, setView] = useState<ReadingView>("smart")
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<ReadingStory | null>(null)
  const [selectedSnapshotRevision, setSelectedSnapshotRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReadingRequestError["kind"] | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  const [selectedStoryIds, setSelectedStoryIds] = useState<string[]>([])
  const [splitAssignments, setSplitAssignments] = useState<Record<number, number>>({})
  const [withdrawSeq, setWithdrawSeq] = useState<number | null>(null)
  const [withdrawReason, setWithdrawReason] = useState("")
  const controllerRef = useRef<AbortController | null>(null)
  const snapshotRef = useRef<Awaited<ReturnType<typeof loadReadingSnapshot>>["snapshot"] | null>(
    null,
  )
  const viewRef = useRef<ReadingView>(view)

  const fail = useCallback((cause: unknown) => {
    setError(cause instanceof RequestError ? cause.kind : "request")
  }, [])

  const load = useCallback(
    async (mode: "initial" | "refresh" | "page", nextView: ReadingView, nextOffset: number) => {
      controllerRef.current?.abort()
      const request = new AbortController()
      controllerRef.current = request
      setBusy(true)
      setError(null)
      try {
        const snapshotResponse =
          mode === "refresh"
            ? await refreshReadingSnapshot(request.signal)
            : mode === "initial"
              ? await loadReadingSnapshot(request.signal)
              : snapshotRef.current
                ? { snapshot: snapshotRef.current }
                : await loadReadingSnapshot(request.signal)
        const page = await loadReadingSnapshotPage(
          snapshotResponse.snapshot.id,
          nextView,
          nextOffset,
          request.signal,
        )
        const overrides = await loadEntryOverrides(request.signal)
        if (request.signal.aborted) return
        snapshotRef.current = page.snapshot
        if ("counts" in snapshotResponse) {
          const { counts, processing, schedule } = snapshotResponse
          setReadingStatus({ counts, processing, schedule })
        }
        viewRef.current = page.view
        setSnapshot(page.snapshot)
        setView(page.view)
        setOffset(page.offset)
        setTotal(page.total)
        setItems(
          page.items.map((item) => {
            if (item.kind !== "entry" || item.state === "repairing") return item
            const current = overrides.get(item.inputSeq)
            return {
              ...item,
              override: current?.override,
              metadata: current?.metadata,
              review: current,
            }
          }),
        )
        setSelected(null)
        setSelectedSnapshotRevision(null)
        setSelectedStoryIds([])
      } catch (cause) {
        if (!request.signal.aborted) fail(cause)
      } finally {
        if (!request.signal.aborted) setBusy(false)
      }
    },
    [fail],
  )

  useEffect(() => {
    void load("initial", "smart", 0)
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        controllerRef.current?.abort()
        setItems([])
        setSelected(null)
        setSelectedSnapshotRevision(null)
        setSnapshot(null)
        setReadingStatus(null)
        snapshotRef.current = null
      } else {
        // 回到页面只读取当前固定快照，不自动吸收后台新结果。
        void load("initial", viewRef.current, 0)
      }
    }
    document.addEventListener("visibilitychange", visibility)
    return () => {
      controllerRef.current?.abort()
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [load])

  const mutate = async (
    path: string,
    schema: ZodType<unknown>,
    body: object,
    refreshAfter = true,
  ) => {
    controllerRef.current?.abort()
    const request = new AbortController()
    controllerRef.current = request
    setBusy(true)
    setError(null)
    try {
      const result = await readingRequest(path, schema, request.signal, body)
      if (
        typeof result === "object" &&
        result !== null &&
        "id" in result &&
        typeof result.id === "string"
      )
        setUndo(result.id)
      if (refreshAfter) await load("refresh", view, 0)
    } catch (cause) {
      if (!request.signal.aborted) fail(cause)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }

  const openStory = async (id: string, snapshotRevision?: number) => {
    controllerRef.current?.abort()
    const request = new AbortController()
    controllerRef.current = request
    setBusy(true)
    setError(null)
    try {
      const story = await readingRequest(
        `stories/${encodeURIComponent(id)}`,
        readingStorySchema,
        request.signal,
      )
      setSelected(story)
      setSelectedSnapshotRevision(snapshotRevision ?? null)
      if (story.kind === "current")
        setSplitAssignments(
          Object.fromEntries(story.revision.members.map((member) => [member.inputSeq, 0])),
        )
    } catch (cause) {
      if (!request.signal.aborted) fail(cause)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }

  const mergeSelectedStories = () => {
    const stories = items.filter(
      (item): item is Extract<ReaderItem, { kind: "story"; state: "ready" }> =>
        item.kind === "story" && item.state === "ready" && selectedStoryIds.includes(item.story.id),
    )
    if (stories.length !== 2) return
    const [keep, merged] = stories
    if (
      keep!.story.aggregationRuleId !== merged!.story.aggregationRuleId ||
      keep!.story.aggregationScopeVersion !== merged!.story.aggregationScopeVersion
    )
      return
    setSelectedStoryIds([])
    void mutate("stories/merge", mutationSchemas.merge, {
      keepStoryId: keep!.story.id,
      mergeStoryId: merged!.story.id,
      expectedKeepRevision: keep!.story.currentRevision,
      expectedMergedRevision: merged!.story.currentRevision,
    })
  }

  const splitSelectedStory = () => {
    if (selected?.kind !== "current") return
    const groups = [1, 2].map((group) =>
      selected.revision.members
        .map((member) => member.inputSeq)
        .filter((inputSeq) => splitAssignments[inputSeq] === group),
    )
    if (groups.some((group) => group.length < 2)) return
    void mutate(`stories/${selected.story.id}/split`, mutationSchemas.split, {
      expectedRevision: selected.revision.revision,
      groups,
    })
  }

  const withdrawMaterial = () => {
    if (withdrawSeq === null || !withdrawReason.trim()) return
    const seq = withdrawSeq
    setWithdrawSeq(null)
    setWithdrawReason("")
    void mutate(`materials/${seq}/withdraw`, mutationSchemas.withdraw, { reason: withdrawReason })
  }

  const exportStory = async () => {
    if (selected?.kind !== "current") return
    controllerRef.current?.abort()
    const request = new AbortController()
    controllerRef.current = request
    try {
      const pack = await loadResearchPack(selected.story.id, request.signal)
      if (pack.status !== "ready") return
      const url = URL.createObjectURL(
        new Blob([pack.markdown], { type: "text/markdown;charset=utf-8" }),
      )
      const link = document.createElement("a")
      link.href = url
      link.download = `folo-story-${pack.storyId}-v${pack.revision}.md`
      link.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      if (!request.signal.aborted) fail(cause)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageLimit))
  const currentPage = Math.floor(offset / pageLimit)
  const selectedStories = items.filter(
    (item): item is Extract<ReaderItem, { kind: "story"; state: "ready" }> =>
      item.kind === "story" && item.state === "ready" && selectedStoryIds.includes(item.story.id),
  )
  const canMerge =
    selectedStories.length === 2 &&
    selectedStories[0]!.story.aggregationRuleId === selectedStories[1]!.story.aggregationRuleId &&
    selectedStories[0]!.story.aggregationScopeVersion ===
      selectedStories[1]!.story.aggregationScopeVersion
  const splitGroups = [1, 2].map((group) =>
    selected?.kind === "current"
      ? selected.revision.members.filter((member) => splitAssignments[member.inputSeq] === group)
      : [],
  )
  const canSplit = splitGroups.every((group) => group.length >= 2)
  const changeView = (nextView: ReadingView) => void load("page", nextView, 0)
  const renderEntry = (
    item:
      | Extract<ReaderItem, { kind: "entry"; state: "ready" }>
      | Extract<ReaderItem, { kind: "entry"; state: "pending" }>,
  ) => {
    const override = item.override
    const presentation =
      item.state === "ready" ? readingEntryPresentation(item, item.review ?? null) : null
    const pendingMessageKey =
      item.state === "pending" ? readingPendingMessageKey(item.status) : null
    return (
      <article className="space-y-2 rounded-xl bg-fill-quaternary p-4" key={item.ordinal}>
        <a
          className="font-medium text-accent"
          href={originalEntryUrl(item.sourceKey, item.itemId)}
          target="_blank"
          rel="noreferrer"
        >
          {presentation?.title ?? item.title}
        </a>
        <p className="whitespace-pre-wrap text-sm">
          {presentation
            ? presentation.summaryKey
              ? t(presentation.summaryKey)
              : presentation.summary
            : pendingMessageKey
              ? t(pendingMessageKey)
              : null}
        </p>
        <details className="text-sm">
          <summary>{t("processing.reader.explain")}</summary>
          <p>{item.state === "ready" ? item.decision.reason : item.status}</p>
          {presentation?.aiSummary && (
            <>
              <p>{t("processing.reader.review_ai_summary")}</p>
              <p className="whitespace-pre-wrap">{presentation.aiSummary}</p>
              <p>{t("processing.reader.review_issue_count", { count: presentation.issueCount })}</p>
            </>
          )}
          <p>{item.sourceKey}</p>
          <p>
            {t("processing.reader.snapshot_cutoff")}: {item.audit.cutoffAt}
          </p>
          {item.metadata && <p>{JSON.stringify(item.metadata)}</p>}
          {item.state === "ready" && <p>{item.decision.reason}</p>}
          <ProcessingEntryExplanation inputSeq={item.inputSeq} />
        </details>
        {override && (
          <div className="flex flex-wrap gap-2">
            {(["restore", "hide", "automatic"] as const).map((mode) => (
              <button
                className={processingButtonClass}
                disabled={busy || mode === override.mode}
                key={mode}
                type="button"
                onClick={() =>
                  void mutate(
                    `processing/entries/${item.inputSeq}/override`,
                    mutationSchemas.override,
                    {
                      mode,
                      expectedRevision: override.revision,
                    },
                  )
                }
              >
                {t(`processing.reader.override.${mode}`)}
              </button>
            ))}
            {override.revision > 0 && (
              <button
                type="button"
                disabled={busy}
                className={processingButtonClass}
                onClick={() =>
                  void mutate(
                    `processing/entries/${item.inputSeq}/undo`,
                    mutationSchemas.override,
                    {
                      expectedRevision: override.revision,
                    },
                  )
                }
              >
                {t("processing.reader.undo")}
              </button>
            )}
            {item.state === "pending" && item.status === "failed" && (
              <button
                type="button"
                disabled={busy}
                className={processingButtonClass}
                onClick={() =>
                  void mutate(
                    `processing/entries/${item.inputSeq}/retry`,
                    mutationSchemas.retry,
                    {},
                  )
                }
              >
                {t("processing.reader.retry")}
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className={processingButtonClass}
          disabled={busy}
          onClick={() => {
            setWithdrawSeq(item.inputSeq)
            setWithdrawReason("")
          }}
        >
          {t("processing.reader.withdraw")}
        </button>
        <ResearchPanel
          target={{ kind: "entry", inputSeq: item.inputSeq }}
          targetTitle={item.title}
        />
        <ProcessingFeedbackPanel
          target={{
            kind: "entry",
            inputSeq: item.inputSeq,
            expectedDecisionId: item.state === "ready" ? item.decision.id : null,
          }}
        />
        {withdrawSeq === item.inputSeq && (
          <div className="space-y-2 rounded-lg border border-orange p-3">
            <p className="text-sm text-orange">{t("processing.reader.withdraw_preview")}</p>
            <textarea
              className="w-full rounded border border-fill-secondary bg-fill p-2 text-sm"
              value={withdrawReason}
              aria-label={t("processing.reader.withdraw_reason")}
              onChange={(event) => setWithdrawReason(event.target.value)}
            />
            <button
              type="button"
              className={processingButtonClass}
              disabled={!withdrawReason.trim() || busy}
              onClick={withdrawMaterial}
            >
              {t("processing.reader.withdraw_confirm")}
            </button>
          </div>
        )}
      </article>
    )
  }

  return (
    <section
      id="smart-reading"
      className="space-y-4 rounded-2xl border border-fill-secondary p-5"
      aria-label={t("processing.reader.title")}
    >
      <ProcessingReadingModeSwitch mode="smart" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("processing.reader.title")}</h2>
          <p className="text-sm text-text-secondary">
            {t("processing.reader.snapshot")}
            {snapshot ? ` · ${snapshot.createdAt}` : ""}
            {snapshot?.latestAvailable ? ` · ${t("processing.reader.snapshot_latest")}` : ""}
          </p>
        </div>
        <button
          type="button"
          className={processingButtonClass}
          disabled={busy}
          onClick={() => void load("refresh", view, 0)}
        >
          {t("processing.reader.refresh")}
        </button>
      </div>
      {readingStatus?.counts && (
        <div
          className="flex flex-wrap gap-2 text-sm"
          aria-label={t("processing.reader.status.counts")}
        >
          {(["standalone", "stories", "hidden", "pending", "failed"] as const).map((key) => (
            <span key={key} className="rounded-full bg-fill px-3 py-1 text-text-secondary">
              {t(`processing.reader.status.count.${key}`)} {readingStatus.counts?.[key]}
            </span>
          ))}
        </div>
      )}
      {(readingStatus?.processing || readingStatus?.schedule) && (
        <div className="grid gap-2 text-sm text-text-secondary sm:grid-cols-2">
          {readingStatus.processing && (
            <div className="rounded-lg border border-fill-secondary p-3">
              <p className="font-medium text-text">{t("processing.reader.status.sources")}</p>
              <p>
                {readingStatus.processing.incompleteSources === null
                  ? t("processing.reader.status.sources_unknown", {
                      total: readingStatus.processing.sourceTotal,
                    })
                  : t("processing.reader.status.sources_incomplete", {
                      incomplete: readingStatus.processing.incompleteSources,
                      total: readingStatus.processing.sourceTotal,
                    })}
              </p>
              <p>
                {t("processing.reader.status.run", {
                  status: readingStatus.processing.runStatus
                    ? t(`processing.reader.status.run_status.${readingStatus.processing.runStatus}`)
                    : t("processing.reader.status.run_status.none"),
                })}
              </p>
              {readingStatus.processing.sourceStatusAt && (
                <p>
                  {t("processing.reader.status.source_updated", {
                    time: formatStatusInstant(
                      readingStatus.processing.sourceStatusAt,
                      readingStatus.schedule?.timeZone ?? null,
                    ),
                  })}
                </p>
              )}
            </div>
          )}
          {readingStatus.schedule && (
            <div className="rounded-lg border border-fill-secondary p-3">
              <p className="font-medium text-text">{t("processing.reader.status.schedule")}</p>
              <p>
                {readingStatus.schedule.timeZone
                  ? t("processing.reader.status.time_zone", {
                      timeZone: readingStatus.schedule.timeZone,
                    })
                  : t("processing.reader.status.schedule_missing")}
              </p>
              {readingStatus.schedule.timeZone && !readingStatus.schedule.enabled && (
                <p>{t("processing.reader.status.schedule_paused")}</p>
              )}
              {readingStatus.schedule.nextScheduledStartLocal && (
                <p>
                  {t("processing.reader.status.next_scheduled", {
                    time: readingStatus.schedule.nextScheduledStartLocal.replace("T", " "),
                  })}
                </p>
              )}
              {readingStatus.schedule.readyByLeadMinutes &&
                readingStatus.schedule.nextScheduledReadyLocal && (
                  <p>
                    {t("processing.reader.status.ready_by", {
                      minutes: readingStatus.schedule.readyByLeadMinutes,
                      time: readingStatus.schedule.nextScheduledReadyLocal.replace("T", " "),
                    })}
                  </p>
                )}
              {readingStatus.schedule.pollIntervalMinutes && (
                <p>
                  {t("processing.reader.status.poll", {
                    minutes: readingStatus.schedule.pollIntervalMinutes,
                    next: readingStatus.schedule.nextPollAt
                      ? formatStatusInstant(
                          readingStatus.schedule.nextPollAt,
                          readingStatus.schedule.timeZone,
                        )
                      : t("processing.reader.status.poll_paused"),
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-red">
          {t(`processing.reader.error.${error}`)}
        </p>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("processing.reader.views")}>
        {(["smart", "hidden", "pending", "failed"] as const).map((value) => (
          <button
            type="button"
            key={value}
            className={processingButtonClass}
            aria-pressed={view === value}
            onClick={() => changeView(value)}
          >
            {t(`processing.reader.view.${value}`)}
          </button>
        ))}
      </div>
      {(view === "smart" || view === "stories" || view === "all") && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={processingButtonClass}
            disabled={!canMerge || busy}
            onClick={mergeSelectedStories}
          >
            {t("processing.reader.merge")}
          </button>
          {!canMerge && selectedStories.length === 2 && (
            <span className="text-sm text-text-secondary">
              {t("processing.reader.merge_requires_scope")}
            </span>
          )}
        </div>
      )}
      {undo && (
        <button
          type="button"
          className={processingButtonClass}
          disabled={busy}
          onClick={() => {
            setUndo(null)
            void mutate(
              `corrections/${encodeURIComponent(undo)}/undo`,
              mutationSchemas.correction,
              {},
            )
          }}
        >
          {t("processing.reader.undo")}
        </button>
      )}
      <p className="text-sm text-text-secondary">
        {t("processing.reader.count", { count: total })}
      </p>
      {items.map((item) =>
        item.state === "repairing" ? (
          <p key={item.ordinal} role="status">
            {t("processing.reader.entry.repairing")}
          </p>
        ) : item.kind === "entry" ? (
          renderEntry(item)
        ) : (
          <article key={item.ordinal} className="space-y-2 rounded-xl bg-fill-quaternary p-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedStoryIds.includes(item.story.id)}
                onChange={(event) =>
                  setSelectedStoryIds((current) =>
                    event.target.checked
                      ? [...current, item.story.id]
                      : current.filter((id) => id !== item.story.id),
                  )
                }
              />
              {t("processing.reader.select_story")}
            </label>
            <button
              type="button"
              className="font-medium"
              onClick={() => void openStory(item.story.id, item.revision)}
            >
              {item.title}
            </button>
            <p className="whitespace-pre-wrap text-sm">{item.body}</p>
          </article>
        ),
      )}
      {!items.length && <p className="text-text-secondary">{t("processing.reader.empty")}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          className={processingButtonClass}
          disabled={offset === 0 || busy}
          onClick={() => void load("page", view, offset - pageLimit)}
        >
          {t("processing.reader.previous")}
        </button>
        <span>
          {currentPage + 1} / {totalPages}
        </span>
        <button
          type="button"
          className={processingButtonClass}
          disabled={offset + pageLimit >= total || busy}
          onClick={() => void load("page", view, offset + pageLimit)}
        >
          {t("processing.reader.next")}
        </button>
      </div>
      {selected?.kind === "current" && (
        <article className="space-y-4 border-t border-fill-secondary pt-4">
          <h3 className="text-lg font-semibold">{selected.revision.title}</h3>
          <div className="flex gap-2">
            <button
              type="button"
              className={processingButtonClass}
              disabled={busy}
              onClick={() =>
                void mutate(
                  `stories/${selected.story.id}`,
                  mutationSchemas.read,
                  { revision: selected.revision.revision },
                  false,
                )
              }
            >
              {t("processing.reader.markRead")}
            </button>
            <button
              type="button"
              className={processingButtonClass}
              disabled={busy}
              onClick={() => void exportStory()}
            >
              {t("processing.reader.export")}
            </button>
            <a
              className={processingButtonClass}
              href={`/information?story=${encodeURIComponent(selected.story.id)}`}
            >
              {t("processing.reader.link")}
            </a>
          </div>
          <InformationIntegration storyId={selected.story.id} />
          <ResearchPanel
            target={{ kind: "story", storyId: selected.story.id }}
            targetTitle={selected.revision.title}
          />
          <ProcessingFeedbackPanel
            target={{
              kind: "story",
              storyId: selected.story.id,
              storyRevision: selectedSnapshotRevision ?? selected.revision.revision,
            }}
            referenceIds={selected.revision.citations.map((citation) => citation.id)}
          />
          <div className="space-y-2 rounded-lg border border-fill-secondary p-3">
            <h4 className="font-medium">{t("processing.reader.split")}</h4>
            <p className="text-sm text-text-secondary">{t("processing.reader.split_hint")}</p>
            {selected.revision.members.map((member) => (
              <label key={member.inputSeq} className="flex items-center gap-2 text-sm">
                <span>{member.inputSeq}</span>
                <select
                  value={splitAssignments[member.inputSeq] ?? 0}
                  onChange={(event) =>
                    setSplitAssignments((current) => ({
                      ...current,
                      [member.inputSeq]: Number(event.target.value),
                    }))
                  }
                >
                  <option value={0}>{t("processing.reader.split_unassigned")}</option>
                  <option value={1}>{t("processing.reader.split_group", { group: 1 })}</option>
                  <option value={2}>{t("processing.reader.split_group", { group: 2 })}</option>
                </select>
              </label>
            ))}
            {!canSplit && (
              <p className="text-sm text-orange">{t("processing.reader.split_requires_two")}</p>
            )}
            <button
              type="button"
              className={processingButtonClass}
              disabled={!canSplit || busy}
              onClick={splitSelectedStory}
            >
              {t("processing.reader.split_action")}
            </button>
          </div>
          <div className="whitespace-pre-wrap">{selected.revision.body}</div>
          {selected.revision.sentences.map((sentence) => (
            <div key={sentence.id}>
              <p>{sentence.text}</p>
              <div className="flex flex-wrap gap-2">
                {sentence.citationIds.map((citationId) => {
                  const citation = selected.revision.citations.find(
                    (item) => item.id === citationId,
                  )
                  const span = selected.revision.sourceSpans.find(
                    (item) => item.id === citation?.sourceSpanId,
                  )
                  return span ? (
                    <details key={citationId} className="rounded bg-fill-quaternary p-2 text-sm">
                      <summary>
                        {t("processing.reader.citation")} · {span.sourceRole}
                      </summary>
                      <blockquote className="whitespace-pre-wrap border-l-2 border-fill-secondary pl-3">
                        {span.quote}
                      </blockquote>
                      <a
                        className="text-accent"
                        href={`/timeline/view-0/all/${encodeURIComponent(span.sourceItemId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("processing.reader.original")}
                      </a>
                      <button
                        type="button"
                        disabled={busy}
                        className={processingButtonClass}
                        onClick={() =>
                          void mutate(
                            `stories/${selected.story.id}/remove-member`,
                            mutationSchemas.correction,
                            {
                              expectedRevision: selected.story.currentRevision,
                              inputSeq: span.inputSeq,
                            },
                          )
                        }
                      >
                        {t("processing.reader.removeMember")}
                      </button>
                    </details>
                  ) : null
                })}
              </div>
            </div>
          ))}
          <details>
            <summary>{t("processing.reader.facts")}</summary>
            {selected.revision.facts.map((fact) => (
              <p className="my-2 text-sm" key={fact.id}>
                {t(`processing.reader.fact.${fact.kind}`)}: {fact.text}
              </p>
            ))}
          </details>
        </article>
      )}
      {selected && selected.kind !== "current" && (
        <div role="status" className="space-y-2">
          <p>{t(`processing.reader.story.${selected.kind}`)}</p>
          {selected.kind === "independent" && <p>{selected.reason}</p>}
          {selected.kind === "merged" && (
            <button
              type="button"
              className={processingButtonClass}
              onClick={() => void openStory(selected.mergedInto)}
            >
              {t("processing.reader.open")}
            </button>
          )}
          {selected.kind === "split" &&
            selected.splitInto.map((id) => (
              <button
                type="button"
                key={id}
                className={processingButtonClass}
                onClick={() => void openStory(id)}
              >
                {t("processing.reader.open")}
              </button>
            ))}
          {selected.kind === "split" && selected.independentInputSeqs.length > 0 && (
            <p className="text-sm text-text-secondary">
              {t("processing.reader.split_unassigned")}: {selected.independentInputSeqs.join(", ")}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
