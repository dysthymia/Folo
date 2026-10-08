import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { EventCorrectionTools } from "./EventCorrectionTools"
import type {
  EntryEvents,
  EventCorrectionAction,
  EventDetail,
  EventMemberQuery,
  EventMembers,
  EventRole,
} from "./processing-event-client"
import {
  correctProcessingEvent,
  eventRoles,
  loadEntryEvents,
  loadEventDetail,
  loadEventMembers,
} from "./processing-event-client"
import { StoryDigestPanel } from "./StoryDigestPanel"

const buttonClass =
  "rounded-lg border border-fill-secondary px-3 py-1.5 text-sm transition-colors hover:bg-fill-secondary disabled:opacity-40"
const inputClass =
  "w-full rounded-lg border border-fill-secondary bg-material-opaque px-3 py-2 text-sm text-text"

// 来源地址不可信，只开放普通HTTP(S)原文链接，沿用现有浏览器阅读行为。
const originalHref = (url: string | null) => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null
  } catch {
    return null
  }
}

export function EntryEventsPanel({
  inputSeq,
  contentVersion,
  decisionId,
}: {
  inputSeq: number
  contentVersion: string
  decisionId: string
}) {
  const { t } = useTranslation("app")
  const identity = JSON.stringify([inputSeq, contentVersion, decisionId])
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<{ identity: string; data?: EntryEvents; error?: boolean }>({
    identity,
  })
  const [selected, setSelected] = useState<{ identity: string; id: string } | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const invalidate = () => {
      controllerRef.current?.abort()
      setRefresh((value) => value + 1)
    }
    window.addEventListener("processing-reading-invalidated", invalidate)
    return () => window.removeEventListener("processing-reading-invalidated", invalidate)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ identity })
    void loadEntryEvents(inputSeq, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        // 当前文章身份须与懒加载结果一致，避免正文更新时展示上一代事件归属。
        if (
          data.inputSeq !== inputSeq ||
          data.contentVersion !== contentVersion ||
          data.decisionId !== decisionId
        )
          throw new Error("stale_entry_events")
        setState({ identity, data })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ identity, error: true })
      })
    return () => controller.abort()
  }, [inputSeq, contentVersion, decisionId, identity, refresh])
  const visible = state.identity === identity ? state : { identity }
  const selectedId = selected?.identity === identity ? selected.id : null
  return (
    <section className="space-y-3 rounded-lg border border-fill-secondary p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-medium">{t("processing.events.title")}</h4>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("processing.events.reload")}
        </button>
      </div>
      <p className="text-xs text-text-secondary">{t("processing.events.confirmation_note")}</p>
      {visible.error ? (
        <p role="alert" className="text-red">
          {t("processing.events.stale_entry")}
        </p>
      ) : !visible.data ? (
        <p className="text-text-secondary">{t("processing.events.loading")}</p>
      ) : visible.data.events.length ? (
        <div className="space-y-2">
          {visible.data.events.map((mention) => (
            <button
              key={`${mention.event.id}:${mention.mentionId}`}
              type="button"
              className={`${buttonClass} block w-full text-left`}
              aria-expanded={selectedId === mention.event.id}
              onClick={() => setSelected({ identity, id: mention.event.id })}
            >
              {mention.event.title} · {t(`processing.events.role.${mention.role}`)} ·{" "}
              {t(`processing.events.state.${mention.state}`)}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-text-secondary">{t("processing.events.none")}</p>
      )}
      {!visible.error && selectedId && (
        <EventDetails
          key={`${identity}:${selectedId}`}
          eventId={selectedId}
          refresh={refresh}
          onSelect={(id) => setSelected({ identity, id })}
        />
      )}
    </section>
  )
}

function EventDetails({
  eventId,
  refresh,
  onSelect,
}: {
  eventId: string
  refresh: number
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation("app")
  const [role, setRole] = useState<EventRole | "">("")
  const [stateFilter, setStateFilter] = useState<"" | "confirmed" | "candidate">("")
  const [manualRefresh, setManualRefresh] = useState(0)
  const key = JSON.stringify([eventId, refresh, manualRefresh, role, stateFilter])
  const currentKeyRef = useRef(key)
  currentKeyRef.current = key
  const [loaded, setLoaded] = useState<{
    key: string
    detail?: EventDetail
    members?: EventMembers
    error?: boolean
  }>({ key })
  const [title, setTitle] = useState("")
  const [mutationBusy, setMutationBusy] = useState(false)
  const [pageBusy, setPageBusy] = useState(false)
  const [mutationError, setMutationError] = useState(false)
  const [lastCorrection, setLastCorrection] = useState<{
    id: string
    revisions: Record<string, number>
  } | null>(null)
  const [openedStory, setOpenedStory] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const mutationRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      mutationRef.current?.abort()
      requestRef.current?.abort()
    },
    [],
  )
  const query: EventMemberQuery = {
    ...(role ? { role } : {}),
    ...(stateFilter ? { state: stateFilter } : {}),
    offset: 0,
    limit: 20,
  }
  useEffect(() => {
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setLoaded({ key })
    setPageBusy(false)
    void Promise.all([
      loadEventDetail(eventId, controller.signal),
      loadEventMembers(
        eventId,
        {
          ...(role ? { role } : {}),
          ...(stateFilter ? { state: stateFilter } : {}),
          offset: 0,
          limit: 20,
        },
        controller.signal,
      ),
    ])
      .then(([detail, members]) => {
        if (controller.signal.aborted || currentKeyRef.current !== key) return
        if (detail.event.id !== eventId) throw new Error("invalid_event")
        setLoaded({ key, detail, members })
        setTitle(detail.event.title)
      })
      .catch(() => {
        if (!controller.signal.aborted && currentKeyRef.current === key)
          setLoaded({ key, error: true })
      })
    return () => controller.abort()
  }, [eventId, key, role, stateFilter])
  const visible = loaded.key === key ? loaded : { key }
  const loadMore = async () => {
    if (!visible.members || visible.members.nextOffset === null || !visible.detail || pageBusy)
      return
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setPageBusy(true)
    try {
      const next = await loadEventMembers(
        eventId,
        { ...query, snapshotId: visible.members.snapshotId, offset: visible.members.nextOffset },
        controller.signal,
      )
      if (controller.signal.aborted || currentKeyRef.current !== key) return
      if (next.snapshotId !== visible.members.snapshotId) throw new Error("stale_snapshot")
      setLoaded({
        key,
        detail: visible.detail,
        members: { ...next, rows: [...visible.members.rows, ...next.rows] },
      })
    } catch {
      if (!controller.signal.aborted && currentKeyRef.current === key)
        setLoaded({ key, error: true })
    } finally {
      if (!controller.signal.aborted && currentKeyRef.current === key) setPageBusy(false)
    }
  }
  const correct = async (action: EventCorrectionAction, revisions: Record<string, number> = {}) => {
    if (!visible.detail || mutationBusy) return
    const controller = new AbortController()
    mutationRef.current = controller
    setMutationBusy(true)
    setMutationError(false)
    const captured = key
    try {
      let expectedRevisions = { ...revisions, [eventId]: visible.detail.event.revision }
      if (action.type === "undo" && lastCorrection) {
        // 合并和拆分触及多个事件，撤销前必须核验全部相关修订，不能只发送源事件。
        const related = await Promise.all(
          Object.keys(lastCorrection.revisions).map(async (id) => {
            const detail = await loadEventDetail(id, controller.signal)
            // 撤销前按请求目标核验返回身份，避免错误响应覆盖其他事件修订。
            if (detail.event.id !== id) throw new Error("invalid_event_detail")
            return detail
          }),
        )
        if (controller.signal.aborted || currentKeyRef.current !== captured) return
        expectedRevisions = Object.fromEntries(
          related.map(({ event }) => [event.id, event.revision]),
        )
      }
      const result = await correctProcessingEvent(
        eventId,
        expectedRevisions,
        action,
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (result.event.id !== eventId) throw new Error("invalid_event_correction")
      const relatedRevisions = { ...expectedRevisions, [result.event.id]: result.event.revision }
      for (const related of result.events ?? []) relatedRevisions[related.id] = related.revision
      // 老响应没有events时也保留目标与拆分后继，撤销前会逐个读取最新修订。
      for (const id of result.event.splitInto) relatedRevisions[id] ??= 0
      setLastCorrection(
        action.type === "undo"
          ? null
          : {
              id: result.correctionId,
              revisions: relatedRevisions,
            },
      )
      // 成功响应只保存撤销入口；共享失效事件会重新核验成员和修订。
    } catch {
      if (!controller.signal.aborted && currentKeyRef.current === captured) {
        setMutationError(true)
        // 失败回执可能丢失，必须先重新核验修订号才能再次提交。
        setLoaded({ key, error: true })
      }
    } finally {
      if (!controller.signal.aborted) setMutationBusy(false)
    }
  }
  const rows = visible.members?.rows ?? []
  return (
    <div className="space-y-3 border-t border-fill-secondary pt-3">
      <div className="flex flex-wrap gap-2">
        <label className="text-xs text-text-secondary">
          {t("processing.events.role_filter")}
          <select
            className={inputClass}
            value={role}
            onChange={(event) => setRole(event.target.value as EventRole | "")}
          >
            <option value="">{t("processing.events.all_roles")}</option>
            {eventRoles.map((value) => (
              <option key={value} value={value}>
                {t(`processing.events.role.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          {t("processing.events.state_filter")}
          <select
            className={inputClass}
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}
          >
            <option value="">{t("processing.events.all_states")}</option>
            <option value="confirmed">{t("processing.events.state.confirmed")}</option>
            <option value="candidate">{t("processing.events.state.candidate")}</option>
          </select>
        </label>
      </div>
      {visible.error ? (
        <p role="alert" className="text-red">
          {t("processing.events.reload_required")}
        </p>
      ) : !visible.detail || !visible.members ? (
        <p>{t("processing.events.loading")}</p>
      ) : (
        <>
          <h5 className="font-medium">
            {visible.detail.event.title} ·{" "}
            {t(`processing.events.status.${visible.detail.event.status}`)}
          </h5>
          {visible.detail.event.aliases.length > 0 && (
            <p className="text-xs text-text-secondary">
              {visible.detail.event.aliases.join(" · ")}
            </p>
          )}
          {visible.detail.event.mergedInto && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => onSelect(visible.detail!.event.mergedInto!)}
            >
              {t("processing.events.open_merged")}
            </button>
          )}
          {visible.detail.event.splitInto.map((id, index) => (
            <button key={id} type="button" className={buttonClass} onClick={() => onSelect(id)}>
              {t("processing.events.open_split", { number: index + 1 })}
            </button>
          ))}
          <p className="text-xs text-text-secondary">
            {t("processing.events.member_count", { count: visible.members.total })}
          </p>
          {!rows.length && (
            <p className="text-text-secondary">{t("processing.events.no_members")}</p>
          )}
          {eventRoles.map((memberRole) => {
            const members = rows.filter((row) => row.role === memberRole)
            return members.length ? (
              <section key={memberRole} className="space-y-2">
                <h6 className="text-sm font-medium">{t(`processing.events.role.${memberRole}`)}</h6>
                {(memberRole === "analysis_of" || memberRole === "tutorial_for") && (
                  <p className="text-xs text-text-secondary">
                    {t("processing.events.related_independent")}
                  </p>
                )}
                {members.map((member) => {
                  const href = originalHref(member.url)
                  return (
                    <article
                      key={`${member.inputSeq}:${member.mentionId}`}
                      className="space-y-1 rounded-lg bg-fill-quinary p-2"
                    >
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent underline"
                        >
                          {member.title}
                        </a>
                      ) : (
                        <p>{member.title}</p>
                      )}
                      <p className="text-xs text-text-secondary">
                        {typeof member.sourceTitle === "string"
                          ? member.sourceTitle
                          : href
                            ? new URL(href).hostname
                            : t("processing.events.source_unknown")}{" "}
                        · {t(`processing.events.state.${member.state}`)}
                      </p>
                      {member.evidence.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-xs text-text-secondary">
                            {t("processing.events.evidence")}
                          </summary>
                          {member.evidence.map((quote, index) => (
                            <p key={index} className="whitespace-pre-wrap text-xs">
                              {quote}
                            </p>
                          ))}
                        </details>
                      )}
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={mutationBusy}
                        onClick={() =>
                          void correct({
                            type: "exclude",
                            inputSeq: member.inputSeq,
                            mentionId: member.mentionId,
                          })
                        }
                      >
                        {t("processing.events.exclude")}
                      </button>
                    </article>
                  )
                })}
              </section>
            ) : null
          })}
          {visible.members.nextOffset !== null && (
            <button
              type="button"
              className={buttonClass}
              disabled={pageBusy}
              onClick={() => void loadMore()}
            >
              {t("processing.events.load_more")}
            </button>
          )}
          <section className="space-y-2">
            <h6 className="font-medium">{t("processing.events.stories")}</h6>
            {visible.detail.stories.length ? (
              visible.detail.stories.map((story) => (
                <div key={story.id}>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => setOpenedStory(openedStory === story.id ? null : story.id)}
                  >
                    {story.title}
                  </button>
                  {openedStory === story.id && (
                    <StoryDigestPanel
                      storyId={story.id}
                      storyTitle={story.title}
                      revision={story.revision}
                    />
                  )}
                </div>
              ))
            ) : (
              <p className="text-xs text-text-secondary">{t("processing.events.no_story")}</p>
            )}
          </section>
          {!["merged", "split"].includes(visible.detail.event.status) && (
            <EventCorrectionTools
              key={`${key}:${visible.detail.event.revision}`}
              source={visible.detail.event}
              rows={rows}
              total={visible.members.total}
              filtered={!!role || !!stateFilter}
              complete={
                visible.members.nextOffset === null && rows.length === visible.members.total
              }
              busy={mutationBusy || pageBusy}
              onLoadMore={() => void loadMore()}
              onClearFilters={() => {
                setRole("")
                setStateFilter("")
              }}
              onCorrect={correct}
            />
          )}
          <label className="block space-y-1 text-sm">
            {t("processing.events.rename_label")}
            <input
              className={inputClass}
              aria-label={t("processing.events.rename_label")}
              value={title}
              maxLength={500}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={buttonClass}
            disabled={mutationBusy || !title.trim() || title.trim() === visible.detail.event.title}
            onClick={() => void correct({ type: "rename", title: title.trim() })}
          >
            {t("processing.events.rename_save")}
          </button>
          {lastCorrection && (
            <button
              type="button"
              className={buttonClass}
              disabled={mutationBusy}
              onClick={() => void correct({ type: "undo", correctionId: lastCorrection.id })}
            >
              {t("processing.events.undo")}
            </button>
          )}
        </>
      )}
      {mutationError && (
        <p role="alert" className="text-red">
          {t("processing.events.correction_error")}
        </p>
      )}
      <button
        type="button"
        className={buttonClass}
        onClick={() => {
          setMutationError(false)
          setManualRefresh((value) => value + 1)
        }}
      >
        {t("processing.events.reload")}
      </button>
    </div>
  )
}
