import type { AutomationRule, MigratedActionRule, RuleSet } from "@follow/information-core"
import { ruleSetSchema } from "@follow/information-core"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useDialog } from "~/components/ui/modal/stacked/hooks"

import { getOneTimeToken } from "../ai-chat/local-provider"
import { ProcessingActionEditor } from "./processing-action-editor"
import type {
  ProcessingEditor,
  ProcessingInput,
  ProcessingPreview,
  ProcessingRelease,
  ProcessingReleaseScope,
  ProcessingRun,
  ProcessingSchedule,
  ProcessingScheduleConfig,
} from "./processing-client"
import { createProcessingClient, ProcessingRequestError } from "./processing-client"
import {
  processingButtonClass,
  ProcessingConditionEditor,
  processingInputClass,
} from "./processing-condition-editor"
import { ProcessingMigrationPreview } from "./processing-migration-preview"
import { ProcessingPresetPicker } from "./processing-preset-picker"
import { defaultProcessingSchedule, ProcessingRunSettings } from "./processing-run-settings"
import { ProcessingTags } from "./processing-tags"
import { useUnSavedBlocker } from "./use-unsaved-blocker"

const client = createProcessingClient(getOneTimeToken)
type TransferStatus =
  | "processing.transfer_copied"
  | "processing.transfer_failed"
  | "processing.transfer_exported"
  | "processing.transfer_imported"
  | "processing.transfer_invalid"
