import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getOneTimeToken, isLocalFoloHost } from "../ai-chat/local-provider"
import { createProcessingClient, ProcessingRequestError } from "./processing-client"
import { processingFeedSourceKey } from "./processing-tags-utils"

const client = createProcessingClient(getOneTimeToken)

type FeedSubscriptionTag = { id: string; name: string }

/**
 * 「编辑订阅」弹窗里的私人订阅标签，做成交互式多选（类似 Notion 的多选属性）：
 * 已选项以 chip 呈现，输入框可过滤已有标签，也能**就地创建**新标签。
 *
 * 写入的是本机信息服务的 `source-tags`，与「设置 → 订阅源」的「我的标签」列、
 * 「Actions → 我的处理服务 → 私人订阅标签」读写同一份数据（都以 `feed/<id>` 为 source key）。
 *
 * 标签即时生效，不参与外层表单的保存流程。
 */
export function FeedSubscriptionTags({ feedId }: { feedId: string }) {
  const { t } = useTranslation("app")
  // 官方站没有本机信息服务路由，整块 UI 只在 local.folo.is 开启（与订阅源设置页同一门禁）。
  const enabled = isLocalFoloHost()
  const sourceKey = processingFeedSourceKey(feedId)

  const [tags, setTags] = useState<FeedSubscriptionTag[]>([])
  const [tagIds, setTagIds] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ProcessingRequestError["kind"] | null>(null)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  const read = useCallback(
    async (signal: AbortSignal) => {
      const editor = await client.load(signal)
      if (signal.aborted) return
      // 服务端快照是唯一真相，前端不维护第二份标签状态。
      setTags(editor.subscriptionTags.tags.map((tag) => ({ id: tag.id, name: tag.name })))
      setRevision(editor.subscriptionTags.revision)
      setTagIds(editor.sourceTags.find((binding) => binding.sourceKey === sourceKey)?.tagIds ?? [])
      setError(null)
      setLoading(false)
    },
    [sourceKey],
  )

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    void read(controller.signal).catch((cause) => {
      if (controller.signal.aborted) return
      setError(cause instanceof ProcessingRequestError ? cause.kind : "request")
      setLoading(false)
    })
    return () => controller.abort()
  }, [enabled, read])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  /** 所有写入都走这里：先乐观更新本地，失败回滚，成功后以服务端快照为准。 */
  const run = useCallback(
    async (operation: (signal: AbortSignal) => Promise<unknown>, rollback: () => void) => {
      const controller = new AbortController()
      controllerRef.current = controller
      setBusy(true)
      setError(null)
      try {
        await operation(controller.signal)
        await read(controller.signal)
      } catch (cause) {
        if (controller.signal.aborted) return
        rollback()
        setError(cause instanceof ProcessingRequestError ? cause.kind : "request")
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    },
    [read],
  )

  const toggleTag = useCallback(
    (tagId: string, checked: boolean) => {
      // 写入用服务端最新 revision，避免与其它窗口并发写冲突。
      setTagIds((current) =>
        checked ? [...new Set([...current, tagId])] : current.filter((id) => id !== tagId),
      )
      void run(
        (signal) =>
          client.bindTags([sourceKey], [tagId], checked ? "add" : "remove", revision, signal),
        () =>
          setTagIds((current) =>
            checked ? current.filter((id) => id !== tagId) : [...new Set([...current, tagId])],
          ),
      )
    },
    [revision, run, sourceKey],
  )

  const createTag = useCallback(
    (name: string) => {
      setQuery("")
      // 回滚要恢复的三样：标签集、绑定、revision。
      const before = { tags, tagIds, revision }
      let bound = false
      void run(
        async (signal) => {
          const created = await client.createTag(name, revision, signal)
          const known = new Set(tags.map((tag) => tag.id))
          const fresh = created.tags.find((tag) => !known.has(tag.id))
          if (!fresh) throw new ProcessingRequestError("invalid")
          // createTag 返回的快照本身就是权威标签集，先按它把 chip 画出来。
          // 实测这一步之后还有「换凭据 + 绑定 + 换凭据 + 重读快照」约 4.6s，
          // 等重读完再显示会让用户对着被禁用的输入框干等。
          setTags(created.tags.map((tag) => ({ id: tag.id, name: tag.name })))
          setRevision(created.revision)
          setTagIds((current) => [...new Set([...current, fresh.id])])
          // 绑定用创建后返回的新 revision，否则服务端判冲突。
          await client.bindTags([sourceKey], [fresh.id], "add", created.revision, signal)
          bound = true
        },
        () => {
          // 只有「创建 / 绑定」本身失败才回滚。若绑定已成功、只是随后重读快照失败，
          // 写入其实已经落库，回滚等于把用户刚建好的标签藏起来。
          if (bound) return
          setTags(before.tags)
          setTagIds(before.tagIds)
          setRevision(before.revision)
        },
      )
    },
    [revision, run, sourceKey, tagIds, tags],
  )

  const selectedTags = useMemo(
    () => tagIds.map((id) => tags.find((tag) => tag.id === id)).filter((tag) => !!tag),
    [tagIds, tags],
  )
  const trimmedQuery = query.trim()
  const matchedTags = useMemo(() => {
    if (!trimmedQuery) return tags
    const needle = trimmedQuery.toLowerCase()
    return tags.filter((tag) => tag.name.toLowerCase().includes(needle))
  }, [tags, trimmedQuery])
  // 同名标签已存在时不再给「创建」，避免建出重名项。
  const canCreate =
    trimmedQuery.length > 0 &&
    !tags.some((tag) => tag.name.toLowerCase() === trimmedQuery.toLowerCase())

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      if (canCreate) createTag(trimmedQuery)
      else if (matchedTags.length === 1) {
        const only = matchedTags[0]!
        toggleTag(only.id, !tagIds.includes(only.id))
      }
    } else if (event.key === "Escape") {
      setOpen(false)
    } else if (event.key === "Backspace" && !query && selectedTags.length > 0) {
      toggleTag(selectedTags.at(-1)!.id, false)
    }
  }

  if (!enabled) return null

  const showList = open && !loading
  const showEmptyHint = showList && matchedTags.length === 0 && !canCreate

  return (
    <div data-testid="feed-form-processing-tags">
      <p className="text-sm font-medium text-text">{t("processing.tags")}</p>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        {t("processing.tags_form_hint")}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red">
          {t(`processing.error.${error}`)}
        </p>
      )}

      <div ref={rootRef} className="relative mt-3">
        <div
          className="flex min-h-9 cursor-text flex-wrap items-center gap-1 rounded-md border border-fill-secondary bg-fill-quinary px-2 py-1"
          onClick={() => inputRef.current?.focus()}
        >
          {selectedTags.map((tag) => (
            <span
              key={tag.id}
              data-testid="feed-form-processing-tag-chip"
              className="flex items-center gap-1 rounded bg-fill-secondary px-1.5 py-0.5 text-xs text-text"
            >
              {tag.name}
              <button
                type="button"
                aria-label={t("processing.tags_form_remove_chip", { name: tag.name })}
                className="text-text-secondary hover:text-text"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleTag(tag.id, false)
                }}
              >
                <i className="i-mgc-close-cute-re size-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            data-testid="feed-form-processing-tags-input"
            className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-text-secondary"
            aria-label={t("processing.tags_form_placeholder")}
            placeholder={selectedTags.length > 0 ? "" : t("processing.tags_form_placeholder")}
            value={query}
            disabled={loading || busy}
            onChange={(event) => {
              setQuery(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {showList && (
          <ul
            data-testid="feed-form-processing-tags-options"
            // `bg-material-medium` 是半透明材质，必须配 backdrop-blur 才可读 —— 否则底下的
            // 表单项会透上来把文字搅糊。这几项与同表单「分类」的 AutoCompletion 下拉保持一致。
            className="shadow-context-menu absolute inset-x-0 top-full z-10 mt-1 max-h-52 overflow-y-auto rounded-[6px] border bg-material-medium p-1 text-text backdrop-blur-background"
          >
            {canCreate && (
              <li>
                <button
                  type="button"
                  data-testid="feed-form-processing-tags-create"
                  className="flex w-full cursor-menu items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left hover:bg-theme-item-hover"
                  disabled={busy}
                  onClick={() => createTag(trimmedQuery)}
                >
                  <i className="i-mgc-add-cute-re size-3 shrink-0" />
                  {t("processing.tags_form_create", { name: trimmedQuery })}
                </button>
              </li>
            )}
            {matchedTags.map((tag) => {
              const checked = tagIds.includes(tag.id)
              return (
                <li key={tag.id}>
                  <button
                    type="button"
                    data-testid="feed-form-processing-tags-option"
                    data-checked={checked}
                    className="flex w-full cursor-menu items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left hover:bg-theme-item-hover"
                    disabled={busy}
                    onClick={() => toggleTag(tag.id, !checked)}
                  >
                    <i
                      className={`i-mgc-check-cute-re size-3 shrink-0 ${checked ? "opacity-100" : "opacity-0"}`}
                    />
                    {tag.name}
                  </button>
                </li>
              )
            })}
            {showEmptyHint && (
              <li className="px-2.5 py-1.5 text-text-secondary">
                {t("processing.tags_form_no_match")}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
