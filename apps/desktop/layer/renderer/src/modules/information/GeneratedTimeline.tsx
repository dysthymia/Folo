import { FeedViewType } from "@follow/constants"
import { collectionSyncService } from "@follow/store/collection/store"
import { entrySyncServices } from "@follow/store/entry/store"
import { getSubscriptionByEntryId } from "@follow/store/subscription/getter"
import { unreadSyncService } from "@follow/store/unread/store"
import { useWhoami } from "@follow/store/user/hooks"
import { useAtom } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useSearchParams } from "react-router"

import { useGeneralSettingKey } from "~/atoms/settings/general"
import { useRouteParams } from "~/hooks/biz/useRouteParams"
import { timelineContentModeAtom } from "~/modules/entry-column/atoms/processing-timeline"
import { EntryContent } from "~/modules/entry-content/components/entry-content"

import type {
  GeneratedFeedPage,
  GeneratedFeedQuery,
  GeneratedReaderItem,
  GeneratedStoryState,
} from "./generated-feed-client"
import {
  appendGeneratedPage,
  generatedItemKey,
  loadGeneratedFeedPage,
  loadGeneratedStoryState,
  setGeneratedStoryState,
} from "./generated-feed-client"
import type { ReaderSession } from "./generated-feed-session"
import { readerSession, saveReaderSession, updateReaderSessions } from "./generated-feed-session"
import { GeneratedEntryControls } from "./GeneratedEntryControls"
import { InformationIntegration } from "./InformationIntegration"
import { ResearchPanel } from "./ResearchPanel"
import { StoryDigestPanel } from "./StoryDigestPanel"

type ReadingContext = { owner: string | null; queryKey: string; epoch: number }
type StoryTarget = { kind: "story"; storyId: string; revision?: number }

// 深链和日期输入先核实日历日期，避免toISOString在渲染期间抛错或把2月30日进位。
const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return ""
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : ""
}

const topicOptions = [
  ["", "processing.generated.topic_0"],
  ["空投", "processing.generated.topic_1"],
  ["投资交易", "processing.generated.topic_2"],
  ["AI", "processing.generated.topic_3"],
  ["个人成长", "processing.generated.topic_4"],
  ["重要事件", "processing.generated.topic_5"],
] as const