export function ProcessingSetting({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const { t } = useTranslation("app")
  const { ask } = useDialog()
  const [editor, setEditor] = useState<ProcessingEditor | null>(null)
  const [draft, setDraft] = useState<RuleSet | null>(null)
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState<ProcessingRequestError["kind"] | null>(null)
  const [sample, setSample] = useState("")
  const [preview, setPreview] = useState<ProcessingPreview | null>(null)
  const [saved, setSaved] = useState(false)
  const [schedule, setSchedule] = useState<ProcessingSchedule | null>(null)
  const [scheduleDraft, setScheduleDraft] = useState<ProcessingScheduleConfig | null>(null)
  const [inputs, setInputs] = useState<ProcessingInput[]>([])
  const [runs, setRuns] = useState<ProcessingRun[]>([])
  const [release, setRelease] = useState<ProcessingRelease | null>(null)
  const [releaseScope, setReleaseScope] = useState<ProcessingReleaseScope>({ mode: "future" })
  const [recentSince, setRecentSince] = useState(() => new Date().toISOString().slice(0, 10))
  const [selectedInputIds, setSelectedInputIds] = useState<number[]>([])
  const [scheduleBusy, setScheduleBusy] = useState(false)
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [runBusy, setRunBusy] = useState(false)
  const [transferStatus, setTransferStatus] = useState<TransferStatus | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const draftRef = useRef<RuleSet | null>(null)
  const editorRef = useRef<ProcessingEditor | null>(null)
  const dirty = !!draft && !!editor && JSON.stringify(draft) !== JSON.stringify(editor.config)
  const scheduleDirty =
    !!scheduleDraft && JSON.stringify(scheduleDraft) !== JSON.stringify(schedule?.config ?? null)
  const valid = !!draft && ruleSetSchema.safeParse(draft).success
  // 刷新后使用服务端发布记录恢复运行资格；旧 revision 的发布不能解锁当前新草稿。
  const currentRevisionPublished =
    !!release || !!editor?.releases.some((item) => item.draftRevision === editor.revision)
  const canRun =
    !!schedule?.config &&
    schedule.config.sourceKeys.length > 0 &&
    schedule.config.times.length > 0 &&
    currentRevisionPublished &&
    !dirty &&
    !scheduleDirty
  const scheduleValid =
    !scheduleDraft ||
    (() => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: scheduleDraft.timeZone }).format()
        return true
      } catch {
        return false
      }
    })()
  useUnSavedBlocker(dirty || scheduleDirty)
  useEffect(() => {
    onDirty(dirty || scheduleDirty || busy || scheduleBusy || releaseBusy || runBusy)
    return () => onDirty(false)
  }, [dirty, scheduleDirty, busy, scheduleBusy, releaseBusy, runBusy, onDirty])

  const reportError = (cause: unknown) => {
    const kind = cause instanceof ProcessingRequestError ? cause.kind : "request"
    setError(kind)
    if (kind === "authorization") {
      setVerified(false)
      setEditor(null)
      setDraft(null)
      draftRef.current = null
      editorRef.current = null
    }
  }
  const loadRunData = useCallback(async () => {
    const controller = new AbortController()
    const scheduleLoader = typeof client.loadSchedule === "function" ? client.loadSchedule : null
    const inputLoader = typeof client.loadInputs === "function" ? client.loadInputs : null
    const runsLoader = typeof client.loadRuns === "function" ? client.loadRuns : null
    if (!scheduleLoader && !inputLoader && !runsLoader) return
    try {
      const [scheduleData, inputData, runData] = await Promise.all([
        scheduleLoader ? scheduleLoader(controller.signal) : Promise.resolve(null),
        inputLoader ? inputLoader(controller.signal) : Promise.resolve(null),
        runsLoader ? runsLoader(controller.signal) : Promise.resolve(null),
      ])
      if (controller.signal.aborted) return
      if (scheduleData) {
        setSchedule(scheduleData)
        setScheduleDraft(scheduleData.config)
      }
      if (inputData) setInputs(inputData.inputs)
      if (runData) setRuns(runData.runs)
    } catch (cause) {
      if (!controller.signal.aborted) reportError(cause)
    }
  }, [])
  const refresh = useCallback(
    async (preserve = true) => {
      requestRef.current?.abort()
      const controller = new AbortController()
      requestRef.current = controller
      setBusy(true)
      setVerified(false)
      setPreview(null)
      setError(null)
      try {
        const data = await client.load(controller.signal)
        if (controller.signal.aborted) return
        const old = editorRef.current,
          local = draftRef.current
        const keep =
          preserve &&
          old &&
          local &&
          old.config.ownerId === data.config.ownerId &&
          JSON.stringify(local) !== JSON.stringify(old.config)
        // 另一个页面已保存时保留本地输入与旧 revision，让用户先处理冲突，不能盲目覆盖。
        if (keep && old.revision !== data.revision) {
          setError("conflict")
          setVerified(true)
          return
        }
        editorRef.current = data
        setEditor(data)
        setRelease(null)
        if (!keep) {
          draftRef.current = data.config
          setDraft(data.config)
        }
        setVerified(true)
        void loadRunData()
      } catch (cause) {
        if (!controller.signal.aborted) reportError(cause)
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    },
    [loadRunData],
  )
  useEffect(() => {
    void refresh()
    const visibility = () => {
      // 页面隐藏后不展示旧账号数据；回到页面先重新核验，当前草稿只在同账号下保留。
      if (document.visibilityState === "visible") void refresh()
      else {
        requestRef.current?.abort()
        setVerified(false)
        setBusy(false)
      }
    }
    document.addEventListener("visibilitychange", visibility)
    return () => {
      requestRef.current?.abort()
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [refresh])

  const change = (next: RuleSet) => {
    draftRef.current = next
    setDraft(next)
    setPreview(null)
    setSaved(false)
    setRelease(null)
  }
  const importMigratedRules = (rules: readonly MigratedActionRule[]) => {
    if (!draft) return
    const firstOrder = Math.max(-1, ...draft.rules.map((rule) => rule.order)) + 1
    const imported = rules.map((rule, index) => ({
      ...rule,
      id: crypto.randomUUID(),
      ownerId: draft.ownerId,
      order: firstOrder + index,
      version: 1,
    }))
    // 迁移只追加到当前草稿并标记未保存，旧云端／本地规则和发布记录保持不变。
    change({ ...draft, rules: [...draft.rules, ...imported] })
  }
  const editRule = (id: string, next: AutomationRule) => {
    if (draft)
      change({ ...draft, rules: draft.rules.map((rule) => (rule.id === id ? next : rule)) })
  }
  const save = async () => {
    if (!draft || !editor || !valid) return
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result = await client.save(draft, editor.revision, controller.signal)
      if (controller.signal.aborted) return
      const data = { ...editor, ...result }
      editorRef.current = data
      setEditor(data)
      draftRef.current = result.config
      setDraft(result.config)
      setRelease(null)
      setSaved(true)
    } catch (cause) {
      if (!controller.signal.aborted) reportError(cause)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const runPreview = async () => {
    const item = editor?.items.find((item) => JSON.stringify([item.sourceKey, item.id]) === sample)
    if (!item || !draft || !valid) return
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const result = await client.preview(draft, item.sourceKey, item.id, controller.signal)
      if (!controller.signal.aborted) setPreview(result)
    } catch (cause) {
      if (!controller.signal.aborted) reportError(cause)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const saveSchedule = async () => {
    if (!editor || typeof client.saveSchedule !== "function") return
    const controller = new AbortController()
    setScheduleBusy(true)
    setError(null)
    try {
      const config = scheduleDraft ?? defaultProcessingSchedule()
      const result = await client.saveSchedule(config, schedule?.revision ?? 0, controller.signal)
      if (controller.signal.aborted) return
      setSchedule(result)
      setScheduleDraft(result.config)
    } catch (cause) {
      if (!controller.signal.aborted) reportError(cause)
    } finally {
      if (!controller.signal.aborted) setScheduleBusy(false)
    }
  }
  const releaseRuleSet = async () => {
    if (!editor || dirty || typeof client.releaseRuleSet !== "function") return
    const controller = new AbortController()
    setReleaseBusy(true)
    setError(null)
    try {
      const result = await client.releaseRuleSet(
        editor.revision,
        releaseScope,
        crypto.randomUUID(),
        controller.signal,
      )
      if (!controller.signal.aborted) setRelease(result)
    } catch (cause) {
      if (!controller.signal.aborted) reportError(cause)
    } finally {
      if (!controller.signal.aborted) setReleaseBusy(false)
    }
  }
  const runNow = async () => {
    if (!canRun || typeof client.startRun !== "function") return
    const controller = new AbortController()
    setRunBusy(true)
    setError(null)
    try {
      await client.startRun(crypto.randomUUID(), controller.signal)
      if (!controller.signal.aborted) void loadRunData()
    } catch (cause) {
      if (!controller.signal.aborted) reportError(cause)
    } finally {
      if (!controller.signal.aborted) setRunBusy(false)
    }
  }
  const copyDraft = async () => {
    if (!draft) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2))
      setTransferStatus("processing.transfer_copied")
    } catch (cause) {
      if (cause) setTransferStatus("processing.transfer_failed")
    }
  }
  const exportDraft = () => {
    if (!draft) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "folo-processing-draft.json"
    anchor.click()
    URL.revokeObjectURL(url)
    setTransferStatus("processing.transfer_exported")
  }
  const importDraft = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.currentTarget.value = ""
    if (!file || !editor) return
    try {
      const raw = JSON.parse(await file.text()) as unknown
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_draft")
      const object = raw as Record<string, unknown>
      const normalizedRules = Array.isArray(object.rules)
        ? object.rules.map((rule) =>
            rule && typeof rule === "object" && !Array.isArray(rule)
              ? { ...(rule as Record<string, unknown>), ownerId: editor.config.ownerId }
              : rule,
          )
        : object.rules
      const parsed = ruleSetSchema.safeParse({
        ...object,
        ownerId: editor.config.ownerId,
        rules: normalizedRules,
      })
      if (!parsed.success) throw new Error("invalid_draft")
      // 导入只替换本地草稿；发布和运行仍需用户分别点击对应按钮。
      change(parsed.data)
      setTransferStatus("processing.transfer_imported")
    } catch {
      setTransferStatus("processing.transfer_invalid")
    }
  }
  const reload = () => {
    if (dirty)
      ask({
        title: t("processing.reload"),
        message: t("processing.discard"),
        variant: "ask",
        onConfirm: () => void refresh(false),
      })
    else void refresh(false)
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto pb-12" aria-label={t("processing.title")}>
      <div className="mx-auto max-w-4xl space-y-6 pr-2">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t("processing.title")}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t("processing.description")}</p>
          </div>
          <button type="button" className={processingButtonClass} disabled={busy} onClick={reload}>
            {t("processing.reload")}
          </button>
        </header>
        {error && (
          <p role="alert" className="rounded-lg bg-red/10 p-3 text-sm text-red">
            {t(`processing.error.${error}`)}
          </p>
        )}
        {!verified && (
          <p role="status" className="text-sm text-text-secondary">
            {busy ? t("processing.loading") : t("processing.verify_required")}
          </p>
        )}
        {verified && editor && draft && (
          <>
            <div className="rounded-xl border border-fill-secondary bg-fill-quinary p-4 text-sm">
              <p>
                {t("processing.draft_revision", { revision: editor.revision })} ·{" "}
                {dirty ? t("processing.unsaved") : t("processing.saved")}
              </p>
              <p className="mt-1 text-text-secondary">
                {editor.releases.length
                  ? t("processing.last_release", {
                      version: editor.releases[0]!.version,
                      revision: editor.releases[0]!.draftRevision,
                    })
                  : t("processing.no_release")}
              </p>
              {!editor.capabilities.automaticProcessing && (
                <p className="mt-2 text-text-secondary">{t("processing.not_automatic")}</p>
              )}
            </div>
            <ProcessingTags editor={editor} refresh={refresh} />
            <fieldset disabled={busy} className="space-y-6 disabled:opacity-60">
              <label className="block space-y-2">
                <span className="font-medium">{t("processing.global")}</span>
                <span className="block text-sm text-text-secondary">
                  {t("processing.global_hint")}
                </span>
                <ProcessingPresetPicker
                  targets={["global"]}
                  initialTarget="global"
                  currentPrompt={draft.global.markdown}
                  currentPreset={draft.global.preset}
                  onApply={(application) => {
                    if (application.target === "global" && "markdown" in application.patch)
                      change({
                        ...draft,
                        global: {
                          ...draft.global,
                          markdown: application.patch.markdown,
                          preset: application.presetRef,
                        },
                      })
                  }}
                />
                <textarea
                  className={processingInputClass}
                  rows={6}
                  maxLength={60000}
                  value={draft.global.markdown}
                  onChange={(e) =>
                    change({ ...draft, global: { ...draft.global, markdown: e.target.value } })
                  }
                />
              </label>
              <div className="flex items-center justify-between">
                <h3 className="font-medium">{t("processing.rules")}</h3>
                <button
                  type="button"
                  className={processingButtonClass}
                  onClick={() =>
                    change({
                      ...draft,
                      rules: [
                        ...draft.rules,
                        {
                          id: crypto.randomUUID(),
                          ownerId: draft.ownerId,
                          name: t("processing.new_rule", { count: draft.rules.length + 1 }),
                          enabled: true,
                          order: Math.max(-1, ...draft.rules.map((rule) => rule.order)) + 1,
                          version: 1,
                          executionLocation: "processing_service",
                          when: { all: true },
                          actions: [{ type: "ai_transform", prompt: "" }],
                        },
                      ],
                    })
                  }
                >
                  {t("processing.add_rule")}
                </button>
              </div>
              {draft.rules.map((rule, index) => (
                <article
                  key={rule.id}
                  className="space-y-4 rounded-xl border border-fill-secondary p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label={t("processing.name")}
                      className={`${processingInputClass} min-w-40 flex-1`}
                      value={rule.name}
                      onChange={(e) => editRule(rule.id, { ...rule, name: e.target.value })}
                    />
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => editRule(rule.id, { ...rule, enabled: e.target.checked })}
                      />
                      {t("processing.enabled")}
                    </label>
                    {([-1, 1] as const).map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        aria-label={t(
                          direction < 0 ? "processing.move_up" : "processing.move_down",
                        )}
                        className={processingButtonClass}
                        disabled={index + direction < 0 || index + direction >= draft.rules.length}
                        onClick={() => {
                          const rules = [...draft.rules]
                          ;[rules[index], rules[index + direction]] = [
                            rules[index + direction]!,
                            rules[index]!,
                          ]
                          change({
                            ...draft,
                            rules: rules.map((item, order) => ({ ...item, order })),
                          })
                        }}
                      >
                        {direction < 0 ? "↑" : "↓"}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={processingButtonClass}
                      onClick={() =>
                        change({
                          ...draft,
                          rules: draft.rules
                            .filter((item) => item.id !== rule.id)
                            .map((item, order) => ({ ...item, order })),
                        })
                      }
                    >
                      {t("processing.remove")}
                    </button>
                  </div>
                  <ProcessingConditionEditor
                    value={rule.when}
                    sources={editor.sources}
                    tags={editor.subscriptionTags.tags}
                    listMemberships={editor.listMemberships}
                    sourceInventoryKnown={editor.sourceInventoryKnown ?? false}
                    onChange={(when) => editRule(rule.id, { ...rule, when })}
                  />
                  <ProcessingActionEditor
                    actions={rule.actions}
                    sources={editor.sources}
                    tags={editor.subscriptionTags.tags}
                    listMemberships={editor.listMemberships}
                    sourceInventoryKnown={editor.sourceInventoryKnown ?? false}
                    onChange={(actions) => editRule(rule.id, { ...rule, actions })}
                  />
                </article>
              ))}
              {!valid && (
                <p role="alert" className="text-sm text-red">
                  {t("processing.invalid_draft")}
                </p>
              )}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className={`${processingButtonClass} bg-accent text-white`}
                  disabled={!dirty || !valid}
                  onClick={() => void save()}
                >
                  {t("processing.save")}
                </button>
                {saved && (
                  <span role="status" className="text-sm text-green">
                    {t("processing.saved_hint")}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={processingButtonClass}
                  onClick={() => void copyDraft()}
                >
                  {/* 成功文案只在复制完成后显示，按钮使用操作名称。 */}
                  {t("words.copy", { ns: "common" })}
                </button>
                <button type="button" className={processingButtonClass} onClick={exportDraft}>
                  {t("processing.transfer_export")}
                </button>
                <label className={processingButtonClass}>
                  {t("processing.transfer_import")}
                  <input
                    className="sr-only"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => void importDraft(event)}
                  />
                </label>
                {transferStatus && (
                  <span role="status" className="text-sm text-text-secondary">
                    {t(transferStatus)}
                  </span>
                )}
              </div>
              <ProcessingMigrationPreview onImport={importMigratedRules} />
              <section className="space-y-3 rounded-xl border border-fill-secondary p-4">
                <h3 className="font-medium">{t("processing.preview")}</h3>
                <p className="text-sm text-text-secondary">{t("processing.preview_hint")}</p>
                <select
                  aria-label={t("processing.sample")}
                  className={processingInputClass}
                  value={sample}
                  onChange={(e) => {
                    setSample(e.target.value)
                    setPreview(null)
                  }}
                >
                  <option value="">{t("processing.choose_sample")}</option>
                  {editor.items.map((item) => (
                    <option
                      key={JSON.stringify([item.sourceKey, item.id])}
                      value={JSON.stringify([item.sourceKey, item.id])}
                    >
                      {item.title} ·{" "}
                      {editor.sources.find((source) => source.key === item.sourceKey)?.title ??
                        item.sourceKey}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={processingButtonClass}
                  disabled={!sample || !valid}
                  onClick={() => void runPreview()}
                >
                  {t("processing.run_preview")}
                </button>
                {preview && (
                  <div className="space-y-3 text-sm" aria-live="polite">
                    <p>
                      {t(
                        preview.material === "missing"
                          ? "processing.missing_material"
                          : "processing.raw_material",
                      )}
                    </p>
                    {preview.blocksFinalPresentation && (
                      <p className="text-orange">{t("processing.pending_rules")}</p>
                    )}
                    {preview.matches.map((match) => (
                      <p key={match.ruleId}>
                        {draft.rules.find((rule) => rule.id === match.ruleId)?.name}：
                        {t(`processing.match.${match.state}`)}
                      </p>
                    ))}
                    <p>{t("processing.global_included")}</p>
                    {preview.transformations.map((item, index) => (
                      <p
                        key={`${item.ruleId}/${index}`}
                        className="whitespace-pre-wrap rounded-lg bg-fill-quinary p-3"
                      >
                        {item.prompt}
                      </p>
                    ))}
                    {(["standalone", "aggregation", "rewrite"] as const)
                      .filter((field) => preview.policy[field] !== undefined)
                      .map((field) => (
                        <p key={field}>
                          {t(`processing.policy.${field}`)}：
                          {t(`processing.policy_value.${preview.policy[field]!}`)}
                        </p>
                      ))}
                    {preview.display.language && (
                      <p>
                        {t("processing.language")}：{preview.display.language}
                      </p>
                    )}
                    {preview.display.summaryMaxGraphemes && (
                      <p>
                        {t("processing.summary_length")}：{preview.display.summaryMaxGraphemes}
                      </p>
                    )}
                    {preview.shadowed.map((item, index) => (
                      <p key={index} className="text-text-secondary">
                        {t("processing.shadowed", {
                          rule: draft.rules.find((rule) => rule.id === item.ruleId)?.name,
                          winner: draft.rules.find((rule) => rule.id === item.winnerRuleId)?.name,
                        })}
                      </p>
                    ))}
                  </div>
                )}
              </section>
            </fieldset>
            <ProcessingRunSettings
              sources={editor.sources}
              inputs={inputs}
              runs={runs}
              value={scheduleDraft}
              scope={releaseScope}
              recentSince={recentSince}
              selectedInputIds={selectedInputIds}
              release={release}
              ruleConfig={draft}
              releases={editor.releases}
              draftDirty={dirty}
              saving={scheduleBusy}
              releasing={releaseBusy}
              running={runBusy}
              canRun={canRun}
              scheduleValid={scheduleValid}
              onChange={setScheduleDraft}
              onScopeChange={setReleaseScope}
              onRecentSinceChange={setRecentSince}
              onSelectedInputIdsChange={setSelectedInputIds}
              onSave={() => void saveSchedule()}
              onRelease={() => void releaseRuleSet()}
              onRun={() => void runNow()}
              onRestoreRelease={(config) =>
                ask({
                  title: t("processing.release_history.restore"),
                  message: t("processing.release_history.restore_hint"),
                  variant: "ask",
                  // 历史版本只复制到未保存草稿，回退仍生成新发布与新的生效范围。
                  onConfirm: () => change(config),
                })
              }
            />
          </>
        )}
      </div>
    </section>
  )
}
