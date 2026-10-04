import {
  appendPersonalizedRulePack,
  createPersonalizedRulePack,
  previewPersonalizedRuleConditions,
  updatePersonalizedRuleConditions,
} from "@follow/information-core"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getOneTimeToken } from "../ai-chat/local-provider"
import type { ProcessingEditor } from "./processing-client"
import { createProcessingClient, ProcessingRequestError } from "./processing-client"
import { processingButtonClass } from "./processing-condition-editor"

const client = createProcessingClient(getOneTimeToken)

/** 按真实标签生成预览；保存只写草稿，逐条试运行与启用仍在原编辑器完成。 */
export function PersonalizedRulePackPanel({
  editor,
  onSaved,
  onClose,
}: {
  editor: ProcessingEditor
  onSaved: (saved: Pick<ProcessingEditor, "config" | "revision">) => void
  onClose: () => void
}) {
  const { t } = useTranslation("app")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<"request" | "conflict" | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const pack = useMemo(
    () =>
      createPersonalizedRulePack({
        ownerId: editor.config.ownerId,
        tagCatalog: editor.subscriptionTags.tags,
      }),
    [editor.config.ownerId, editor.subscriptionTags.tags],
  )
  const [selectedDiffs, setSelectedDiffs] = useState<Set<string>>(() => new Set())
  const diffs = useMemo(
    () => previewPersonalizedRuleConditions(editor.config, pack),
    [editor.config, pack],
  )
  // 账号、草稿或真实标签改变后，旧勾选不能悄悄套用到新差异。
  const diffKey = (diff: (typeof diffs)[number]) =>
    JSON.stringify([editor.config.ownerId, editor.revision, diff])
  const selectedRuleIds = diffs
    .filter((diff) => !diff.requiresManualEdit && selectedDiffs.has(diffKey(diff)))
    .map((diff) => diff.ruleId)
  const candidate = updatePersonalizedRuleConditions(
    appendPersonalizedRulePack(editor.config, pack),
    pack,
    selectedRuleIds,
  )
  const tagLabels = (ids: readonly string[]) =>
    ids
      .map((id) => {
        const tag = editor.subscriptionTags.tags.find((item) => item.id === id)
        return tag ? `${tag.name} (${id})` : id
      })
      .join("、")
  const existing = new Set(editor.config.rules.map((rule) => rule.id))
  const additions = candidate.rules.filter((rule) => !existing.has(rule.id))

  useEffect(() => {
    // 切换账号或草稿时终止旧保存，迟到结果不能覆盖新的编辑对象。
    setBusy(false)
    setError(null)
    return () => requestRef.current?.abort()
  }, [editor.config.ownerId, editor.revision])
  const save = async () => {
    if (busy || (!additions.length && !selectedRuleIds.length)) return
    const request = new AbortController()
    requestRef.current = request
    setBusy(true)
    setError(null)
    try {
      const saved = await client.save(candidate, editor.revision, request.signal)
      if (!request.signal.aborted) onSaved(saved)
    } catch (cause) {
      if (!request.signal.aborted)
        setError(
          cause instanceof ProcessingRequestError && cause.kind === "conflict"
            ? "conflict"
            : "request",
        )
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  return (
    <section
      className="space-y-4 rounded-xl border border-fill-secondary p-5"
      aria-label={t("automation.pack.title")}
    >
      <h3 className="font-semibold">{t("automation.pack.title")}</h3>
      <p className="text-sm text-text-secondary">{t("automation.pack.description")}</p>
      {pack.unresolvedTagNames.length > 0 && (
        <p className="text-sm text-orange">
          {t("automation.pack.missing_tags", { names: pack.unresolvedTagNames.join("、") })}
        </p>
      )}
      {pack.omittedPresetIds.length > 0 && (
        <p className="text-xs text-text-secondary">
          {t("automation.pack.omitted", { names: pack.omittedPresetIds.join("、") })}
        </p>
      )}
      <details className="rounded-lg bg-fill-quinary p-3">
        <summary className="cursor-pointer text-sm">{t("automation.pack.global")}</summary>
        <pre className="mt-3 whitespace-pre-wrap text-xs">{candidate.global.markdown}</pre>
      </details>
      {additions.map((rule) => (
        <details key={rule.id} className="rounded-lg bg-fill-quinary p-3">
          <summary className="cursor-pointer text-sm">
            {rule.name} · {t(rule.enabled ? "processing.enabled" : "automation.editor.disabled")}
          </summary>
          <p className="mt-3 text-xs text-text-secondary">
            {"all" in rule.when
              ? t("automation.pack.all_sources")
              : editor.subscriptionTags.tags
                  .filter(
                    (tag) =>
                      "anyOf" in rule.when &&
                      rule.when.anyOf.some((group) =>
                        group.allOf.some(
                          (condition) =>
                            condition.field === "subscription_tag" &&
                            condition.value.includes(tag.id),
                        ),
                      ),
                  )
                  .map((tag) => tag.name)
                  .join("、")}
          </p>
          {rule.actions.map((action, index) => (
            <pre key={index} className="mt-3 whitespace-pre-wrap text-xs">
              {"prompt" in action
                ? action.prompt
                : "createPrompt" in action
                  ? `${action.createPrompt}\n\n${action.updatePrompt}`
                  : ""}
            </pre>
          ))}
        </details>
      ))}
      {diffs.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{t("automation.pack.condition_diff_title")}</h4>
          <p className="text-xs text-text-secondary">{t("automation.pack.condition_diff_hint")}</p>
          {diffs.map((diff) => (
            <div key={diff.ruleId} className="space-y-2 rounded-lg bg-fill-quinary p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedDiffs.has(diffKey(diff))}
                  disabled={busy || diff.requiresManualEdit}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setSelectedDiffs((previous) => {
                      const next = new Set(previous)
                      if (checked) next.add(diffKey(diff))
                      else next.delete(diffKey(diff))
                      return next
                    })
                  }}
                />
                {t("automation.pack.select_condition_update", {
                  name: editor.config.rules.find((rule) => rule.id === diff.ruleId)?.name,
                })}
              </label>
              <p className="text-xs text-text-secondary">
                {t("automation.pack.condition_current", {
                  tags: tagLabels(diff.currentTagIds) || t("automation.pack.no_tag_condition"),
                })}
              </p>
              <p className="text-xs">
                {t("automation.pack.condition_proposed", { tags: tagLabels(diff.expectedTagIds) })}
              </p>
              {diff.addedTagIds.length > 0 && (
                <p className="text-xs text-green">
                  {t("automation.pack.condition_added", { tags: tagLabels(diff.addedTagIds) })}
                </p>
              )}
              {diff.removedTagIds.length > 0 && (
                <p className="text-xs text-orange">
                  {t("automation.pack.condition_removed", { tags: tagLabels(diff.removedTagIds) })}
                </p>
              )}
              {diff.requiresManualEdit && (
                <p className="text-xs text-orange">{t("automation.pack.condition_manual_edit")}</p>
              )}
              <details>
                <summary className="cursor-pointer text-xs">
                  {t("automation.pack.condition_details")}
                </summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                  {JSON.stringify(diff.currentWhen, null, 2)}
                  {"\n→\n"}
                  {JSON.stringify(diff.proposedWhen, null, 2)}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
      {!additions.length && !diffs.length && (
        <p role="status" className="text-sm">
          {t("automation.pack.already_added")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red">
          {t(`automation.editor.error_${error}`)}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={processingButtonClass}
          disabled={busy || (!additions.length && !selectedRuleIds.length)}
          onClick={() => void save()}
        >
          {selectedRuleIds.length
            ? t("automation.pack.save_condition_draft", {
                added: additions.length,
                updated: selectedRuleIds.length,
              })
            : t("automation.pack.add_draft", { count: additions.length })}
        </button>
        <button type="button" className={processingButtonClass} disabled={busy} onClick={onClose}>
          {t("automation.editor.back")}
        </button>
      </div>
    </section>
  )
}
