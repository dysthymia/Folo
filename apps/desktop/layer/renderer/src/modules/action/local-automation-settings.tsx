import type { AutomationRule } from "@follow/information-core"
import { convertLocalActionRule, ruleSchema } from "@follow/information-core"
import { useLocalActionHydration, useLocalActionRules } from "@follow/store/action/local-hooks"
import type { LocalActionMigrationTarget } from "@follow/store/action/local-store"
import { localActionSyncService } from "@follow/store/action/local-store"
import { setPublishedLocalFilters } from "@follow/store/action/published-local-filters"
import type { ActionItem } from "@follow/store/action/store"
import { useWhoami } from "@follow/store/user/hooks"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useDialog } from "~/components/ui/modal/stacked/hooks"

import { getOneTimeToken } from "../ai-chat/local-provider"
import { notifyLocalAutomationChanged } from "./local-automation-events"
import { LocalAutomationPreferences } from "./local-automation-preferences"
import { LocalRuleActions } from "./local-rule-actions"
import { localRuleUsesAI, newLocalRule, replaceLocalRule } from "./local-rule-model"
import type {
  EffectiveProcessing,
  ProcessingEditor,
  RuleActivation,
  RuleUpgrade,
} from "./processing-client"
import { createProcessingClient, ProcessingRequestError } from "./processing-client"
import {
  processingButtonClass,
  ProcessingConditionEditor,
  processingInputClass,
} from "./processing-condition-editor"
import {
  findProcessingRuleForContext,
  parseProcessingRuleContext,
  processingRuleCondition,
} from "./processing-rule-link"
import { ProcessingTrialPanel } from "./processing-trial-panel"
import { useUnSavedBlocker } from "./use-unsaved-blocker"

const client = createProcessingClient(getOneTimeToken)
type Selection = { rule: AutomationRule; baseline: string; legacy?: LocalActionMigrationTarget }

