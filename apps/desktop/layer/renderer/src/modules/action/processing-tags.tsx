import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getOneTimeToken } from "../ai-chat/local-provider"
import type { ProcessingEditor } from "./processing-client"
import { createProcessingClient, ProcessingRequestError } from "./processing-client"
import { processingButtonClass, processingInputClass } from "./processing-condition-editor"
import { buildProcessingTagSelectionScopes } from "./processing-tags-utils"

const client = createProcessingClient(getOneTimeToken)
export function ProcessingTags({
  editor,
  refresh,
}: {
  editor: ProcessingEditor
  refresh: () => Promise<void>
}) {
  const { t } = useTranslation("app")
  const [name, setName] = useState("")
  const [names, setNames] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [tagId, setTagId] = useState("")
  const [selectionScope, setSelectionScope] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ProcessingRequestError["kind"] | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])
  const sources = editor.sources.filter(
    (source) =>
      source.kind !== "list" &&
      `${source.title} ${source.category ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
  )
  const selectionScopes = useMemo(
    () => buildProcessingTagSelectionScopes(editor.sources, editor.listMemberships),
    [editor.listMemberships, editor.sources],
  )
  const selectedScope = [...selectionScopes.categories, ...selectionScopes.lists].find(
    (scope) => scope.key === selectionScope,
  )
  const run = async (operation: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError(null)
    try {
      await operation(controller.signal)
      if (!controller.signal.aborted) await refresh()
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof ProcessingRequestError ? cause.kind : "request")
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <details className="rounded-xl border border-fill-secondary p-4">
      <summary className="cursor-pointer font-medium">{t("processing.tags")}</summary>
      <p className="my-3 text-sm text-text-secondary">{t("processing.tags_hint")}</p>
      {error && (
        <p role="alert" className="my-2 text-sm text-red">
          {t(`processing.error.${error}`)}
        </p>
      )}
      <fieldset disabled={busy} className="space-y-3">
        <div className="flex gap-2">
          <input
            className={processingInputClass}
            aria-label={t("processing.tag_name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className={`${processingButtonClass} shrink-0`}
            disabled={!name.trim()}
            onClick={() =>
              void run((signal) => client.createTag(name, editor.subscriptionTags.revision, signal))
            }
          >
            {t("processing.add_tag")}
          </button>
        </div>
        {editor.subscriptionTags.tags.map((tag) => (
          <div key={tag.id} className="flex gap-2">
            <input
              className={processingInputClass}
              aria-label={t("processing.rename_tag")}
              value={names[tag.id] ?? tag.name}
              onChange={(e) => setNames({ ...names, [tag.id]: e.target.value })}
            />
            <button
              type="button"
              className={`${processingButtonClass} shrink-0`}
              disabled={!names[tag.id]?.trim() || names[tag.id] === tag.name}
              onClick={() =>
                void run((signal) =>
                  client.renameTag(
                    tag.id,
                    names[tag.id]!,
                    editor.subscriptionTags.revision,
                    signal,
                  ),
                )
              }
            >
              {t("processing.rename_tag")}
            </button>
            <button
              type="button"
              className={`${processingButtonClass} shrink-0`}
              onClick={() =>
                void run((signal) =>
                  client.deleteTag(tag.id, editor.subscriptionTags.revision, signal),
                )
              }
            >
              {t("processing.remove")}
            </button>
          </div>
        ))}
        <input
          className={processingInputClass}
          aria-label={t("processing.filter_sources")}
          placeholder={t("processing.filter_sources")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={`${processingInputClass} flex-1`}
            aria-label={t("processing.tags_select_scope")}
            value={selectionScope}
            onChange={(event) => setSelectionScope(event.target.value)}
          >
            <option value="">{t("processing.tags_select_scope")}</option>
            <optgroup label={t("processing.tags_scope_categories")}>
              {selectionScopes.categories.map((scope) => (
                <option key={scope.key} value={scope.key}>
                  {scope.label} ({scope.sourceKeys.length})
                </option>
              ))}
            </optgroup>
            <optgroup label={t("processing.tags_scope_lists")}>
              {selectionScopes.lists.map((scope) => (
                <option key={scope.key} value={scope.key} disabled={scope.sourceKeys === null}>
                  {scope.label} · {scope.listId} ·{" "}
                  {scope.ownerId
                    ? t("processing.list_owner", { ownerId: scope.ownerId })
                    : t("processing.list_owner_unknown")}{" "}
                  ·{" "}
                  {scope.sourceKeys === null
                    ? t("processing.tags_scope_unknown")
                    : `${scope.sourceKeys.length} · ${t("processing.list_membership_revision", { revision: scope.revision })}`}
                </option>
              ))}
            </optgroup>
          </select>
          <button
            type="button"
            className={processingButtonClass}
            disabled={!selectedScope?.sourceKeys?.length}
            onClick={() => {
              const sourceKeys = selectedScope?.sourceKeys
              if (!sourceKeys) return
              setSelected((current) => [...new Set([...current, ...sourceKeys])])
            }}
          >
            {t("processing.tags_select_scope_action")}
          </button>
        </div>
        {selectedScope?.sourceKeys === null && (
          <p role="status" className="text-sm text-orange">
            {t("processing.tags_scope_unavailable")}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sources.length > 0 && sources.every((source) => selected.includes(source.key))}
            onChange={(e) => {
              // 全选基于完整筛选集合，切换筛选仍保留其他已选来源。
              setSelected(
                e.target.checked
                  ? [...new Set([...selected, ...sources.map((source) => source.key)])]
                  : selected.filter((key) => !sources.some((source) => source.key === key)),
              )
            }}
          />
          {t("processing.select_sources", { count: sources.length })}
        </label>
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg bg-fill-quinary p-3">
          {sources.map((source) => (
            <label key={source.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(source.key)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, source.key]
                      : selected.filter((key) => key !== source.key),
                  )
                }
              />
              <span>
                {source.title}
                <span className="ml-2 text-xs text-text-secondary">
                  {source.category} ·{" "}
                  {editor.sourceTags
                    .find((binding) => binding.sourceKey === source.key)
                    ?.tagIds.map(
                      (id) => editor.subscriptionTags.tags.find((tag) => tag.id === id)?.name,
                    )
                    .filter(Boolean)
                    .join("、")}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={`${processingInputClass} flex-1`}
            aria-label={t("processing.choose_tag")}
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
          >
            <option value="">{t("processing.choose_tag")}</option>
            {editor.subscriptionTags.tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          {(["add", "remove"] as const).map((operation) => (
            <button
              key={operation}
              type="button"
              className={processingButtonClass}
              disabled={!tagId || !selected.length}
              onClick={() =>
                void run((signal) =>
                  client.bindTags(
                    selected,
                    [tagId],
                    operation,
                    editor.subscriptionTags.revision,
                    signal,
                  ),
                )
              }
            >
              {t(operation === "add" ? "processing.bind_tags" : "processing.unbind_tags", {
                count: selected.length,
              })}
            </button>
          ))}
        </div>
      </fieldset>
    </details>
  )
}