/** 原时间线的结果投影：列表与正文仍共用主阅读区域，轮询只提示新快照。 */
export function GeneratedTimeline({
  scope,
  title,
}: {
  scope: Pick<GeneratedFeedQuery, "mode" | "sourceKeys" | "category" | "collectedOnly" | "view">
  title?: string
}) {
  const { t } = useTranslation("app")
  const owner = useWhoami()?.id ?? null
  const { view } = useRouteParams()
  const defaultUnreadOnly = useGeneralSettingKey("unreadOnly")
  const [, setContentMode] = useAtom(timelineContentModeAtom)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [search, setSearch] = useState(params.get("aiSearch") ?? "")
  const [searchDraft, setSearchDraft] = useState(search)
  const [topic, setTopic] = useState(params.get("aiTopic") ?? "")
  const [unreadOnly, setUnreadOnly] = useState(
    params.has("aiUnread") ? params.get("aiUnread") === "true" : defaultUnreadOnly,
  )
  const [collectedOnly, setCollectedOnly] = useState(params.get("aiCollected") === "true")
  const [since, setSince] = useState(() => validDate(params.get("aiSince") ?? ""))
  const [until, setUntil] = useState(() => validDate(params.get("aiUntil") ?? ""))
  const [dateDraft, setDateDraft] = useState({ since, until })
  const [deepState, setDeepState] = useState<GeneratedStoryState | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [page, setPage] = useState<GeneratedFeedPage | null>(null)
  const [pageContext, setPageContext] = useState({ owner, queryKey: "" })
  const [deepOwner, setDeepOwner] = useState(owner)
  const [items, setItems] = useState<GeneratedReaderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [changing, setChanging] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const requestRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const epochRef = useRef(0)
  const pageEpochRef = useRef(0)
  const pagingRef = useRef(false)
  const invalidationPendingRef = useRef(false)
  const pollRef = useRef<AbortController | null>(null)
  const mutationsRef = useRef(new Set<AbortController>())
  const mutationVersionRef = useRef(0)
  const sessionRef = useRef<{ owner: string; queryKey: string; session: ReaderSession } | null>(
    null,
  )
  const previousRequestRef = useRef<{
    owner: string | null
    queryKey: string
    refreshVersion: number
  } | null>(null)
  const cursorsRef = useRef<Array<string | undefined>>([undefined])
  const readChangesRef = useRef(new Map<string, { read?: boolean; collected?: boolean }>())
  const query = useMemo<GeneratedFeedQuery>(
    () => ({
      ...scope,
      search,
      topic,
      unreadOnly,
      collectedOnly: scope.collectedOnly || collectedOnly,
      since: since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
      until:
        until && (!since || until >= since)
          ? new Date(`${until}T23:59:59.999`).toISOString()
          : undefined,
      limit: 30,
    }),
    [scope, search, topic, unreadOnly, collectedOnly, since, until],
  )
  const queryKey = JSON.stringify(query)
  const selectedKey = params.get("item")
  const deepStoryId = params.get("story")
  const selected = items.find(
    (item) =>
      generatedItemKey(item) === selectedKey ||
      (item.kind === "story" && item.storyId === deepStoryId),
  )
  const storyId = selected?.kind === "story" ? selected.storyId : deepStoryId
  const currentRef = useRef({ query, owner, queryKey, storyId })
  currentRef.current = { query, owner, queryKey, storyId }
  const visibleDeepState = deepOwner === owner && deepState?.storyId === storyId ? deepState : null
  const context = () => ({
    owner: currentRef.current.owner,
    queryKey: currentRef.current.queryKey,
    epoch: epochRef.current,
  })
  const isCurrent = (captured: ReadingContext, request: AbortController) =>
    !request.signal.aborted &&
    captured.epoch === epochRef.current &&
    captured.owner === currentRef.current.owner &&
    captured.queryKey === currentRef.current.queryKey
  const isOwnedMutation = (captured: ReadingContext, request: AbortController) =>
    !request.signal.aborted && captured.owner === currentRef.current.owner
  const saveSession = (capturedOwner: string | null, capturedKey: string) => {
    const current = sessionRef.current
    if (!current || current.owner !== capturedOwner || current.queryKey !== capturedKey) return
    saveReaderSession(current.owner, current.queryKey, {
      ...current.session,
      scrollTop: scrollRef.current?.scrollTop ?? current.session.scrollTop,
      readChanges: [...readChangesRef.current],
    })
  }
  const publish = (
    next: GeneratedFeedPage,
    rows: GeneratedReaderItem[],
    captured: ReadingContext,
  ) => {
    if (!captured.owner) return
    sessionRef.current = {
      owner: captured.owner,
      queryKey: captured.queryKey,
      session: {
        page: next,
        items: rows.map((item) => ({
          ...item,
          ...readChangesRef.current.get(generatedItemKey(item)),
        })),
        cursors: [...cursorsRef.current],
        scrollTop: scrollRef.current?.scrollTop ?? 0,
        readChanges: [...readChangesRef.current],
      },
    }
    setPageContext({ owner: captured.owner, queryKey: captured.queryKey })
    setPage(next)
    setItems(sessionRef.current.session.items)
  }

  useEffect(() => {
    const mutations = mutationsRef.current
    readChangesRef.current.clear()
    setChanging(false)
    // 查询变更只取消取页；目标条目操作仅在退出账号或离开阅读器时取消。
    return () => {
      for (const mutation of mutations) mutation.abort()
      mutations.clear()
    }
  }, [owner])

  useEffect(() => {
    setDeepState(null)
    setDeepOwner(owner)
    if (!storyId || !owner) return
    const request = new AbortController()
    const capturedOwner = owner
    const capturedMutation = mutationVersionRef.current
    void loadGeneratedStoryState(storyId, request.signal)
      .then((state) => {
        if (
          !request.signal.aborted &&
          capturedMutation === mutationVersionRef.current &&
          currentRef.current.owner === capturedOwner &&
          currentRef.current.queryKey === queryKey &&
          currentRef.current.storyId === storyId
        )
          setDeepState({ ...state, ...readChangesRef.current.get(`story:${storyId}`) })
      })
      .catch(() => {
        if (
          !request.signal.aborted &&
          capturedMutation === mutationVersionRef.current &&
          currentRef.current.owner === capturedOwner
        )
          setDeepState(null)
      })
    return () => request.abort()
  }, [storyId, owner, queryKey])

  useEffect(() => {
    // 筛选条件放回当前路由，切换原始内容后返回仍保留日期和搜索范围。
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        for (const [key, value] of Object.entries({
          aiSearch: search,
          aiTopic: topic,
          aiUnread: String(unreadOnly),
          aiCollected: String(collectedOnly),
          aiSince: since,
          aiUntil: until,
        }))
          value ? next.set(key, value) : next.delete(key)
        return next
      },
      { replace: true },
    )
  }, [search, topic, unreadOnly, collectedOnly, since, until, setParams])

  useEffect(() => {
    epochRef.current++
    pageEpochRef.current++
    pagingRef.current = false
    invalidationPendingRef.current = false
    const request = new AbortController()
    requestRef.current?.abort()
    pollRef.current?.abort()
    requestRef.current = request
    const captured = context()
    const epoch = epochRef
    setFailed(false)
    setPageContext({ owner, queryKey })
    const previous = previousRequestRef.current
    const forceRefresh =
      previous?.owner === owner &&
      previous.queryKey === queryKey &&
      previous.refreshVersion !== refreshVersion
    previousRequestRef.current = { owner, queryKey, refreshVersion }
    const cached = forceRefresh ? undefined : readerSession(owner, queryKey)
    if (forceRefresh && mutationsRef.current.size === 0) readChangesRef.current.clear()
    cursorsRef.current = cached ? [...cached.cursors] : [undefined]
    readChangesRef.current = new Map([...(cached?.readChanges ?? []), ...readChangesRef.current])
    if (cached) {
      sessionRef.current = owner ? { owner, queryKey, session: cached } : null
      setPage(cached.page)
      setItems(
        cached.items.map((item) => ({
          ...item,
          ...readChangesRef.current.get(generatedItemKey(item)),
        })),
      )
      setLoading(false)
      requestAnimationFrame(() => {
        if (isCurrent(captured, request) && scrollRef.current)
          scrollRef.current.scrollTop = cached.scrollTop
      })
    } else {
      sessionRef.current = null
      setLoading(Boolean(owner))
      setPage(null)
      setItems([])
      if (owner)
        void loadGeneratedFeedPage({ ...currentRef.current.query, refresh: true }, request.signal)
          .then((result) => {
            if (isCurrent(captured, request)) publish(result, result.items, captured)
          })
          .catch(() => {
            if (isCurrent(captured, request)) setFailed(true)
          })
          .finally(() => {
            if (isCurrent(captured, request)) setLoading(false)
          })
    }
    // 保存的是成功发布时冻结的归属，render已经切到新scope也不能给旧页换账号或key。
    return () => {
      saveSession(owner, queryKey)
      request.abort()
      requestRef.current?.abort()
      pollRef.current?.abort()
      epoch.current++
    }
  }, [queryKey, owner, refreshVersion])

  useEffect(() => {
    const poll = async (refreshStory = false) => {
      const saved = sessionRef.current
      if (!saved || pagingRef.current || document.visibilityState === "hidden") return
      pollRef.current?.abort()
      const request = new AbortController()
      pollRef.current = request
      const captured = context()
      const pageEpoch = pageEpochRef.current
      try {
        const pages = Promise.all(
          [...cursorsRef.current].map((cursor) =>
            loadGeneratedFeedPage(
              { ...currentRef.current.query, snapshotId: saved.session.page.snapshotId, cursor },
              request.signal,
            ),
          ),
        )
        const activeStory = currentRef.current.storyId
        const [responses, state] = await Promise.all([
          pages,
          refreshStory && activeStory
            ? loadGeneratedStoryState(activeStory, request.signal)
            : Promise.resolve(null),
        ])
        if (!isCurrent(captured, request) || pageEpoch !== pageEpochRef.current) return
        const result = responses.at(-1)!
        if (state && currentRef.current.storyId === activeStory) {
          setDeepOwner(captured.owner)
          setDeepState({ ...state, ...readChangesRef.current.get(`story:${activeStory}`) })
        }
        // 当前快照只接纳人工纠错；轮询到后台新决定时只更新可应用提示。
        if (sessionRef.current?.session.page.snapshotId !== result.snapshotId) return
        const rows = responses
          .reduce<GeneratedReaderItem[]>(
            (all, response) => appendGeneratedPage(all, response.items),
            [],
          )
          .map((item) => ({ ...item, ...readChangesRef.current.get(generatedItemKey(item)) }))
        publish(
          {
            ...saved.session.page,
            latestAvailable: result.latestAvailable,
            counts: result.counts,
            nextCursor: result.nextCursor,
            total: result.total,
          },
          rows,
          captured,
        )
      } catch {
        // 暂时断网保留已读快照；scope和账号变化会废弃这次请求。
      }
    }
    const timer = setInterval(() => void poll(), 60_000)
    const invalidate = (event: Event) => {
      const manual = event.type === "processing-reading-invalidated"
      if (pagingRef.current) invalidationPendingRef.current ||= manual
      else void poll(manual)
    }
    document.addEventListener("visibilitychange", invalidate)
    window.addEventListener("processing-reading-invalidated", invalidate)
    return () => {
      pollRef.current?.abort()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", invalidate)
      window.removeEventListener("processing-reading-invalidated", invalidate)
    }
  }, [])

  const mutateItem = useCallback(
    async (
      item: GeneratedReaderItem | StoryTarget,
      state: { read?: boolean; collected?: boolean },
    ) => {
      const request = new AbortController()
      const captured = context()
      if (!captured.owner) return
      mutationsRef.current.add(request)
      setChanging(true)
      const key = item.kind === "story" ? `story:${item.storyId}` : generatedItemKey(item)
      try {
        let updated: GeneratedStoryState | undefined
        if (item.kind === "story") {
          updated = await setGeneratedStoryState(
            item.storyId,
            { ...state, revision: item.revision },
            request.signal,
          )
          if (!isOwnedMutation(captured, request)) return
          if (currentRef.current.storyId === item.storyId) {
            setDeepOwner(captured.owner)
            setDeepState(updated)
          }
        } else {
          // 每次await后检查账号，已开始的原文详情请求不能继续为新账号执行读态/收藏。
          await entrySyncServices.fetchEntryDetail(item.id, item.sourceKey.startsWith("inbox/"))
          if (!isOwnedMutation(captured, request)) return
          if (state.read !== undefined) {
            await (state.read
              ? unreadSyncService.markEntryAsRead(item.id)
              : unreadSyncService.markEntryAsUnread(item.id))
            if (!isOwnedMutation(captured, request)) return
          }
          if (state.collected !== undefined) {
            const actualView =
              getSubscriptionByEntryId(item.id)?.view ??
              (item.sourceKey.startsWith("inbox/") ? FeedViewType.Articles : view)
            if (state.collected && actualView === FeedViewType.All)
              throw new Error("unknown_entry_view")
            await (state.collected
              ? collectionSyncService.starEntry({ entryId: item.id, view: actualView })
              : collectionSyncService.unstarEntry({ entryId: item.id }))
            if (!isOwnedMutation(captured, request)) return
          }
        }
        // 晚返回的深链读取不能覆盖已经成功确认的操作，显式刷新清除覆盖值后也一样。
        mutationVersionRef.current++
        readChangesRef.current.set(key, { ...readChangesRef.current.get(key), ...state })
        updateReaderSessions(captured.owner, key, state)
        const saved = sessionRef.current
        if (saved && saved.owner === captured.owner) {
          const rows = saved.session.items.map((value) =>
            generatedItemKey(value) === key ? { ...value, ...updated, ...state } : value,
          )
          publish(saved.session.page, rows, context())
        }
        const current = currentRef.current
        if (
          captured.queryKey !== current.queryKey &&
          ((state.collected !== undefined && current.query.collectedOnly) ||
            (state.read !== undefined && current.query.unreadOnly))
        ) {
          // 用户在操作完成前切到过滤范围时，首次查询可能早于写入；重新读取这次显式查询。
          setRefreshVersion((value) => value + 1)
        }
      } catch {
        if (isOwnedMutation(captured, request)) setFailed(true)
      } finally {
        mutationsRef.current.delete(request)
        if (isOwnedMutation(captured, request)) setChanging(mutationsRef.current.size > 0)
      }
    },
    [view],
  )

  const selectItem = (item: GeneratedReaderItem) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      next.set("item", generatedItemKey(item))
      if (item.kind === "story") next.set("story", item.storyId)
      else next.delete("story")
      return next
    })
    if (!item.read) void mutateItem(item, { read: true })
  }
  const loadMore = async () => {
    const saved = sessionRef.current
    if (!saved?.session.page.nextCursor || loading || pagingRef.current) return
    // 分页改变页集合，旧poll即使返回同一snapshot也不能再覆盖新增页面。
    pageEpochRef.current++
    pollRef.current?.abort()
    pagingRef.current = true
    const cursor = saved.session.page.nextCursor
    const captured = context()
    const request = new AbortController()
    requestRef.current?.abort()
    requestRef.current = request
    setLoading(true)
    try {
      const next = await loadGeneratedFeedPage(
        { ...currentRef.current.query, snapshotId: saved.session.page.snapshotId, cursor },
        request.signal,
      )
      if (!isCurrent(captured, request)) return
      cursorsRef.current.push(cursor)
      const rows = appendGeneratedPage(saved.session.items, next.items).map((item) => ({
        ...item,
        ...readChangesRef.current.get(generatedItemKey(item)),
      }))
      publish(next, rows, captured)
    } catch {
      if (isCurrent(captured, request)) setFailed(true)
    } finally {
      if (isCurrent(captured, request)) {
        pagingRef.current = false
        setLoading(false)
        if (invalidationPendingRef.current) {
          invalidationPendingRef.current = false
          window.dispatchEvent(new Event("processing-reading-invalidated"))
        }
      }
    }
  }
  const mutationTarget =
    selected ??
    (storyId && visibleDeepState
      ? {
          kind: "story" as const,
          storyId,
          revision:
            visibleDeepState.link.kind === "current"
              ? visibleDeepState.link.revision.revision
              : undefined,
        }
      : null)
  const selectedRead = selected?.read ?? visibleDeepState?.read
  const selectedCollected = selected?.collected ?? visibleDeepState?.collected
  const pending = page?.counts
    ? page.counts.pending + page.counts.failed + page.counts.needsContext
    : 0

  // 账号切换的首帧也不能短暂显示上一个账号的阅读结果。
  if (pageContext.owner !== owner || pageContext.queryKey !== queryKey)
    return <p className="p-6 text-sm text-text-secondary">{t("processing.digest.loading")}</p>

  return (
    <div className="flex h-full min-w-0 flex-1" data-generated-reader={scope.mode}>
      <section className="flex w-[min(42%,420px)] min-w-72 shrink-0 flex-col border-r border-fill">
        <header className="space-y-3 border-b border-fill p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="font-semibold">{title ?? t("processing.generated.title")}</h1>
            <button
              className="rounded-md bg-fill-secondary px-2 py-1 text-xs"
              onClick={() => setRefreshVersion((value) => value + 1)}
              type="button"
            >
              {t(
                page?.latestAvailable
                  ? "processing.generated.apply_updates"
                  : "processing.generated.refresh",
              )}
            </button>
          </div>
          {scope.mode === "smart" && (
            <nav className="flex gap-2 text-xs" aria-label={t("processing.timeline_mode")}>
              <span aria-current="true">{t("processing.timeline_mode_processed")}</span>
              <button type="button" onClick={() => setContentMode("original")}>
                {t("processing.timeline_mode_original")}
              </button>
            </nav>
          )}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setSearch(searchDraft.trim())
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-md bg-fill-quaternary px-2 py-1 text-sm"
              aria-label={t("processing.generated.search")}
              placeholder={t("processing.generated.search")}
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
            <button type="submit" className="text-xs">
              {t("processing.generated.search")}
            </button>
          </form>
          <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
            <select
              aria-label={t("processing.generated.topic")}
              className="rounded bg-fill-quaternary px-1 py-1"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            >
              {topicOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {t(label)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(event) => setUnreadOnly(event.target.checked)}
              />
              {t("processing.generated.unread")}
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={collectedOnly}
                onChange={(event) => setCollectedOnly(event.target.checked)}
              />
              {t("processing.generated.collected")}
            </label>
          </div>
          <details className="text-xs text-text-secondary">
            <summary className="cursor-pointer">{t("processing.generated.apply_dates")}</summary>
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (dateDraft.since && dateDraft.until && dateDraft.since > dateDraft.until) return
                setSince(validDate(dateDraft.since))
                setUntil(validDate(dateDraft.until))
              }}
            >
              <input
                className="min-w-0 rounded bg-fill-quaternary px-1"
                type="date"
                aria-label={t("processing.generated.since")}
                value={dateDraft.since}
                max={dateDraft.until || undefined}
                onChange={(event) =>
                  setDateDraft((previous) => ({ ...previous, since: event.target.value }))
                }
              />
              <input
                className="min-w-0 rounded bg-fill-quaternary px-1"
                type="date"
                aria-label={t("processing.generated.until")}
                value={dateDraft.until}
                min={dateDraft.since || undefined}
                onChange={(event) =>
                  setDateDraft((previous) => ({ ...previous, until: event.target.value }))
                }
              />
              <button type="submit">{t("processing.generated.apply_dates")}</button>
            </form>
          </details>
          {pending > 0 && (
            <p className="text-xs text-text-secondary">
              {t("processing.generated.pending", { count: pending })}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setContentMode("original")
                  // 生成源没有原文模式，待处理材料回到现有全部原文时间线。
                  if (scope.mode === "stories") navigate("/timeline/all/all")
                }}
              >
                {t("processing.timeline_mode_original")}
              </button>
            </p>
          )}
        </header>
        <div
          className="min-h-0 flex-1 overflow-auto"
          ref={scrollRef}
          onScroll={(event) => {
            if (sessionRef.current)
              sessionRef.current.session.scrollTop = event.currentTarget.scrollTop
          }}
        >
          {failed && (
            <p role="alert" className="p-4 text-sm text-red">
              {t("processing.reader.error.request")}
            </p>
          )}
          {!loading && items.length === 0 && (
            <p className="p-4 text-sm text-text-secondary">{t("processing.generated.empty")}</p>
          )}
          <ul>
            {items.map((item) => (
              <li key={generatedItemKey(item)}>
                <button
                  type="button"
                  aria-current={selectedKey === generatedItemKey(item) ? "true" : undefined}
                  className={`w-full space-y-2 border-b border-fill px-4 py-3 text-left transition-colors hover:bg-fill-quaternary ${selectedKey === generatedItemKey(item) ? "bg-fill-secondary" : ""}`}
                  onClick={() => selectItem(item)}
                >
                  <div className={`text-sm ${item.read ? "text-text-secondary" : "font-semibold"}`}>
                    {item.title}
                  </div>
                  <p className="line-clamp-3 text-xs leading-5 text-text-secondary">
                    {item.summary}
                  </p>
                  <div className="flex flex-wrap gap-2 text-[11px] text-text-tertiary">
                    {(item.kind === "story" || item.materialCount > 1) && (
                      <span>
                        {t("processing.generated.material_count", { count: item.materialCount })}
                      </span>
                    )}
                    {item.kind === "story" && item.hasImportantUpdate && (
                      <span className="text-orange">
                        {t("processing.generated.important_update")}
                      </span>
                    )}
                    {item.collected && (
                      <i
                        className="i-mgc-star-cute-fi"
                        aria-label={t("processing.generated.collected")}
                      />
                    )}
                    <time dateTime={item.publishedAt}>
                      {new Date(item.publishedAt).toLocaleDateString()}
                    </time>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {loading && (
            <p className="p-4 text-sm text-text-secondary">{t("processing.digest.loading")}</p>
          )}
          {page?.nextCursor && (
            <button
              className="w-full p-4 text-sm"
              type="button"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {t("processing.generated.load_more")}
            </button>
          )}
        </div>
      </section>
      <section
        className="flex min-w-0 flex-1 flex-col"
        aria-label={t("processing.generated.content")}
      >
        {mutationTarget && (
          <div className="flex gap-3 border-b border-fill px-5 py-3 text-xs">
            <button
              type="button"
              disabled={changing}
              onClick={() => void mutateItem(mutationTarget, { read: !selectedRead })}
            >
              {t(
                selectedRead
                  ? "processing.generated.mark_unread"
                  : "processing.generated.mark_read",
              )}
            </button>
            <button
              type="button"
              disabled={changing}
              onClick={() => void mutateItem(mutationTarget, { collected: !selectedCollected })}
            >
              {t(
                selectedCollected
                  ? "processing.generated.uncollect"
                  : "processing.generated.collect",
              )}
            </button>
          </div>
        )}
        {selected?.kind === "entry" && (
          <GeneratedEntryControls
            key={`${owner}:${selected.inputSeq}`}
            inputSeq={selected.inputSeq}
          />
        )}
        {storyId ? (
          <div className="min-h-0 flex-1 overflow-auto p-6">
            {visibleDeepState?.link.kind === "merged" ? (
              <a
                className="text-accent underline"
                href={`/events?story=${encodeURIComponent(visibleDeepState.link.mergedInto)}`}
              >
                {t("processing.generated.choose")}
              </a>
            ) : visibleDeepState?.link.kind === "split" ? (
              visibleDeepState.link.splitInto.map((id) => (
                <a
                  className="mr-3 text-accent underline"
                  key={id}
                  href={`/events?story=${encodeURIComponent(id)}`}
                >
                  {t("processing.generated.choose")}
                </a>
              ))
            ) : (
              <StoryDigestPanel
                key={`${owner}:${storyId}`}
                storyId={storyId}
                revision={selected?.kind === "story" ? selected.revision : undefined}
                embedded
              />
            )}
            <button
              className="mt-5 text-xs text-text-secondary"
              type="button"
              onClick={() => setToolsOpen((value) => !value)}
            >
              {t("processing.generated.tools")}
            </button>
            {toolsOpen && (
              <div className="mt-3 space-y-4">
                <InformationIntegration storyId={storyId} />
                <ResearchPanel
                  target={{ kind: "story", storyId }}
                  targetTitle={selected?.title ?? title ?? ""}
                />
              </div>
            )}
          </div>
        ) : selected?.kind === "entry" ? (
          <EntryContent entryId={selected.id} className="h-full" />
        ) : (
          <p className="m-auto p-6 text-sm text-text-secondary">
            {t("processing.generated.choose")}
          </p>
        )}
      </section>
    </div>
  )
}
