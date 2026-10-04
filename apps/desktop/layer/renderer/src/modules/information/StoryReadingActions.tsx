import { useWhoami } from "@follow/store/user/hooks"
import { useSetAtom } from "jotai"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { z } from "zod"

import { timelineContentModeAtom } from "~/modules/entry-column/atoms/processing-timeline"

import { mutationSchemas, readingRequest, readingStorySchema } from "./processing-reader-client"

const previewSchema = z.object({
  storyId: z.string(),
  status: z.enum(["active", "repairing"]),
  expectedRevision: z.number().int().positive(),
  inputSeqs: z.array(z.number().int().positive()).min(2),
  members: z
    .array(
      z.object({
        inputSeq: z.number().int().positive(),
        sourceKey: z.string(),
        itemId: z.string(),
        title: z.string(),
        url: z.string().nullable(),
        current: z.boolean(),
        withdrawn: z.boolean(),
      }),
    )
    .min(2),
})
type Preview = z.infer<typeof previewSchema>
type Resolution = z.infer<typeof readingStorySchema>
type State = { key: string; preview?: Preview; link?: Resolution; failed?: boolean; busy?: boolean }

// 材料 URL 来自订阅内容，仅将普通 HTTP(S) 链接交给浏览器打开。
function materialHref(url: string | null) {
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

// 拆分先展示冻结版本和材料，不在浏览器猜写新事实；旧深链仍显示明确去向。
export function StoryReadingActions({
  storyId,
  unavailable = false,
}: {
  storyId: string
  unavailable?: boolean
}) {
  const { t } = useTranslation("app")
  const owner = useWhoami()?.id ?? null
  const originalMode = useSetAtom(timelineContentModeAtom)
  const key = JSON.stringify([owner, storyId])
  const currentKeyRef = useRef(key)
  currentKeyRef.current = key
  const requestRef = useRef<AbortController | null>(null)
  const [state, setState] = useState<State>({ key })
  const visible = state.key === key ? state : { key }
  const valid = useCallback(
    (request: AbortController, captured: string) =>
      !request.signal.aborted && currentKeyRef.current === captured,
    [],
  )

  useEffect(() => {
    const request = new AbortController()
    requestRef.current?.abort()
    requestRef.current = request
    setState({ key })
    if (unavailable && owner)
      void readingRequest(
        `stories/${encodeURIComponent(storyId)}`,
        readingStorySchema,
        request.signal,
      )
        .then((link) => {
          if (valid(request, key)) setState({ key, link })
        })
        .catch(() => {
          if (valid(request, key)) setState({ key, failed: true })
        })
    return () => {
      request.abort()
      requestRef.current?.abort()
    }
  }, [key, owner, storyId, unavailable, valid])

  const execute = async (confirm: boolean) => {
    if (!owner || (confirm && !visible.preview)) return
    const request = new AbortController()
    requestRef.current?.abort()
    requestRef.current = request
    const captured = key
    setState({ ...visible, busy: true, failed: false })
    try {
      if (confirm) {
        const preview = visible.preview!
        await readingRequest(
          `stories/${encodeURIComponent(storyId)}/split`,
          mutationSchemas.split,
          request.signal,
          {
            expectedRevision: preview.expectedRevision,
            groups: [],
            independentInputSeqs: preview.inputSeqs,
          },
        )
        if (!valid(request, captured)) return
        const link = await readingRequest(
          `stories/${encodeURIComponent(storyId)}`,
          readingStorySchema,
          request.signal,
        )
        if (valid(request, captured)) setState({ key: captured, link })
      } else {
        const preview = await readingRequest(
          `stories/${encodeURIComponent(storyId)}/split-preview`,
          previewSchema,
          request.signal,
        )
        if (valid(request, captured)) setState({ key: captured, preview, link: visible.link })
      }
    } catch {
      if (valid(request, captured)) setState({ key: captured, failed: true, link: visible.link })
    }
  }

  if (!owner) return null
  const kind = visible.link?.kind
  // 当前有效材料不足不代表冻结旧版本没有误合并，仍可明确纠正其历史归属。
  const independentRevision =
    visible.link?.kind === "independent" &&
    ["active", "repairing"].includes(visible.link.story.status)
  return (
    <div className="space-y-2 border-t border-fill-secondary pt-3 text-xs text-text-secondary">
      {unavailable && !kind && !visible.failed && <p>{t("processing.digest.loading")}</p>}
      {kind === "repairing" && <p>{t("processing.digest.repairing")}</p>}
      {(kind === "missing" || kind === "independent") && (
        <p>{t("processing.digest.independent_notice")}</p>
      )}
      {kind === "merged" && visible.link?.kind === "merged" && (
        <p>
          {t("processing.digest.merged_notice")}{" "}
          <Link
            className="underline"
            to={`/events?story=${encodeURIComponent(visible.link.mergedInto)}`}
          >
            {t("processing.digest.open_current")}
          </Link>
        </p>
      )}
      {kind === "split" && visible.link?.kind === "split" && (
        <>
          <p>
            {t("processing.digest.split_notice", {
              count: visible.link.independentInputSeqs.length,
            })}
          </p>
          {visible.link.splitInto.map((id) => (
            <Link
              key={id}
              className="mr-3 underline"
              to={`/events?story=${encodeURIComponent(id)}`}
            >
              {t("processing.digest.open_current")}
            </Link>
          ))}
        </>
      )}
      {(kind === "split" || kind === "independent" || kind === "missing") && (
        <Link
          className="mr-3 underline"
          to="/timeline/all/all"
          onClick={() => originalMode("original")}
        >
          {t("processing.timeline_mode_original")}
        </Link>
      )}
      {((!unavailable && !kind) ||
        kind === "current" ||
        kind === "repairing" ||
        independentRevision) && (
        <button
          type="button"
          className="underline"
          disabled={visible.busy}
          onClick={() => void execute(false)}
        >
          {t("processing.digest.split_preview")}
        </button>
      )}
      {visible.preview && (
        <div className="space-y-2 rounded bg-fill-quaternary p-3">
          <p>
            {t("processing.digest.split_description", {
              revision: visible.preview.expectedRevision,
            })}
          </p>
          <ul className="list-inside list-disc space-y-1">
            {visible.preview.members.map((member) => {
              const href = materialHref(member.url)
              return (
                <li key={member.inputSeq}>
                  {href ? (
                    <a className="underline" href={href} target="_blank" rel="noreferrer noopener">
                      {member.title}
                    </a>
                  ) : (
                    member.title
                  )}{" "}
                  {(!member.current || member.withdrawn) && (
                    <span className="text-orange">
                      {t("processing.digest.historical_material")}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            className="mr-3 rounded bg-fill-secondary px-3 py-1"
            disabled={visible.busy}
            onClick={() => void execute(true)}
          >
            {t("processing.digest.split_confirm")}
          </button>
          <button
            type="button"
            disabled={visible.busy}
            onClick={() => setState({ key, link: visible.link })}
          >
            {t("processing.digest.split_cancel")}
          </button>
        </div>
      )}
      {visible.failed && (
        <p role="alert" className="text-red">
          {t("processing.reader.error.request")}
        </p>
      )}
    </div>
  )
}
