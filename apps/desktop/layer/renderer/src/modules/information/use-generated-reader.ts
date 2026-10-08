import { FeedViewType } from "@follow/constants"
import { isEntryStarred } from "@follow/store/collection/getter"
import { collectionActions, collectionSyncService } from "@follow/store/collection/store"
import { getEntry } from "@follow/store/entry/getter"
import { entryActions, entrySyncServices } from "@follow/store/entry/store"
import { getSubscriptionByEntryId } from "@follow/store/subscription/getter"
import { unreadSyncService } from "@follow/store/unread/store"
import { useWhoami } from "@follow/store/user/hooks"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router"

import { setGeneralSetting, useGeneralSettingKey } from "~/atoms/settings/general"
import { navigateEntry } from "~/hooks/biz/useNavigateEntry"
import { useRouterRouteParams } from "~/hooks/biz/useRouteParams"

import type {
  GeneratedEntryState,
  GeneratedFeedPage,
  GeneratedFeedQuery,
  GeneratedReaderItem,
  GeneratedStoryState,
} from "./generated-feed-client"
import {
  appendGeneratedPage,
  generatedItemKey,
  loadGeneratedEntryState,
  loadGeneratedFeedPage,
  loadGeneratedStoryState,
  locateGeneratedReaderTarget,
  setGeneratedStoryState,
} from "./generated-feed-client"
import type { ReaderSession } from "./generated-feed-session"
import {
  readerSession,
  saveReaderSession,
  updateOriginalReaderSessions,
  updateReaderSessions,
} from "./generated-feed-session"
import type { ReaderTarget } from "./reader-target"
import {
  readerItemMatchesTarget,
  readReaderTarget,
  storyReaderLocation,
  validReaderDate,
} from "./reader-target"

type ReadingContext = { owner: string | null; queryKey: string; epoch: number }
export type GeneratedReaderScope = Pick<
  GeneratedFeedQuery,
  "mode" | "sourceKeys" | "category" | "collectedOnly" | "view"
>
export type GeneratedReaderOptions = {
  enabled: boolean
  scope: GeneratedReaderScope
  /** 普通全部列表叠加综述，官方条目仍由原有 SDK 查询提供。 */
  nativeTimeline?: boolean
}
export type ReaderMutationTarget = GeneratedReaderItem | Extract<ReaderTarget, { kind: "story" }>

