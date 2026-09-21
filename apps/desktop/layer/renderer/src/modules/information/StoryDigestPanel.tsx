import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { RelativeTime } from "~/components/ui/datetime"
import { smartReadingPath } from "~/modules/information/reading-mode-link"

import type { StoryDigest } from "./processing-reader-client"
import { loadStoryDigest, ReadingRequestError } from "./processing-reader-client"

/**
 * 时间线内联综述摘要（§6 场景二）。
 *
 * 场景二判据要求「在 Blockchain 分类列表内直接看到整合条目，不跳页」，而且条目要显示
 * 来源数 ≥2、句段引用、更新时间。这里把综述正文、按句分组的引用与来源清单都放在
 * 列表就地打开的面板里，只有需要修改综述时才去工作台。
 */
export function StoryDigestPanel({
  storyId,
  storyTitle,
}: {
  storyId: string
  storyTitle?: string
}) {
  const { t } = useTranslation("app")
  const [digest, setDigest] = useState<StoryDigest | null>(null)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setFailed(false)
    loadStoryDigest(storyId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDigest(result)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setFailed(cause instanceof ReadingRequestError && cause.kind === "authorization")
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [storyId])

  if (busy) return <p className="text-sm text-text-secondary">{t("processing.digest.loading")}</p>
  if (failed || !digest) return <p role="alert">{t("processing.reader.error.request")}</p>
  if (digest.status !== "ready")
    return <p className="text-sm text-text-secondary">{t("processing.digest.repairing")}</p>

  const updatedAt = new Date(digest.updatedAt)

  return (
    <div className="space-y-4 text-sm" data-story-digest={digest.storyId}>
      <header className="space-y-1">
        <h3 className="text-base font-semibold">{digest.title || storyTitle}</h3>
        <p className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          {/* 场景二判据：来源数 ≥ 2 要能直接看到。 */}
          <span data-story-source-count={digest.sourceCount}>
            {t("processing.digest.source_count", { count: digest.sourceCount })}
          </span>
          <span>·</span>
          <span>
            {t("processing.digest.updated_at")} <RelativeTime date={updatedAt} />
          </span>
          <span>·</span>
          <span>{t("processing.digest.revision", { revision: digest.revision })}</span>
        </p>
      </header>

      <p className="whitespace-pre-wrap leading-6">{digest.body}</p>

      <section className="space-y-2">
        <h4 className="font-medium">{t("processing.digest.citations")}</h4>
        {digest.sentences.map((sentence) => (
          <div className="rounded-lg bg-fill-quaternary p-3" key={sentence.id}>
            <p className="whitespace-pre-wrap">{sentence.text}</p>
            {sentence.citations.length === 0 ? (
              <p className="mt-1 text-xs text-text-tertiary">
                {t("processing.digest.sentence_uncited")}
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {sentence.citations.map((citation) => (
                  <li className="text-xs text-text-secondary" key={citation.id}>
                    {citation.sourceUrl ? (
                      <a
                        className="underline hover:text-text"
                        href={citation.sourceUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {citation.sourceTitle}
                      </a>
                    ) : (
                      <span>{citation.sourceTitle}</span>
                    )}
                    {/* 句段引用：连续原文，供人核对分歧（§5.3 引用校验不放松）。 */}
                    <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-fill pl-2 text-text-tertiary">
                      {citation.quote}
                    </blockquote>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {digest.uncitedSentenceCount > 0 && (
          <p className="text-xs text-text-tertiary">
            {t("processing.digest.uncited_summary", { count: digest.uncitedSentenceCount })}
          </p>
        )}
      </section>

      <section className="space-y-1">
        <h4 className="font-medium">{t("processing.digest.sources")}</h4>
        <ul className="space-y-1">
          {digest.sources.map((source) => (
            <li
              className="text-xs text-text-secondary"
              key={`${source.sourceKey}:${source.itemId}`}
            >
              {source.url ? (
                <a
                  className="underline hover:text-text"
                  href={source.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {source.title}
                </a>
              ) : (
                source.title
              )}
            </li>
          ))}
        </ul>
      </section>

      <a
        className="inline-block text-xs text-accent underline"
        href={smartReadingPath(window.location.pathname + window.location.search, digest.storyId)}
      >
        {t("processing.digest.open_in_workspace")}
      </a>
    </div>
  )
}
