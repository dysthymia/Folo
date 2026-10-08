import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type {
  EventCorrectionAction,
  EventDetail,
  EventMembers,
  EventSearch,
  ProcessingEvent,
} from "./processing-event-client"
import {
  loadEventDetail,
  loadEventMembers,
  searchProcessingEvents,
} from "./processing-event-client"

const buttonClass =
  "rounded-lg border border-fill-secondary px-3 py-1.5 text-sm hover:bg-fill-secondary disabled:opacity-40"
const inputClass =
  "w-full rounded-lg border border-fill-secondary bg-material-opaque px-3 py-2 text-sm"
type Member = EventMembers["rows"][number]
const memberKey = (member: Member) => JSON.stringify([member.inputSeq, member.mentionId])
type Preview = {
  action: EventCorrectionAction
  revisions: Record<string, number>
  rows: Member[]
  target?: { title: string; count: number }
  sourceCount: number
}

export function EventCorrectionTools({
  source,
  rows,
  total,
  filtered,
  complete,
  busy,
  onLoadMore,
  onClearFilters,
  onCorrect,
}: {
  source: ProcessingEvent
  rows: Member[]
  total: number
  filtered: boolean
  complete: boolean
  busy: boolean
  onLoadMore: () => void
  onClearFilters: () => void
  onCorrect: (action: EventCorrectionAction, revisions: Record<string, number>) => Promise<void>
}) {
  const { t } = useTranslation("app")
  const [mode, setMode] = useState<"move" | "merge" | "split">("move")
  const [search, setSearch] = useState("")
  const [result, setResult] = useState<EventSearch | null>(null)
  const [target, setTarget] = useState<{ detail: EventDetail; count: number } | null>(null)
  const [member, setMember] = useState("")
  const [groupNames, setGroupNames] = useState<[string, string]>(() => [
    t("processing.events.split_default", { title: source.title, number: 1 }),
    t("processing.events.split_default", { title: source.title, number: 2 }),
  ])
  const [assignments, setAssignments] = useState<Record<string, 0 | 1>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  useEffect(() => () => requestRef.current?.abort(), [])
  useEffect(() => {
    setPreview(null)
  }, [rows, total, source.revision, filtered])
  const resetSearch = (value: string) => {
    requestRef.current?.abort()
    setSearch(value)
    setResult(null)
    setTarget(null)
    setPreview(null)
    setLoading(false)
  }
  const findEvents = async (more = false) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError(false)
    setPreview(null)
    if (!more) setTarget(null)
    try {
      const next = await searchProcessingEvents(
        {
          search: search.trim(),
          offset: more ? (result?.nextOffset ?? 0) : 0,
          limit: 20,
          ...(more && result ? { snapshotId: result.snapshotId } : {}),
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (more && result && next.snapshotId !== result.snapshotId)
        throw new Error("stale_event_search")
      setResult(more && result ? { ...next, events: [...result.events, ...next.events] } : next)
    } catch {
      if (!controller.signal.aborted) {
        setError(true)
        setResult(null)
        setTarget(null)
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  const selectTarget = async (id: string) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setTarget(null)
    setPreview(null)
    setError(false)
    setLoading(true)
    try {
      const [detail, members] = await Promise.all([
        loadEventDetail(id, controller.signal),
        loadEventMembers(id, { offset: 0, limit: 20 }, controller.signal),
      ])
      if (controller.signal.aborted) return
      if (detail.event.id !== id || ["merged", "split"].includes(detail.event.status))
        throw new Error("invalid_target_event")
      setTarget({ detail, count: members.total })
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  const selected = rows.find((row) => memberKey(row) === member)
  const groups = [0, 1].map((index) =>
    rows.filter((row) => (assignments[memberKey(row)] ?? 0) === index),
  )
  const validSplit =
    !filtered &&
    complete &&
    groupNames.every((name) => name.trim()) &&
    groupNames[0].trim() !== groupNames[1].trim() &&
    groups.every((group) => group.length)
  const canPrepare =
    mode === "split"
      ? validSplit
      : !!target && (mode === "move" ? !!selected : !filtered && total > 0)
  const prepare = () => {
    if (!canPrepare) return
    const revisions = {
      [source.id]: source.revision,
      ...(target ? { [target.detail.event.id]: target.detail.event.revision } : {}),
    }
    if (mode === "split")
      setPreview({
        action: {
          type: "split",
          groups: groups.map((group, index) => ({
            title: groupNames[index]!.trim(),
            members: group.map((row) => ({ inputSeq: row.inputSeq, mentionId: row.mentionId })),
          })),
        },
        revisions: { [source.id]: source.revision },
        rows,
        sourceCount: total,
      })
    else if (target)
      setPreview({
        action:
          mode === "move"
            ? {
                type: "move",
                inputSeq: selected!.inputSeq,
                mentionId: selected!.mentionId,
                targetEventId: target.detail.event.id,
              }
            : { type: "merge", targetEventId: target.detail.event.id },
        revisions,
        rows: mode === "move" ? [selected!] : rows,
        target: { title: target.detail.event.title, count: target.count },
        sourceCount: mode === "move" ? 1 : total,
      })
  }
  return (
    <section className="space-y-3 rounded-lg border border-fill-secondary p-3">
      <h6 className="font-medium">{t("processing.events.adjust_membership")}</h6>
      <label className="block space-y-1 text-sm">
        {t("processing.events.correction_action")}
        <select
          className={inputClass}
          value={mode}
          disabled={busy}
          onChange={(event) => {
            requestRef.current?.abort()
            setMode(event.target.value as typeof mode)
            setTarget(null)
            setLoading(false)
            setPreview(null)
          }}
        >
          <option value="move">{t("processing.events.move")}</option>
          <option value="merge">{t("processing.events.merge")}</option>
          <option value="split">{t("processing.events.split")}</option>
        </select>
      </label>
      {mode !== "split" ? (
        <>
          {mode === "move" && (
            <label className="block space-y-1 text-sm">
              {t("processing.events.move_member")}
              <select
                className={inputClass}
                value={member}
                disabled={busy}
                onChange={(event) => {
                  setMember(event.target.value)
                  setPreview(null)
                }}
              >
                <option value="">{t("processing.events.choose_member")}</option>
                {rows.map((row) => (
                  <option key={memberKey(row)} value={memberKey(row)}>
                    {row.title} · {t(`processing.events.role.${row.role}`)}
                    {row.evidence[0] ? ` · ${row.evidence[0].slice(0, 80)}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === "merge" && filtered && (
            <p className="text-xs text-text-secondary">
              {t("processing.events.unfiltered_required")}
            </p>
          )}
          <label className="block space-y-1 text-sm">
            {t("processing.events.target_search")}
            <input
              className={inputClass}
              value={search}
              disabled={busy}
              onChange={(event) => resetSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || busy}
            onClick={() => void findEvents()}
          >
            {t("processing.events.search")}
          </button>
          {result && (
            <div className="space-y-1">
              {result.events
                .filter(
                  (item) => item.id !== source.id && !["merged", "split"].includes(item.status),
                )
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={buttonClass}
                    disabled={loading || busy}
                    onClick={() => void selectTarget(item.id)}
                  >
                    {item.title}
                  </button>
                ))}
              {result.nextOffset !== null && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={loading || busy}
                  onClick={() => void findEvents(true)}
                >
                  {t("processing.events.search_more")}
                </button>
              )}
            </div>
          )}
          {target && (
            <p className="text-sm">
              {t("processing.events.selected_target", { title: target.detail.event.title })}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-xs text-text-secondary">
            {t("processing.events.split_complete_note")}
          </p>
          {filtered ? (
            <button type="button" className={buttonClass} onClick={onClearFilters}>
              {t("processing.events.clear_filters")}
            </button>
          ) : (
            !complete && (
              <button type="button" className={buttonClass} disabled={busy} onClick={onLoadMore}>
                {t("processing.events.load_complete")}
              </button>
            )
          )}
          {groupNames.map((name, index) => (
            <label key={index} className="block space-y-1 text-sm">
              {t("processing.events.group_name", { number: index + 1 })}
              <input
                className={inputClass}
                value={name}
                maxLength={500}
                disabled={busy}
                onChange={(event) => {
                  setGroupNames((previous) =>
                    index === 0
                      ? [event.target.value, previous[1]]
                      : [previous[0], event.target.value],
                  )
                  setPreview(null)
                }}
              />
            </label>
          ))}
          {rows.map((row) => (
            <label key={memberKey(row)} className="block space-y-1 text-sm">
              {row.title} · {t(`processing.events.role.${row.role}`)}
              {row.evidence[0] ? ` · ${row.evidence[0].slice(0, 80)}` : ""}
              <select
                className={inputClass}
                value={assignments[memberKey(row)] ?? 0}
                disabled={busy || filtered || !complete}
                onChange={(event) => {
                  setAssignments((previous) => ({
                    ...previous,
                    [memberKey(row)]: Number(event.target.value) as 0 | 1,
                  }))
                  setPreview(null)
                }}
              >
                <option value={0}>{groupNames[0]}</option>
                <option value={1}>{groupNames[1]}</option>
              </select>
            </label>
          ))}
        </>
      )}
      {error && (
        <p role="alert" className="text-red">
          {t("processing.events.target_error")}
        </p>
      )}
      <button
        type="button"
        className={buttonClass}
        disabled={!canPrepare || busy || loading}
        onClick={prepare}
      >
        {t("processing.events.preview_correction")}
      </button>
      {preview && (
        <div className="space-y-2 rounded-lg bg-fill-quinary p-3">
          <h6 className="font-medium">{t("processing.events.preview_title")}</h6>
          {preview.target && (
            <p>
              {t(
                mode === "move"
                  ? "processing.events.move_preview"
                  : "processing.events.merge_preview",
                {
                  source: source.title,
                  target: preview.target.title,
                  count: preview.sourceCount,
                  targetCount: preview.target.count,
                },
              )}
            </p>
          )}
          {preview.action.type === "split" ? (
            preview.action.groups.map((group) => (
              <div key={group.title}>
                <p className="font-medium">{group.title}</p>
                <ul className="list-inside list-disc">
                  {group.members.map((item) => (
                    <li key={JSON.stringify(item)}>
                      {
                        rows.find(
                          (row) =>
                            row.inputSeq === item.inputSeq && row.mentionId === item.mentionId,
                        )?.title
                      }
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <ul className="list-inside list-disc">
              {preview.rows.map((row) => (
                <li key={memberKey(row)}>
                  {row.title}
                  {row.evidence[0] && (
                    <span className="text-xs text-text-secondary">
                      {" "}
                      · {row.evidence[0].slice(0, 80)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {mode === "merge" && preview.rows.length < preview.sourceCount && (
            <p className="text-xs text-text-secondary">
              {t("processing.events.preview_more", {
                count: preview.sourceCount - preview.rows.length,
              })}
            </p>
          )}
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void onCorrect(preview.action, preview.revisions)}
          >
            {t("processing.events.confirm_correction")}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => setPreview(null)}
          >
            {t("processing.events.cancel_preview")}
          </button>
        </div>
      )}
    </section>
  )
}
