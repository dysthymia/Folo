import { semanticEntityId, semanticTagDefinitions } from "@follow/information-core"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type {
  EntrySemanticProfile,
  EntrySemanticResponse,
  SemanticOverrideState,
} from "./processing-semantic-client"
import { loadEntrySemantics, saveEntrySemanticOverride } from "./processing-semantic-client"
import { ProcessingSignals } from "./ProcessingSignals"

export function EntrySemanticPanel({
  profile,
  inputSeq,
  contentVersion,
}: {
  profile: EntrySemanticProfile
  inputSeq: number
  contentVersion: string
}) {
  const { t } = useTranslation("app")
  const [editing, setEditing] = useState(false)
  const [loaded, setLoaded] = useState<EntrySemanticResponse | null>(null)
  const [tagId, setTagId] = useState(semanticTagDefinitions[0]!.id)
  const [correction, setCorrection] = useState<SemanticOverrideState>("present")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  useEffect(() => () => requestRef.current?.abort(), [])

  const load = async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    setError(false)
    setLoaded(null)
    setSaved(false)
    try {
      const result = await loadEntrySemantics(inputSeq, controller.signal)
      // 即使输入索引没变，也不能把新版正文的判断用于当前打开的旧正文。
      if (result.profile?.contentVersion !== contentVersion) throw new Error("stale_semantics")
      setLoaded(result)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const save = async () => {
    if (!loaded || busy) return
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    setError(false)
    setSaved(false)
    try {
      const result = await saveEntrySemanticOverride(
        inputSeq,
        contentVersion,
        loaded.overrideRevision,
        tagId,
        correction,
        controller.signal,
      )
      if (result.profile?.contentVersion !== contentVersion) throw new Error("stale_semantics")
      setLoaded(result)
      setSaved(true)
      // 列表标签与详情共用当前人工修订，保存后立即刷新批量投影。
      window.dispatchEvent(new Event("processing-reading-invalidated"))
    } catch {
      if (!controller.signal.aborted) {
        setError(true)
        // 冲突后要求重新加载；保留已选标签和动作，不盲目重试覆盖新修订。
        setLoaded(null)
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const effectiveProfile = loaded?.profile ?? profile
  return (
    <section className="space-y-3 rounded-lg border border-fill-secondary p-3">
      <ProcessingSignals
        signals={{
          materialCoverage: effectiveProfile.materialCoverage,
          semanticAssessmentCoverage: effectiveProfile.semanticAssessmentCoverage,
          contribution: effectiveProfile.substantiveContribution,
        }}
      />
      <h4 className="font-medium">{t("semantic.profile_title")}</h4>
      <p className="text-xs text-text-secondary">
        {t(`semantic.coverage.${effectiveProfile.coverage}`)} ·{" "}
        {t("semantic.content_version", { version: contentVersion })}
      </p>
      <p className="text-xs text-text-secondary">{t("semantic.objective_note")}</p>
      {!!effectiveProfile.entities?.length && (
        <div className="space-y-2">
          <h5 className="text-sm font-medium">{t("semantic.entities.title")}</h5>
          {/* 实体与正文证据一同展示，旧画像缺少实体时不补猜测。 */}
          {effectiveProfile.entities.map((entity) => (
            <details key={semanticEntityId(entity)} className="rounded bg-fill-quinary p-2">
              <summary className="cursor-pointer whitespace-normal break-words">
                {entity.name} · {t(`semantic.entity.kind.${entity.kind}`)}
              </summary>
              {entity.parentName && (
                <p className="mt-1 whitespace-pre-wrap text-xs">
                  {t("semantic.entity.parent", { name: entity.parentName })}
                </p>
              )}
              {!!entity.aliases.length && (
                <p className="mt-1 whitespace-pre-wrap text-xs">
                  {t("semantic.entity.aliases", { names: entity.aliases.join(" / ") })}
                </p>
              )}
              <p className="mt-1 text-xs text-text-secondary">
                {t("semantic.entity.confidence", { value: Math.round(entity.confidence * 100) })}
              </p>
              {entity.evidenceIds.map((id) => (
                <p key={id} className="mt-1 whitespace-pre-wrap text-xs text-text-secondary">
                  {id}: {effectiveProfile.evidence[id] ?? t("semantic.evidence_unavailable")}
                </p>
              ))}
            </details>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {semanticTagDefinitions.map((tag) => {
          const assessment = (loaded?.assessments ?? profile.assessments).find(
            (item) => item.tagId === tag.id,
          )
          return (
            <details key={tag.id} className="rounded bg-fill-quinary p-2">
              <summary className="cursor-pointer">
                {t(`semantic.tag.${tag.id}`, { nsSeparator: false })} ·{" "}
                {t(`semantic.state.${assessment?.state ?? "unknown"}`)}
                {assessment?.confidence != null && ` (${Math.round(assessment.confidence * 100)}%)`}
              </summary>
              <p className="mt-1 text-xs text-text-secondary">
                {t(`semantic.definition.${tag.id}`, { nsSeparator: false })}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs">
                {assessment?.reason ?? t("semantic.not_assessed")}
              </p>
              {assessment?.evidenceIds.map((id) => (
                <p key={id} className="mt-1 whitespace-pre-wrap text-xs text-text-secondary">
                  {id}: {effectiveProfile.evidence[id] ?? t("semantic.evidence_unavailable")}
                </p>
              ))}
            </details>
          )
        })}
      </div>
      <button
        type="button"
        className="rounded-lg border border-fill-secondary px-3 py-1.5 text-sm hover:bg-fill-secondary"
        onClick={() => {
          setEditing(true)
          void load()
        }}
        disabled={busy}
      >
        {t("semantic.correct_open")}
      </button>
      {editing && (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">{t("semantic.correct_note")}</p>
          <label className="block space-y-1">
            {t("processing.semantic_tags")}
            <select
              className="w-full rounded border border-fill-secondary bg-material-opaque p-2"
              value={tagId}
              onChange={(event) => setTagId(event.target.value as typeof tagId)}
            >
              {semanticTagDefinitions.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {t(`semantic.tag.${tag.id}`, { nsSeparator: false })}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            {t("semantic.correction_state")}
            <select
              className="w-full rounded border border-fill-secondary bg-material-opaque p-2"
              value={correction}
              onChange={(event) => setCorrection(event.target.value as SemanticOverrideState)}
            >
              {(["present", "absent", "automatic"] as const).map((state) => (
                <option key={state} value={state}>
                  {t(`semantic.correction.${state}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="rounded-lg border border-fill-secondary px-3 py-1.5 disabled:opacity-40"
            disabled={!loaded || busy}
            onClick={() => void save()}
          >
            {t("semantic.correct_save")}
          </button>
          {error && (
            <p role="alert" className="text-red">
              {t("semantic.correct_error")}
            </p>
          )}
          {saved && (
            <p role="status" className="text-text-secondary">
              {t("semantic.correct_saved")}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
