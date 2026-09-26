import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useDialog } from "~/components/ui/modal/stacked/hooks"
import type { ProcessingEditor } from "~/modules/action/processing-client"
import { createProcessingClient, ProcessingRequestError } from "~/modules/action/processing-client"
import { getOneTimeToken } from "~/modules/ai-chat/local-provider"

type SubscriptionTagData = Pick<ProcessingEditor, "subscriptionTags">

const client = createProcessingClient(getOneTimeToken)

/**
 * 标签的建 / 改名 / 删。
 *
 * 「给订阅源打标签」刻意不放在这里：在设置页列表里选中订阅源后用底部操作栏批量加/减，
 * 编辑单个订阅时在弹窗的「标签」多选里改。规则里只保留「按标签筛选」这一种只读用法，
 * 不再提供建标签或给来源打标签这类数据管理动作。
 */
export const ProcessingTagManager = ({
  data,
  reload,
}: {
  data: SubscriptionTagData | null
  reload: (signal: AbortSignal) => Promise<void>
}) => {
  const { t } = useTranslation("settings")
  const { ask } = useDialog()
  const [name, setName] = useState("")
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ProcessingRequestError["kind"] | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  // 写入后重新读取服务端快照，前端不维护第二份标签真相。
  // 成功后清掉本地草稿、失败时保留用户输入，避免把没落库的名字当成已保存。
  const run = useCallback(
    async (
      operation: (signal: AbortSignal) => Promise<unknown>,
      onSuccess?: () => void,
    ): Promise<void> => {
      const controller = new AbortController()
      controllerRef.current = controller
      setBusy(true)
      setError(null)
      try {
        await operation(controller.signal)
        if (controller.signal.aborted) return
        onSuccess?.()
        await reload(controller.signal)
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof ProcessingRequestError ? cause.kind : "request")
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    },
    [reload],
  )

  const dropDraft = useCallback((tagId: string) => {
    setDrafts((current) => {
      if (!(tagId in current)) return current
      const next = { ...current }
      delete next[tagId]
      return next
    })
  }, [])

  if (!data) return null

  const { revision, tags } = data.subscriptionTags
  const pendingName = name.trim()

  return (
    <details
      // 宽度必须自适应：这一块的兄弟节点是 `min-w-[1000px]` 的订阅源表格，
      // 若跟着撑满，按钮会跑到设置弹窗可视区外（弹窗可视宽约 738px），
      // 而它在横向滚动容器之外、滚不过去，等于点不到。
      className="mb-4 w-fit max-w-full rounded-xl border border-fill-secondary p-4"
      data-testid="feeds-tag-manager"
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t("feeds.processing_tags.manage", { count: tags.length })}
      </summary>
      <p className="mt-3 text-sm text-text-secondary">{t("feeds.processing_tags.manage_hint")}</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red">
          {t("feeds.processing_tags.write_failed")}
        </p>
      )}
      <fieldset disabled={busy} className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            className="w-56 min-w-0 rounded border border-fill-secondary bg-material-opaque px-2 py-1 text-xs"
            aria-label={t("feeds.processing_tags.name_placeholder")}
            placeholder={t("feeds.processing_tags.name_placeholder")}
            data-testid="feeds-tag-create-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className="shrink-0 text-xs text-accent disabled:opacity-40"
            data-testid="feeds-tag-create"
            disabled={!pendingName}
            onClick={() =>
              void run(
                (signal) => client.createTag(pendingName, revision, signal),
                () => setName(""),
              )
            }
          >
            {t("feeds.processing_tags.create")}
          </button>
        </div>
        {tags.length === 0 ? (
          <p className="text-xs text-text-secondary">{t("feeds.processing_tags.empty")}</p>
        ) : (
          tags.map((tag) => {
            const draft = drafts[tag.id] ?? tag.name
            const pendingDraft = draft.trim()
            return (
              <div
                key={tag.id}
                className="flex items-center gap-2"
                data-testid={`feeds-tag-row-${tag.id}`}
              >
                <input
                  className="w-56 min-w-0 rounded border border-fill-secondary bg-material-opaque px-2 py-1 text-xs"
                  aria-label={t("feeds.processing_tags.rename_aria", { name: tag.name })}
                  data-testid={`feeds-tag-rename-input-${tag.id}`}
                  value={draft}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [tag.id]: event.target.value }))
                  }
                />
                <button
                  type="button"
                  className="shrink-0 text-xs text-accent disabled:opacity-40"
                  data-testid={`feeds-tag-rename-${tag.id}`}
                  disabled={!pendingDraft || pendingDraft === tag.name}
                  onClick={() =>
                    void run(
                      (signal) => client.renameTag(tag.id, pendingDraft, revision, signal),
                      () => dropDraft(tag.id),
                    )
                  }
                >
                  {t("feeds.processing_tags.rename")}
                </button>
                <button
                  type="button"
                  className="shrink-0 text-xs text-red"
                  data-testid={`feeds-tag-delete-${tag.id}`}
                  onClick={() =>
                    void ask({
                      variant: "danger",
                      title: t("feeds.processing_tags.delete_confirm_title", { name: tag.name }),
                      message: t("feeds.processing_tags.delete_confirm_message"),
                      confirmText: t("feeds.processing_tags.delete"),
                      onConfirm: () =>
                        void run(
                          (signal) => client.deleteTag(tag.id, revision, signal),
                          () => dropDraft(tag.id),
                        ),
                    })
                  }
                >
                  {t("feeds.processing_tags.delete")}
                </button>
              </div>
            )
          })
        )}
      </fieldset>
    </details>
  )
}