/** 原生阅读器共享的投影模型：界面只消费状态，查询、快照和异步归属集中维护。 */
export function useGeneratedReader({
  enabled,
  scope,
  nativeTimeline = false,
}: GeneratedReaderOptions) {
  const owner = useWhoami()?.id ?? null
  const route = useRouterRouteParams()
  const { view } = route
  // 已读过滤直接消费原生偏好，AI 模式不再维护第二套 aiUnread 状态。
  const unreadOnly = useGeneralSettingKey("unreadOnly")
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  // URL 是搜索范围的唯一来源，浏览器前进后退会恢复同一组筛选。
  const search = params.get("aiSearch") ?? ""
  const topic = params.get("aiTopic") ?? ""
  const collectedOnly = params.get("aiCollected") === "true"
  const since = validReaderDate(params.get("aiSince") ?? "")
  const until = validReaderDate(params.get("aiUntil") ?? "")
  const [deepState, setDeepState] = useState<GeneratedStoryState | null>(null)
  const [entryState, setEntryState] = useState<GeneratedEntryState | null>(null)
  const deepEntryRef = useRef<GeneratedEntryState | null>(null)
  const [deepLoading, setDeepLoading] = useState(false)
  const [page, setPage] = useState<GeneratedFeedPage | null>(null)
  const [pageVersion, setPageVersion] = useState(0)
  const [pageContext, setPageContext] = useState({ owner, queryKey: "" })
  const [deepOwner, setDeepOwner] = useState(owner)
  const [items, setItems] = useState<GeneratedReaderItem[]>([])
  const [loading, setLoading] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [changing, setChanging] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const requestRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listScrollRef = useRef<((index: number) => void) | null>(null)
  const epochRef = useRef(0)
  const pageEpochRef = useRef(0)
  const pagingRef = useRef(false)
  const invalidationPendingRef = useRef(false)
  const pollRef = useRef<AbortController | null>(null)
  const mutationsRef = useRef(new Set<AbortController>())
  const mutationVersionRef = useRef(0)
  const entryStateVersionRef = useRef(0)
  const hydrationAttemptsRef = useRef(new Set<string>())
  const seededOriginalStateRef = useRef(new Set<string>())
  const hydrationInFlightRef = useRef(new Map<string, Promise<unknown>>())
  const sdkOriginalStateRef = useRef(
    new Map<string, { read: boolean | undefined; collected: boolean }>(),
  )
  const locateRequestRef = useRef<AbortController | null>(null)
  const [locating, setLocating] = useState(false)
  const locateAttemptsRef = useRef(new Set<string>())
  const legacyNormalizedRef = useRef<string | null>(null)
  const [hydrating, setHydrating] = useState(false)
  const [hydrationVersion, setHydrationVersion] = useState(0)
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
  const itemChanges = useCallback(
    (item: GeneratedReaderItem) => ({
      ...readChangesRef.current.get(generatedItemKey(item)),
      ...(item.kind === "entry" ? readChangesRef.current.get(`original:${item.id}`) : {}),
    }),
    [],
  )
  const query = useMemo<GeneratedFeedQuery>(
    () => ({
      ...scope,
      // 普通列表使用原生搜索语义，旧 AI 范围参数不能只过滤其中的综述来源。
      search: nativeTimeline ? "" : search,
      topic: nativeTimeline ? "" : topic,
      unreadOnly: scope.mode === "collections" ? false : unreadOnly,
      collectedOnly:
        scope.mode === "collections" || scope.collectedOnly || (!nativeTimeline && collectedOnly),
      since: !nativeTimeline && since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
      until:
        !nativeTimeline && until && (!since || until >= since)
          ? new Date(`${until}T23:59:59.999`).toISOString()
          : undefined,
      limit: 30,
    }),
    [scope, search, topic, unreadOnly, collectedOnly, since, until, nativeTimeline],
  )
  const queryKey = JSON.stringify(query)
  const target = readReaderTarget(route.entryId, params)
  const storyId = target?.kind === "story" ? target.storyId : null
  const targetEntryId = target?.kind === "entry" ? target.entryId : null
  const currentRef = useRef({ query, owner, queryKey, storyId, targetEntryId, enabled })
  currentRef.current = { query, owner, queryKey, storyId, targetEntryId, enabled }
  const visibleDeepState = deepOwner === owner && deepState?.storyId === storyId ? deepState : null
  const visibleEntryState =
    deepOwner === owner && entryState?.entryId === targetEntryId ? entryState : null
  deepEntryRef.current = visibleEntryState
  const pageVisible = pageContext.owner === owner && pageContext.queryKey === queryKey
  const visibleItems = useMemo(() => (pageVisible ? items : []), [pageVisible, items])
  const selected =
    visibleItems.find((item) => readerItemMatchesTarget(item, target)) ??
    visibleEntryState?.item ??
    undefined
  const context = () => ({
    owner: currentRef.current.owner,
    queryKey: currentRef.current.queryKey,
    epoch: epochRef.current,
  })
  const isCurrent = (captured: ReadingContext, request: AbortController) =>
    !request.signal.aborted &&
    currentRef.current.enabled &&
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
  const publish = useCallback(
    (next: GeneratedFeedPage, rows: GeneratedReaderItem[], captured: ReadingContext) => {
      if (!captured.owner) return
      sessionRef.current = {
        owner: captured.owner,
        queryKey: captured.queryKey,
        session: {
          page: next,
          items: rows.map((item) => ({
            ...item,
            ...itemChanges(item),
          })),
          cursors: [...cursorsRef.current],
          scrollTop: scrollRef.current?.scrollTop ?? 0,
          readChanges: [...readChangesRef.current],
        },
      }
      setPageContext({ owner: captured.owner, queryKey: captured.queryKey })
      setPage(next)
      setItems(sessionRef.current.session.items)
      setPageVersion((value) => value + 1)
    },
    [itemChanges],
  )

  useEffect(() => {
    const mutations = mutationsRef.current
    readChangesRef.current.clear()
    hydrationAttemptsRef.current.clear()
    seededOriginalStateRef.current.clear()
    sdkOriginalStateRef.current.clear()
    locateAttemptsRef.current.clear()
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
    if (!enabled || !storyId || !owner) return
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
  }, [enabled, storyId, owner, queryKey])

  useEffect(() => {
    epochRef.current++
    pageEpochRef.current++
    pagingRef.current = false
    invalidationPendingRef.current = false
    const request = new AbortController()
    requestRef.current?.abort()
    pollRef.current?.abort()
    locateRequestRef.current?.abort()
    requestRef.current = request
    const captured = context()
    const epoch = epochRef
    setFailed(false)
    setPageContext({ owner, queryKey })
    const previous = previousRequestRef.current
    if (!enabled) {
      setLoading(false)
      // 关闭 AI 仍刷新账号归属，退出账号会清空内存会话。
      readerSession(owner, queryKey)
      return () => {
        request.abort()
        epoch.current++
      }
    }
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
      setPageVersion((value) => value + 1)
      setItems(
        cached.items.map((item) => ({
          ...item,
          ...itemChanges(item),
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
      locateRequestRef.current?.abort()
      epoch.current++
    }
  }, [enabled, queryKey, owner, refreshVersion, publish, itemChanges])

  useEffect(() => {
    if (
      !enabled ||
      !targetEntryId ||
      !params.has("item") ||
      (route.entryId && route.entryId !== "pending")
    )
      return
    const legacyKey = `${owner}:${location.pathname}:${location.search}`
    if (legacyNormalizedRef.current === legacyKey) return
    legacyNormalizedRef.current = legacyKey
    // 旧原文深链仅规范一次，replace 避免后退再次落入兼容地址。
    const search = new URLSearchParams(params)
    search.delete("item")
    search.delete("story")
    const path = location.pathname.startsWith("/timeline/")
      ? `${location.pathname.split("/").slice(0, 4).join("/")}/${encodeURIComponent(targetEntryId)}`
      : `/timeline/all/all/${encodeURIComponent(targetEntryId)}`
    void navigate({ pathname: path, search: search.size ? `?${search}` : "" }, { replace: true })
  }, [enabled, targetEntryId, params, route.entryId, owner, location, navigate])

  useEffect(() => {
    const entryVersion = ++entryStateVersionRef.current
    setEntryState(null)
    setDeepOwner(owner)
    setDeepLoading(Boolean(enabled && targetEntryId && owner))
    if (!enabled || !targetEntryId || !owner) return
    const request = new AbortController()
    const captured = context()
    // 深链原文直接读取处理状态，正文不依赖首批分页是否包含该条目。
    void loadGeneratedEntryState(targetEntryId, request.signal)
      .then((state) => {
        if (
          isCurrent(captured, request) &&
          entryVersion === entryStateVersionRef.current &&
          currentRef.current.targetEntryId === targetEntryId
        )
          setEntryState({
            ...state,
            item: state.item ? { ...state.item, ...itemChanges(state.item) } : null,
          })
      })
      .catch(() => {
        if (isCurrent(captured, request) && entryVersion === entryStateVersionRef.current)
          setEntryState(null)
      })
      .finally(() => {
        if (isCurrent(captured, request) && entryVersion === entryStateVersionRef.current)
          setDeepLoading(false)
      })
    return () => request.abort()
  }, [enabled, targetEntryId, owner, queryKey, refreshVersion, itemChanges])

  useEffect(() => {
    if (!enabled || !owner) return
    let cancelled = false
    const originals = visibleItems.filter((item) => item.kind === "entry")
    const queue: Array<{
      id: string
      inbox: boolean
      projected?: Extract<GeneratedReaderItem, { kind: "entry" }>
    }> = originals.map((item) => ({
      id: item.id,
      inbox: item.sourceKey.startsWith("inbox/"),
      projected: item,
    }))
    if (targetEntryId && !queue.some((item) => item.id === targetEntryId))
      queue.unshift({
        id: targetEntryId,
        inbox:
          route.inboxId !== undefined ||
          (visibleEntryState?.item?.kind === "entry" &&
            visibleEntryState.item.sourceKey.startsWith("inbox/")),
        projected: visibleEntryState?.item?.kind === "entry" ? visibleEntryState.item : undefined,
      })
    const missing = queue.filter(
      (item) => !getEntry(item.id) && !hydrationAttemptsRef.current.has(`${owner}:${item.id}`),
    )
    if (!missing.length) return
    setHydrating(true)
    // 仅用官方详情接口补齐作者、媒体和正文，最多同时请求三个条目且不触发模型。
    const worker = async () => {
      while (!cancelled && currentRef.current.owner === owner && currentRef.current.enabled) {
        // 翻页或深链变更时，上一批已发出的官方请求仍占用并发槽位。
        if (hydrationInFlightRef.current.size >= 3) {
          await Promise.race(
            [...hydrationInFlightRef.current.values()].map((request) =>
              request.catch(() => undefined),
            ),
          )
          continue
        }
        const item = missing.shift()
        if (!item) break
        const key = `${owner}:${item.id}`
        hydrationAttemptsRef.current.add(key)
        const request = entrySyncServices.fetchEntryDetail(item.id, item.inbox)
        hydrationInFlightRef.current.set(key, request)
        try {
          await request
          if (!cancelled && currentRef.current.owner === owner) {
            const projected = item.projected
            const original = getEntry(item.id)
            const read = projected ? (itemChanges(projected)?.read ?? projected.read) : null
            // 详情接口的 read 默认值不代表实际读态；新补齐原文采用官方投影的已知读态。
            if (original && typeof read === "boolean")
              entryActions.markEntryReadStatusInSession({ entryIds: [item.id], read })
          }
        } catch {
          /* 单条缺失保留可重试入口，不让整页失效。 */
        } finally {
          hydrationInFlightRef.current.delete(key)
          // scope 或深链变更取消队列后，已发出的详情仍可能补入 store，需要再次同步元数据。
          if (currentRef.current.owner === owner) setHydrationVersion((value) => value + 1)
        }
      }
    }
    void Promise.all([worker(), worker(), worker()]).finally(() => {
      if (!cancelled && currentRef.current.owner === owner) setHydrating(false)
    })
    return () => {
      cancelled = true
      setHydrating(false)
    }
  }, [
    enabled,
    owner,
    visibleItems,
    targetEntryId,
    route.inboxId,
    visibleEntryState,
    refreshVersion,
    itemChanges,
  ])

  useEffect(() => {
    if (!enabled || !owner) return
    const originals = [
      ...visibleItems,
      ...(visibleEntryState?.item ? [visibleEntryState.item] : []),
    ].filter((item) => item.kind === "entry")
    for (const item of originals) {
      const original = getEntry(item.id)
      if (!original) continue
      const hydrationKey = `${owner}:${item.id}`
      if (
        hydrationAttemptsRef.current.has(hydrationKey) &&
        !seededOriginalStateRef.current.has(hydrationKey)
      ) {
        const read = itemChanges(item)?.read ?? item.read
        if (typeof read === "boolean")
          entryActions.markEntryReadStatusInSession({ entryIds: [item.id], read })
        seededOriginalStateRef.current.add(hydrationKey)
      }
      if (item.collected !== true || isEntryStarred(item.id)) continue
      const view = item.view ?? getSubscriptionByEntryId(item.id)?.view ?? route.view
      if (view === FeedViewType.All) continue
      // 直接补齐官方收藏响应的本地缓存，不调用 star API，也不伪造历史收藏时间。
      collectionActions.upsertManyInSession([
        { entryId: item.id, feedId: original.feedId, view, createdAt: item.collectedAt ?? null },
      ])
    }
  }, [
    enabled,
    owner,
    visibleItems,
    visibleEntryState,
    hydrating,
    hydrationVersion,
    route.view,
    itemChanges,
  ])

  useEffect(() => {
    const saved = sessionRef.current
    const targetKey = storyId ? `story:${storyId}` : targetEntryId ? `entry:${targetEntryId}` : null
    if (
      !enabled ||
      // 混合列表只能连续分页；跳到 Story 后段不能替换原有前缀和官方时间水位。
      nativeTimeline ||
      !owner ||
      !targetKey ||
      !saved ||
      saved.owner !== owner ||
      saved.queryKey !== queryKey ||
      pagingRef.current
    )
      return
    const target: ReaderTarget = storyId
      ? { kind: "story", storyId }
      : { kind: "entry", entryId: targetEntryId! }
    if (saved.session.items.some((item) => readerItemMatchesTarget(item, target))) return
    const attemptKey = `${owner}:${queryKey}:${saved.session.page.snapshotId}:${targetKey}`
    if (locateAttemptsRef.current.has(attemptKey)) return
    locateAttemptsRef.current.add(attemptKey)
    const request = new AbortController()
    locateRequestRef.current?.abort()
    locateRequestRef.current = request
    const captured = context()
    const savedScroll = scrollRef.current?.scrollTop ?? saved.session.scrollTop
    pagingRef.current = true
    pageEpochRef.current++
    pollRef.current?.abort()
    setLocating(true)
    setLoading(true)
    void (async () => {
      try {
        const result = await locateGeneratedReaderTarget(
          target.kind === "story" ? { storyId: target.storyId } : { entryId: target.entryId },
          { ...currentRef.current.query, snapshotId: saved.session.page.snapshotId },
          request.signal,
        )
        if (!isCurrent(captured, request) || !result.target) return
        const located = result.target
        const cursors =
          located.cursor === null
            ? [undefined]
            : [located.previousCursor ?? undefined, located.cursor]
        // 只取目标页及前一页，深历史链接无需扫描全部历史仍有正确的前后条目。
        const pages = await Promise.all(
          cursors.map((cursor) =>
            loadGeneratedFeedPage(
              { ...currentRef.current.query, snapshotId: located.snapshotId, cursor },
              request.signal,
            ),
          ),
        )
        if (!isCurrent(captured, request)) return
        cursorsRef.current = cursors
        const rows = pages.reduce<GeneratedReaderItem[]>(
          (all, page) => appendGeneratedPage(all, page.items),
          [],
        )
        publish(pages.at(-1)!, rows, captured)
        requestAnimationFrame(() => {
          if (
            captured.owner !== currentRef.current.owner ||
            captured.queryKey !== currentRef.current.queryKey ||
            captured.epoch !== epochRef.current ||
            !currentRef.current.enabled
          )
            return
          const index = rows.findIndex((item) => readerItemMatchesTarget(item, target))
          if (index >= 0 && listScrollRef.current) listScrollRef.current(index)
          else if (scrollRef.current) scrollRef.current.scrollTop = savedScroll
          saveSession(owner, queryKey)
        })
      } catch {
        if (isCurrent(captured, request)) setFailed(true)
      } finally {
        if (isCurrent(captured, request)) {
          pagingRef.current = false
          setLocating(false)
          setLoading(false)
          if (invalidationPendingRef.current) {
            invalidationPendingRef.current = false
            window.dispatchEvent(new Event("processing-reading-invalidated"))
          }
        }
      }
    })()
    return () => {
      if (locateRequestRef.current === request) {
        locateRequestRef.current = null
        pagingRef.current = false
        setLocating(false)
        setLoading(false)
      }
      request.abort()
    }
  }, [enabled, nativeTimeline, owner, queryKey, pageVersion, targetEntryId, storyId, publish])

  useEffect(() => {
    if (!enabled) return
    const poll = async (refreshStory = false) => {
      const saved = sessionRef.current
      if (
        !saved ||
        !currentRef.current.enabled ||
        pagingRef.current ||
        document.visibilityState === "hidden"
      )
        return
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
        const activeEntry = currentRef.current.targetEntryId
        // 人工纠错读回的新状态优先于更早发出的深链状态请求。
        const entryVersion =
          refreshStory && activeEntry
            ? ++entryStateVersionRef.current
            : entryStateVersionRef.current
        const [responses, state, nextEntryState] = await Promise.all([
          pages,
          refreshStory && activeStory
            ? loadGeneratedStoryState(activeStory, request.signal)
            : Promise.resolve(null),
          refreshStory && activeEntry
            ? loadGeneratedEntryState(activeEntry, request.signal)
            : Promise.resolve(null),
        ])
        if (!isCurrent(captured, request) || pageEpoch !== pageEpochRef.current) return
        const result = responses.at(-1)!
        if (state && currentRef.current.storyId === activeStory) {
          setDeepOwner(captured.owner)
          setDeepState({ ...state, ...readChangesRef.current.get(`story:${activeStory}`) })
        }
        if (
          nextEntryState &&
          currentRef.current.targetEntryId === activeEntry &&
          entryVersion === entryStateVersionRef.current
        ) {
          setDeepOwner(captured.owner)
          setEntryState({
            ...nextEntryState,
            item: nextEntryState.item
              ? {
                  ...nextEntryState.item,
                  ...itemChanges(nextEntryState.item),
                }
              : null,
          })
          setDeepLoading(false)
        }
        // 当前快照只接纳人工纠错；轮询到后台新决定时只更新可应用提示。
        if (sessionRef.current?.session.page.snapshotId !== result.snapshotId) return
        const rows = responses
          .reduce<GeneratedReaderItem[]>(
            (all, response) => appendGeneratedPage(all, response.items),
            [],
          )
          .map((item) => ({ ...item, ...itemChanges(item) }))
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
        if (refreshStory && isCurrent(captured, request)) setDeepLoading(false)
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
  }, [enabled, publish, itemChanges])

  const mutateItem = useCallback(
    async (item: ReaderMutationTarget, state: { read?: boolean; collected?: boolean }) => {
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
              item.view ??
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
        if (item.kind === "entry") {
          readChangesRef.current.set(`original:${item.id}`, {
            ...readChangesRef.current.get(`original:${item.id}`),
            ...state,
          })
          updateOriginalReaderSessions(captured.owner, item.id, state)
        } else updateReaderSessions(captured.owner, key, state)
        if (item.kind === "entry" && currentRef.current.targetEntryId === item.id) {
          setEntryState((previous) =>
            previous?.entryId === item.id && previous.item
              ? { ...previous, item: { ...previous.item, ...state } }
              : previous,
          )
        }
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
    [view, publish],
  )

  const selectItem = (item: GeneratedReaderItem) => {
    if (item.kind === "story")
      void navigate(storyReaderLocation(location.pathname, params, item.storyId))
    else navigateEntry({ entryId: item.id })
    // Story 正文返回后才确认已读，避免打开瞬间吞掉“自上次阅读以来”的比较基线。
    if (item.kind === "entry" && !item.read) void mutateItem(item, { read: true })
  }
  const loadMore = async () => {
    const saved = sessionRef.current
    if (!enabled || !saved?.session.page.nextCursor || loading || pagingRef.current) return
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
        ...itemChanges(item),
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
  const syncOriginalState = useCallback(
    (item: Extract<GeneratedReaderItem | ReaderTarget, { kind: "entry" }>) => {
      const captured = context()
      const entryId = "entryId" in item ? item.entryId : item.id
      const original = getEntry(entryId)
      // 原生正文和行共享真实身份，账号切换后的旧回调不能给新账号保存状态。
      if (!captured.owner || captured.owner !== owner || !original) return
      const state = {
        read: typeof original.read === "boolean" ? original.read : undefined,
        collected: isEntryStarred(entryId),
      }
      const key = `original:${entryId}`
      const previous = sdkOriginalStateRef.current.get(key)
      sdkOriginalStateRef.current.set(key, state)
      // 首次渲染只建立 SDK 基线，尚未 hydrate 的 false 不能覆盖官方投影中的 true。
      if (!previous) return
      const changed = {
        ...(state.read !== undefined && previous.read !== state.read ? { read: state.read } : {}),
        ...(previous.collected !== state.collected ? { collected: state.collected } : {}),
      }
      if (Object.keys(changed).length === 0) return
      readChangesRef.current.set(key, { ...readChangesRef.current.get(key), ...changed })
      updateOriginalReaderSessions(captured.owner, entryId, changed)
      const saved = sessionRef.current
      const rowChanged = saved?.session.items.some(
        (value) =>
          value.kind === "entry" &&
          value.id === entryId &&
          ((changed.read !== undefined && changed.read !== value.read) ||
            (changed.collected !== undefined && changed.collected !== value.collected)),
      )
      const deepItem = deepEntryRef.current?.entryId === entryId ? deepEntryRef.current.item : null
      const deepChanged =
        deepItem &&
        ((changed.read !== undefined && changed.read !== deepItem.read) ||
          (changed.collected !== undefined && changed.collected !== deepItem.collected))
      if (!rowChanged && !deepChanged) return
      mutationVersionRef.current++
      // 首批之外的正文操作只更新深链状态，不能把无关第一页换成新快照或打断定位。
      if (rowChanged && saved?.owner === captured.owner && saved.queryKey === captured.queryKey)
        publish(
          saved.session.page,
          saved.session.items.map((value) =>
            value.kind === "entry" && value.id === entryId ? { ...value, ...changed } : value,
          ),
          captured,
        )
      if (deepChanged)
        setEntryState((previous) =>
          previous?.entryId === entryId && previous.item
            ? { ...previous, item: { ...previous.item, ...changed } }
            : previous,
        )
    },
    [owner, publish],
  )
  const locateTarget = async () => {
    if (
      !enabled ||
      !target ||
      !owner ||
      currentRef.current.owner !== owner ||
      currentRef.current.queryKey !== queryKey
    )
      return null
    const request = new AbortController()
    const captured = context()
    const result = await locateGeneratedReaderTarget(
      target.kind === "entry" ? { entryId: target.entryId } : { storyId: target.storyId },
      { ...query, snapshotId: page?.snapshotId },
      request.signal,
    )
    return isCurrent(captured, request) ? result.target : null
  }
  const setFilter = (key: string, value: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      value ? next.set(key, value) : next.delete(key)
      return next
    })
  return {
    active: enabled,
    nativeTimeline,
    owner,
    scope,
    query,
    queryKey,
    target,
    selected,
    storyId,
    deepState: visibleDeepState,
    entryState: visibleEntryState,
    deepLoading,
    mutationTarget,
    selectedRead,
    selectedCollected,
    page: pageVisible ? page : null,
    hasNextPage: pageVisible && !!page?.nextCursor,
    items: visibleItems,
    loading: enabled && (loading || !pageVisible),
    // 分页与整页刷新分开，加载旧条目不能触发原生列表回顶。
    isFetchingNextPage: pagingRef.current,
    failed,
    changing,
    hydrating,
    locating,
    counts: pageVisible ? page?.counts : undefined,
    selectItem,
    mutateItem,
    syncOriginalState,
    locateTarget,
    loadMore,
    refresh: () => {
      hydrationAttemptsRef.current.clear()
      setRefreshVersion((value) => value + 1)
    },
    search,
    topic,
    unreadOnly,
    collectedOnly,
    since,
    until,
    setSearch: (value: string) => setFilter("aiSearch", value.trim()),
    setTopic: (value: string) => setFilter("aiTopic", value),
    setUnreadOnly: (value: boolean) => setGeneralSetting("unreadOnly", value),
    setCollectedOnly: (value: boolean) => setFilter("aiCollected", value ? "true" : ""),
    setSince: (value: string) => setFilter("aiSince", validReaderDate(value)),
    setUntil: (value: string) => setFilter("aiUntil", validReaderDate(value)),
    setDates: (value: { since: string; until: string }) =>
      setParams((previous) => {
        const next = new URLSearchParams(previous)
        const start = validReaderDate(value.since)
        const end = validReaderDate(value.until)
        if (start && end && start > end) return previous
        start ? next.set("aiSince", start) : next.delete("aiSince")
        end ? next.set("aiUntil", end) : next.delete("aiUntil")
        return next
      }),
    scrollRef,
    listScrollRef,
    saveScroll: () => saveSession(owner, queryKey),
  }
}

export type GeneratedReader = ReturnType<typeof useGeneratedReader>
