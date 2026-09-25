import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getOneTimeToken, isLocalFoloHost } from "../ai-chat/local-provider"
import { createProcessingClient, ProcessingRequestError } from "./processing-client"
import { processingFeedSourceKey } from "./processing-tags-utils"

const client = createProcessingClient(getOneTimeToken)

type FeedSubscriptionTag = { id: string; name: string }

/**
 * 「编辑订阅」弹窗里的私人订阅标签区块。
 *
 * 写入的是本机信息服务的 `source-tags`，与「设置 → 订阅源」的「我的标签」列、
 * 「Actions → 我的处理服务 → 私人订阅标签」读写同一份数据（都以 `feed/<id>` 为 source key）。
 *
 * 标签是即时生效的，不参与外层表单的保存流程，所以挂在 FeedForm 的 </Form> 之后。
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
  const [pendingTagId, setPendingTagId] = useState<string | null>(null)
  const [error, setError] = useState<ProcessingRequestError["kind"] | null>(null)
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

  const toggle = useCallback(
    async (tagId: string, checked: boolean) => {
      const controller = new AbortController()
      controllerRef.current = controller
      setPendingTagId(tagId)
      setError(null)
      // 先动本地、失败再回滚；写入用服务端最新 revision，避免与其它窗口并发写冲突。
      setTagIds((current) =>
        checked ? [...new Set([...current, tagId])] : current.filter((id) => id !== tagId),
      )
      try {
        await client.bindTags(
          [sourceKey],
          [tagId],
          checked ? "add" : "remove",
          revision,
          controller.signal,
        )
        await read(controller.signal)
      } catch (cause) {
        if (controller.signal.aborted) return
        setTagIds((current) =>
          checked ? current.filter((id) => id !== tagId) : [...new Set([...current, tagId])],
        )
        setError(cause instanceof ProcessingRequestError ? cause.kind : "request")
      } finally {
        if (!controller.signal.aborted) setPendingTagId(null)
      }
    },
    [read, revision, sourceKey],
  )

  if (!enabled) return null

  return (
    <section
      data-testid="feed-form-processing-tags"
      className="rounded-xl border border-fill-secondary p-4"
    >
      <p className="font-medium">{t("processing.tags")}</p>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        {t("processing.tags_form_hint")}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red">
          {t(`processing.error.${error}`)}
        </p>
      )}
      {loading ? (
        <p className="mt-3 text-sm text-text-secondary">{t("processing.loading")}</p>
      ) : tags.length === 0 ? (
        <p className="mt-3 text-sm text-text-secondary">{t("processing.tags_form_empty")}</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          {tags.map((tag) => (
            <li key={tag.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={tag.name}
                  checked={tagIds.includes(tag.id)}
                  disabled={pendingTagId !== null}
                  onChange={(event) => void toggle(tag.id, event.target.checked)}
                />
                {tag.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
