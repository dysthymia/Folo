import type { EntryProcessingSignals } from "@follow/information-core"
import { useTranslation } from "react-i18next"

// 列表只显示短标记，完整解释保留在现有结果面板；无重点不代表没有阅读价值。
export function ProcessingSignals({
  signals,
  compact = false,
}: {
  signals: EntryProcessingSignals
  compact?: boolean
}) {
  const { t } = useTranslation("app")
  const attention = signals.attention
  const pending = signals.pendingPolicyFields?.length ? signals.pendingPolicyFields : []
  const contribution = signals.contribution
  const contributionState =
    contribution &&
    ((contribution.confidence ?? 0) < 0.9 ||
      (contribution.state === "present" && !contribution.evidenceIds.length))
      ? "unknown"
      : (contribution?.state ?? "unknown")
  const labelClass =
    "rounded bg-fill-secondary px-1.5 py-0.5 text-[10px] leading-3 text-text-secondary"
  const meaningful = attention?.level !== "none" && attention?.level !== undefined
  if (
    compact &&
    !meaningful &&
    !pending.length &&
    signals.materialCoverage !== "partial" &&
    signals.semanticAssessmentCoverage !== "partial" &&
    !contribution &&
    !attention?.deadlines.length
  )
    return null
  return (
    <span
      className={compact ? "inline-flex min-w-0 flex-wrap gap-1" : "block space-y-2 text-sm"}
      data-processing-signals
    >
      {meaningful && (
        <span
          className={
            attention.level === "urgent"
              ? "rounded bg-red/10 px-1.5 py-0.5 text-xs text-red"
              : "rounded bg-orange/10 px-1.5 py-0.5 text-xs text-orange"
          }
          title={attention.reasons.join("；")}
          data-attention-level={attention.level}
        >
          {t(
            attention.level === "urgent"
              ? "processing.attention.urgent"
              : "processing.attention.important",
          )}
        </span>
      )}
      {pending.length > 0 && (
        <span
          className={labelClass}
          title={pending.map((field) => t(`processing.signals.policy_${field}`)).join("、")}
        >
          {t("processing.signals.pending_policy")}
        </span>
      )}
      {signals.materialCoverage === "partial" && (
        <span className={labelClass}>{t("processing.signals.material_partial")}</span>
      )}
      {signals.semanticAssessmentCoverage === "partial" && (
        <span className={labelClass}>{t("processing.signals.assessment_partial")}</span>
      )}
      {contribution && (
        <span className={labelClass} title={contribution.reason}>
          {t(`processing.signals.contribution_${contributionState}`)}
        </span>
      )}
      {compact &&
        attention?.deadlines.slice(0, 1).map((deadline) => (
          <span
            key={deadline.evidenceId}
            className={labelClass}
            title={`${deadline.text}；${deadline.reason}`}
          >
            {deadline.at
              ? t("processing.attention.deadline_short", { at: deadline.at })
              : t("processing.attention.deadline_unknown")}
          </span>
        ))}
      {!compact && (
        <>
          {pending.length > 0 && (
            <span className="block text-text-secondary">
              {t("processing.signals.pending_details", {
                fields: pending.map((field) => t(`processing.signals.policy_${field}`)).join("、"),
              })}
            </span>
          )}
          {signals.materialCoverage === undefined &&
            signals.semanticAssessmentCoverage === undefined && (
              <span className="block text-xs text-text-secondary">
                {t("processing.signals.legacy_coverage")}
              </span>
            )}
          {meaningful && (
            <span className="block text-text-secondary">{attention.reasons.join("；")}</span>
          )}
          {contribution && <span className="block text-text-secondary">{contribution.reason}</span>}
          {attention?.deadlines.map((deadline, index) => (
            <span key={index} className="block rounded bg-fill-quaternary p-2 text-xs">
              <span className="block font-medium">
                {t(
                  deadline.status === "known"
                    ? "processing.attention.deadline_known"
                    : "processing.attention.deadline_unknown",
                )}
              </span>
              {deadline.at && (
                <time dateTime={deadline.at} className="block">
                  {deadline.at}
                </time>
              )}
              <q className="block whitespace-pre-wrap">{deadline.text}</q>
              <span className="block text-text-secondary">{deadline.reason}</span>
            </span>
          ))}
        </>
      )}
    </span>
  )
}
