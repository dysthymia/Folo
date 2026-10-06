import type { EntryProcessingRelatedEntry } from "@follow/store/entry/processing-role"
import { useEntryProcessingRole } from "@follow/store/entry/processing-role"
import { useWhoami } from "@follow/store/user/hooks"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { RelativeTime } from "~/components/ui/datetime"
import { ReadingRequestError } from "~/modules/information/processing-reader-client"

import { processingButtonClass } from "../action/processing-condition-editor"
import {
  cachedDuplicateGroup,
  cacheDuplicateGroup,
  clearDuplicateGroupCache,
  duplicateGroupCacheKey,
} from "./processing-duplicates-cache"
import type { DuplicateGroup } from "./processing-duplicates-client"
import { loadDuplicateGroup } from "./processing-duplicates-client"
import { useProcessingEntryOverride } from "./processing-entry-override"

/** 点击后按需读取完整组；身份随打开时固定，账号切换或代表变更不展示旧数据。 */
export function DuplicateEntriesPanel({
  entryId,
  inputSeq,
  memberIds,
  cachedEntries,
}: {
  entryId: string
  inputSeq?: number
  memberIds: string[]
  cachedEntries: EntryProcessingRelatedEntry[]
}) {
  const { t } = useTranslation("app")
  const owner = useWhoami()?.id
  const [openingOwner] = useState(owner)
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const role = useEntryProcessingRole(entryId)
  // 本组投影才决定详情身份，避免全局轮询或其他条目发布结果触发重复读取。
  const revision = JSON.stringify([role, cachedEntries])
  const active = role?.kind === "keeper" && role.inputSeq === inputSeq
  const signature = active ? JSON.stringify([role.relatedEntryIds, revision]) : ""
  const cacheKey = duplicateGroupCacheKey(inputSeq, entryId, memberIds, revision)
  const signatureRef = useRef(signature)
  signatureRef.current = signature
  const requestRef = useRef<AbortController | null>(null)
  const [result, setResult] = useState(() => ({
    key: cacheKey,
    group: cachedDuplicateGroup(owner, cacheKey),
  }))
  const group = result.key === cacheKey ? result.group : null
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [restored, setRestored] = useState(false)
  const { setMode, busy, failed: restoreFailed } = useProcessingEntryOverride()

  const load = useCallback(
    async (previous?: DuplicateGroup) => {
      if (inputSeq === undefined || !owner || owner !== openingOwner) return
      requestRef.current?.abort()
      const controller = new AbortController()
      requestRef.current = controller
      const requestSignature = signature
      const current = () =>
        !controller.signal.aborted &&
        ownerRef.current === openingOwner &&
        signatureRef.current === requestSignature
      setLoading(true)
      setFailed(false)
      try {
        let next: DuplicateGroup
        try {
          next = await loadDuplicateGroup(
            inputSeq,
            controller.signal,
            previous?.nextOffset != null
              ? {
                  offset: previous.nextOffset,
                  expectedFingerprint: previous.fingerprint,
                }
              : undefined,
          )
        } catch (error) {
          // 组关系在翻页期间改变时重新读首屏，不把旧成员追加到新组。
          if (
            !previous ||
            !(error instanceof ReadingRequestError) ||
            error.kind !== "conflict" ||
            !current()
          )
            throw error
          next = await loadDuplicateGroup(inputSeq, controller.signal)
          previous = undefined
        }
        if (!current()) return
        if (next.representative.itemId !== entryId) throw new Error("Changed representative")
        const complete = previous
          ? { ...next, members: [...previous.members, ...next.members] }
          : next
        cacheDuplicateGroup(owner, cacheKey, complete)
        setResult({ key: cacheKey, group: complete })
      } catch {
        if (current()) setFailed(true)
      } finally {
        if (current()) setLoading(false)
      }
    },
    [cacheKey, entryId, inputSeq, openingOwner, owner, signature],
  )

  useEffect(() => {
    const cached = cachedDuplicateGroup(owner, cacheKey)
    if (cached) {
      setResult({ key: cacheKey, group: cached })
      setLoading(false)
      setFailed(false)
    } else if (active && inputSeq !== undefined) void load()
    return () => requestRef.current?.abort()
  }, [active, cacheKey, inputSeq, load, owner])

  if (owner !== openingOwner) return null
  if (inputSeq !== undefined && !active)
    return (
      <p className="p-3 text-xs text-text-secondary">
        {t(restored ? "processing.duplicates.complete" : "processing.duplicates.changed")}
      </p>
    )

  // 理由已随时间线角色核验并送达，首次点击直接展示；恢复仍等待最新覆盖版本。
  const cached = new Map(cachedEntries.map((entry) => [entry.id, entry]))
  const members = !group
    ? (inputSeq === undefined ? memberIds : memberIds.slice(0, 20)).map((itemId) => {
        const entry = cached.get(itemId)
        return {
          itemId,
          inputSeq: null,
          contentVersion: null,
          title: entry?.title ?? null,
          sourceTitle: entry?.feedTitle ?? null,
          publishedAt: entry?.publishedAt?.toISOString() ?? null,
          url: entry?.url ?? null,
          reason: entry?.reason ?? null,
          canRestore: false,
          overrideRevision: null,
        }
      })
    : group.members

  return (
    <div className="space-y-3 p-3">
      <div>
        <h3 className="text-sm font-semibold">{t("processing.duplicates.title")}</h3>
        <p className="mt-1 text-xs text-text-secondary">{t("processing.duplicates.hint")}</p>
        <p className="mt-1 text-xs text-text-tertiary">
          {t("processing.duplicates.total", { count: group?.total ?? memberIds.length })}
        </p>
      </div>
      {restoreFailed && (
        <p role="alert" className="text-xs text-red">
          {t("processing.badge.override_failed")}
        </p>
      )}
      <div className="space-y-2">
        {members.map((member) => (
          <div key={member.itemId} className="rounded border border-border p-2">
            <p className="break-words text-xs font-medium">
              {/* 标题与下方入口共用原文地址，缺少地址时仍保留普通文字。 */}
              {member.url ? (
                <a
                  href={member.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-accent hover:underline focus-visible:underline"
                >
                  {member.title ?? t("processing.duplicates.unavailable")}
                </a>
              ) : (
                (member.title ?? t("processing.duplicates.unavailable"))
              )}
            </p>
            <p className="mt-1 flex flex-wrap gap-1 text-[11px] text-text-tertiary">
              {member.sourceTitle && <span className="break-words">{member.sourceTitle}</span>}
              {member.publishedAt && <RelativeTime date={member.publishedAt} />}
            </p>
            {member.reason && (
              <details className="mt-2 text-xs text-text-secondary">
                <summary className="cursor-button">{t("processing.duplicates.reason")}</summary>
                <p className="mt-1 break-words">{member.reason}</p>
              </details>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {member.url && (
                <a
                  href={member.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent underline"
                >
                  {t("processing.duplicates.original")}
                </a>
              )}
              {member.canRestore &&
                member.inputSeq !== null &&
                member.overrideRevision !== null && (
                  <button
                    type="button"
                    disabled={busy || loading}
                    className={processingButtonClass}
                    onClick={async () => {
                      if (
                        !active ||
                        !role.relatedEntryIds.includes(member.itemId) ||
                        ownerRef.current !== openingOwner
                      )
                        return
                      const success = await setMode(
                        member.inputSeq!,
                        "restore",
                        member.overrideRevision!,
                      )
                      if (success && ownerRef.current === openingOwner) {
                        clearDuplicateGroupCache()
                        setRestored(true)
                        // 写入后丢弃旧分页，成员数和版本一起重新获取。
                        if (signatureRef.current === signature) void load()
                      }
                    }}
                  >
                    {t("processing.reader.override.restore")}
                  </button>
                )}
            </div>
          </div>
        ))}
      </div>
      {loading && (
        <p role="status" className="text-xs text-text-secondary">
          {t("processing.duplicates.loading")}
        </p>
      )}
      {failed && (
        <div role="alert" className="space-y-2 text-xs text-red">
          <p>{t("processing.duplicates.failed")}</p>
          <button
            type="button"
            disabled={loading}
            className={processingButtonClass}
            onClick={() => void load(group ?? undefined)}
          >
            {t("processing.duplicates.retry")}
          </button>
        </div>
      )}
      {!failed && group?.nextOffset !== null && group?.nextOffset !== undefined && (
        <button
          type="button"
          disabled={loading || busy}
          className={processingButtonClass}
          onClick={() => void load(group)}
        >
          {t("processing.duplicates.more")}
        </button>
      )}
    </div>
  )
}