export function LocalAutomationSettings() {
  const { t } = useTranslation("app")
  const { ask } = useDialog()
  const ownerId = useWhoami()?.id
  useLocalActionHydration(ownerId)
  const legacyRules = useLocalActionRules()
  const [editor, setEditor] = useState<ProcessingEditor | null>(null)
  const [effective, setEffective] = useState<EffectiveProcessing | null>(null)
  const [upgrade, setUpgrade] = useState<RuleUpgrade | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [unsupported, setUnsupported] = useState<number | null>(null)
  const [panel, setPanel] = useState<"rules" | "settings">("rules")
  const [error, setError] = useState<"request" | "conflict" | "invalid" | "migration" | null>(null)
  const [status, setStatus] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preferencesDirty, setPreferencesDirty] = useState(false)
  const [preferencesBusy, setPreferencesBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [sample, setSample] = useState("")
  const requestRef = useRef<AbortController | null>(null)
  const activeOwnerRef = useRef(ownerId)
  activeOwnerRef.current = ownerId
  const dirty = !!selection && JSON.stringify(selection.rule) !== selection.baseline
  useUnSavedBlocker(dirty || preferencesDirty)

  useEffect(() => {
    const controller = new AbortController()
    requestRef.current?.abort()
    setEditor(null)
    setEffective(null)
    setUpgrade(null)
    setSelection(null)
    setUnsupported(null)
    setError(null)
    setStatus(false)
    setLoading(true)
    setBusy(false)
    if (!ownerId) {
      setLoading(false)
      return () => controller.abort()
    }
    void Promise.all([
      client.load(controller.signal),
      client.loadEffective(controller.signal),
      client.previewUpgrade(controller.signal),
    ])
      .then(([draft, published, migration]) => {
        if (controller.signal.aborted || activeOwnerRef.current !== ownerId) return
        if (
          draft.config.ownerId !== ownerId ||
          (published.config && published.config.ownerId !== ownerId)
        )
          throw new Error("owner_mismatch")
        setEditor(draft)
        setEffective(published)
        setUpgrade(migration)
        // 来源快捷入口沿用同一单规则编辑器；没有匹配规则时只预填内存草稿。
        const context = parseProcessingRuleContext(window.location.search)
        const rule = context
          ? (findProcessingRuleForContext(draft.config.rules, context) ??
            newLocalRule(
              draft.config,
              t("automation.editor.new_name"),
              processingRuleCondition(context),
            ))
          : draft.config.rules[0]
        if (rule) setSelection({ rule, baseline: JSON.stringify(rule) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("request")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      requestRef.current?.abort()
    }
  }, [ownerId, reload, t])

  const guarded = (action: () => void) => {
    if (busy || preferencesBusy) return
    if (!dirty && !preferencesDirty) return action()
    ask({
      title: t("automation.editor.discard_title"),
      message: t("automation.editor.discard_hint"),
      variant: "ask",
      onConfirm: action,
    })
  }
  const choose = (rule: AutomationRule, legacy?: LocalActionMigrationTarget) => {
    setSelection({ rule: structuredClone(rule), baseline: JSON.stringify(rule), legacy })
    setUnsupported(null)
    setPanel("rules")
    setError(null)
    setStatus(false)
    setSample("")
  }
  const create = () =>
    guarded(() => {
      if (!editor) return
      choose(newLocalRule(editor.config, t("automation.editor.new_name")))
    })
  const chooseLegacy = (rule: ActionItem, index: number) =>
    guarded(() => {
      if (!editor || !ownerId) return
      const conversion = convertLocalActionRule(rule, {
        ownerId,
        order: editor.config.rules.length,
      })
      if (!conversion.success) {
        setUnsupported(index)
        setSelection(null)
        setPanel("rules")
        return
      }
      choose(conversion.rule, {
        localId: rule.localId,
        index,
        name: rule.name ?? "",
        condition: structuredClone(rule.condition),
        result: structuredClone(rule.result),
      })
    })
  const applyActivation = (result: RuleActivation) => {
    setEditor(
      (current) =>
        current && {
          ...current,
          revision: result.revision,
          config: result.config,
          releases: [result.release, ...current.releases],
        },
    )
    setEffective(
      (current) =>
        current && {
          ...current,
          revision: result.revision,
          config: result.effectiveConfig,
          releaseVersion: result.release.version,
        },
    )
    notifyLocalAutomationChanged()
  }
  const upgradeExisting = async () => {
    if (!upgrade?.required || !upgrade.supported || !ownerId || busy) return
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    setError(null)
    try {
      const result = await client.upgradeRules(
        upgrade.expectedRevision,
        upgrade.expectedScheduleRevision,
        crypto.randomUUID(),
        controller.signal,
      )
      if (controller.signal.aborted || activeOwnerRef.current !== ownerId) return
      applyActivation(result)
      setUpgrade({ ...upgrade, required: false })
      const next =
        result.config.rules.find((item) => item.id === selection?.rule.id) ?? result.config.rules[0]
      setSelection(next ? { rule: next, baseline: JSON.stringify(next) } : null)
      setStatus(true)
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof ProcessingRequestError && cause.kind === "conflict"
            ? "conflict"
            : "request",
        )
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const save = async () => {
    if (!selection || !editor || !ownerId || busy) return
    if (!ruleSchema.safeParse(selection.rule).success) {
      setError("invalid")
      return
    }
    const controller = new AbortController()
    requestRef.current = controller
    const captured = selection
    setBusy(true)
    setError(null)
    setStatus(false)
    try {
      const result = await client.activateRule(
        captured.rule,
        editor.revision,
        crypto.randomUUID(),
        controller.signal,
      )
      if (controller.signal.aborted || activeOwnerRef.current !== ownerId) return
      applyActivation(result)
      const savedRule = result.config.rules.find((rule) => rule.id === captured.rule.id)!
      let legacy = captured.legacy
      if (legacy) {
        // 发布成功后才精确停用旧副本；存储失败或原规则已变更时保留并明确告知。
        try {
          setPublishedLocalFilters({
            ownerId,
            ruleSet: result.effectiveConfig,
            sources: editor.sources,
            sourceTags: editor.sourceTags,
            listMemberships: editor.listMemberships,
          })
          const switched = localActionSyncService.disablePublishedMigrationTargets(ownerId, [
            legacy,
          ])
          if (switched.switched) legacy = undefined
          else setError("migration")
        } catch {
          setError("migration")
        }
      } else {
        // 已发布普通动作立即更新到本页，避免等定时刷新才生效。
        setPublishedLocalFilters({
          ownerId,
          ruleSet: result.effectiveConfig,
          sources: editor.sources,
          sourceTags: editor.sourceTags,
          listMemberships: editor.listMemberships,
        })
      }
      setSelection({ rule: savedRule, baseline: JSON.stringify(savedRule), legacy })
      setStatus(true)
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof ProcessingRequestError && cause.kind === "conflict"
            ? "conflict"
            : "request",
        )
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const remove = () => {
    if (!selection || !editor || !ownerId) return
    const rule = selection.rule
    ask({
      title: t("automation.editor.delete_title"),
      message: t("automation.editor.delete_hint"),
      variant: "ask",
      onConfirm: async () => {
        const controller = new AbortController()
        requestRef.current = controller
        setBusy(true)
        setError(null)
        try {
          const result = await client.deleteRule(
            rule.id,
            editor.revision,
            crypto.randomUUID(),
            controller.signal,
          )
          if (controller.signal.aborted || activeOwnerRef.current !== ownerId) return
          applyActivation(result)
          setSelection(null)
          setStatus(true)
        } catch (cause) {
          if (!controller.signal.aborted)
            setError(
              cause instanceof ProcessingRequestError && cause.kind === "conflict"
                ? "conflict"
                : "request",
            )
        } finally {
          if (!controller.signal.aborted) setBusy(false)
        }
      },
    })
  }
  const rule = selection?.rule
  const previewConfig = useMemo(() => {
    if (!rule || !editor) return null
    // 草稿中的其它规则不进入这条规则的试运行，基准使用已发布配置。
    return replaceLocalRule(effective?.config ?? { ...editor.config, rules: [] }, rule)
  }, [rule, editor, effective])
  const currentSample = editor?.items.find(
    (item) => JSON.stringify([item.sourceKey, item.id]) === sample,
  )
  const saved = rule && editor?.config.rules.some((item) => item.id === rule.id)

  return (
    <section
      className="flex min-h-0 w-full flex-1 flex-col gap-4"
      aria-label={t("automation.editor.title")}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("automation.editor.title")}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t("automation.editor.description")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={processingButtonClass}
            disabled={!editor || busy}
            onClick={create}
          >
            {t("automation.editor.create")}
          </button>
          <button
            type="button"
            className={processingButtonClass}
            disabled={!editor || busy}
            onClick={() =>
              guarded(() => {
                setPanel(panel === "rules" ? "settings" : "rules")
                setSelection(null)
              })
            }
          >
            {t(panel === "rules" ? "automation.editor.preferences" : "automation.editor.back")}
          </button>
          <a className={processingButtonClass} href="/action?scope=cloud">
            {t("automation.editor.cloud")}
          </a>
        </div>
      </header>
      {loading && <p role="status">{t("automation.editor.loading")}</p>}
      {!ownerId && <p>{t("automation.editor.login")}</p>}
      {error && (
        <div role="alert" className="rounded-lg bg-red/10 p-3 text-sm text-red">
          {t(`automation.editor.error_${error}`)}
          {(error === "conflict" || (!editor && error === "request")) && (
            <button
              className={`${processingButtonClass} ml-3`}
              type="button"
              onClick={() => guarded(() => setReload((value) => value + 1))}
            >
              {t("automation.editor.reload")}
            </button>
          )}
        </div>
      )}
      {status && !error && (
        <p role="status" className="text-sm text-green">
          {t("automation.editor.saved")}
        </p>
      )}
      {upgrade?.required && (
        <div className="space-y-2 rounded-xl border border-orange p-4 text-sm">
          <p>{t("automation.editor.upgrade_scope", { count: upgrade.sourceCount })}</p>
          <p className="text-text-secondary">
            {upgrade.affectedRules.map((item) => item.name).join("、")}
          </p>
          {upgrade.supported ? (
            <button
              className={processingButtonClass}
              disabled={busy}
              type="button"
              onClick={() =>
                guarded(() => {
                  void upgradeExisting()
                })
              }
            >
              {t("automation.editor.upgrade_scope_button")}
            </button>
          ) : (
            <p role="alert">{t("automation.editor.upgrade_scope_unsupported")}</p>
          )}
        </div>
      )}
      {editor && panel === "settings" && (
        <LocalAutomationPreferences
          key={ownerId}
          editor={editor}
          effective={effective}
          onSaved={applyActivation}
          onDirty={setPreferencesDirty}
          onBusy={setPreferencesBusy}
          migrationRequired={upgrade?.required ?? false}
        />
      )}
      {editor && panel === "rules" && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <nav
            className="max-h-56 overflow-auto rounded-xl border border-fill-secondary md:max-h-none md:w-60 md:shrink-0"
            aria-label={t("automation.editor.rules")}
          >
            {editor.config.rules.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={busy}
                onClick={() => guarded(() => choose(item))}
                aria-current={rule?.id === item.id ? "true" : undefined}
                className={`flex w-full flex-col gap-1 border-b border-fill-secondary p-3 text-left last:border-b-0 ${rule?.id === item.id ? "bg-fill-secondary" : "hover:bg-fill-quinary"}`}
              >
                <span className="truncate text-sm font-medium">{item.name}</span>
                <span className="text-xs text-text-secondary">
                  {t(
                    localRuleUsesAI(item)
                      ? "automation.editor.ai_rule"
                      : "automation.editor.basic_rule",
                  )}{" "}
                  · {t(item.enabled ? "processing.enabled" : "automation.editor.disabled")}
                </span>
              </button>
            ))}
            {legacyRules.map((item, index) => {
              // 已完成升级的旧记录保留在兼容存储里，但不在主列表重复呈现。
              if (
                item.result.disabled &&
                item.localId &&
                editor.config.rules.some((existing) => existing.id === `local-${item.localId}`)
              )
                return null
              return (
                <button
                  type="button"
                  key={item.localId ?? index}
                  disabled={busy}
                  onClick={() => chooseLegacy(item, index)}
                  className="flex w-full flex-col gap-1 border-b border-fill-secondary p-3 text-left hover:bg-fill-quinary"
                >
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <span className="text-xs text-text-secondary">
                    {t("automation.editor.existing_local")}
                  </span>
                </button>
              )
            })}
            {!editor.config.rules.length && !legacyRules.length && (
              <p className="p-4 text-sm text-text-secondary">{t("automation.editor.empty")}</p>
            )}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-fill-secondary p-5">
            {unsupported !== null ? (
              <div className="space-y-3">
                <p>{t("automation.editor.unsupported")}</p>
                <a
                  className={processingButtonClass}
                  href={`/action?scope=local&legacy=local&ruleIndex=${unsupported}`}
                >
                  {t("automation.editor.legacy_edit")}
                </a>
              </div>
            ) : rule ? (
              <div className="mx-auto max-w-3xl space-y-6">
                <fieldset disabled={busy} className="space-y-6 disabled:opacity-60">
                  <div className="flex flex-wrap items-end gap-4">
                    <label className="min-w-48 flex-1 space-y-2 text-sm">
                      <span>{t("processing.name")}</span>
                      <input
                        className={processingInputClass}
                        value={rule.name}
                        maxLength={200}
                        onChange={(event) =>
                          setSelection({
                            ...selection,
                            rule: { ...rule, name: event.target.value },
                          } as Selection)
                        }
                      />
                    </label>
                    <label className="flex items-center gap-2 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(event) =>
                          setSelection({
                            ...selection,
                            rule: { ...rule, enabled: event.target.checked },
                          } as Selection)
                        }
                      />
                      {t("processing.enabled")}
                    </label>
                  </div>
                  <section className="space-y-3">
                    <h3 className="font-medium">{t("automation.editor.when")}</h3>
                    <ProcessingConditionEditor
                      value={rule.when}
                      sources={editor.sources}
                      tags={editor.subscriptionTags.tags}
                      listMemberships={editor.listMemberships}
                      sourceInventoryKnown={editor.sourceInventoryKnown}
                      onChange={(when) =>
                        setSelection({ ...selection, rule: { ...rule, when } } as Selection)
                      }
                    />
                  </section>
                  <section className="space-y-3">
                    <h3 className="font-medium">{t("automation.editor.then")}</h3>
                    <LocalRuleActions
                      actions={rule.actions}
                      onChange={(actions) =>
                        setSelection({ ...selection, rule: { ...rule, actions } } as Selection)
                      }
                      sources={editor.sources}
                      tags={editor.subscriptionTags.tags}
                      listMemberships={editor.listMemberships}
                      sourceInventoryKnown={editor.sourceInventoryKnown}
                    />
                  </section>
                </fieldset>
                {selection?.legacy && (
                  <p className="text-xs text-text-secondary">
                    {t("automation.editor.upgrade_hint")}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`${processingButtonClass} bg-accent text-white`}
                    disabled={busy || upgrade?.required}
                    onClick={() => void save()}
                  >
                    {t(busy ? "automation.editor.saving" : "automation.editor.save")}
                  </button>
                  {saved && (
                    <button
                      type="button"
                      className={processingButtonClass}
                      disabled={busy}
                      onClick={remove}
                    >
                      {t("processing.remove")}
                    </button>
                  )}
                </div>
                <p className="text-xs text-text-secondary">{t("automation.editor.future_hint")}</p>
                {previewConfig && localRuleUsesAI(rule) && (
                  <details className="rounded-lg border border-fill-secondary p-3">
                    <summary className="cursor-pointer text-sm">
                      {t("automation.editor.try")}
                    </summary>
                    <div className="mt-3 space-y-3">
                      <select
                        className={processingInputClass}
                        aria-label={t("automation.editor.sample")}
                        value={sample}
                        onChange={(event) => setSample(event.target.value)}
                      >
                        <option value="">{t("automation.editor.sample")}</option>
                        {editor.items.map((item) => (
                          <option
                            key={JSON.stringify([item.sourceKey, item.id])}
                            value={JSON.stringify([item.sourceKey, item.id])}
                          >
                            {item.title}
                          </option>
                        ))}
                      </select>
                      <ProcessingTrialPanel
                        config={previewConfig}
                        sourceKey={currentSample?.sourceKey}
                        entryId={currentSample?.id}
                        valid={ruleSchema.safeParse(rule).success}
                      />
                    </div>
                  </details>
                )}
              </div>
            ) : (
              <p className="text-sm text-text-secondary">{t("automation.editor.select")}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
