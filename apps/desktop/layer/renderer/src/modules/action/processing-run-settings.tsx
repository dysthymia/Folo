import type { RuleSet } from "@follow/information-core"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import type {
  ProcessingEditor,
  ProcessingInput,
  ProcessingRelease,
  ProcessingReleaseScope,
  ProcessingRun,
  ProcessingScheduleConfig,
} from "./processing-client"
import { processingButtonClass, processingInputClass } from "./processing-condition-editor"
import { ProcessingReleasePanel } from "./processing-release-panel"

// 默认时点与服务端计划保持一致；用户仍可在草稿中调整并显式保存。
const defaultTimes = ["08:00", "12:00", "15:00", "20:00", "23:00"]
const pollOptions = [null, 5, 15, 30, 60] as const

export type ProcessingRunSettingsProps = {
  sources: ProcessingEditor["sources"]
  inputs: ProcessingInput[]
  runs: ProcessingRun[]
  value: ProcessingScheduleConfig | null
  scope: ProcessingReleaseScope
  recentSince: string
  selectedInputIds: number[]
  release: ProcessingRelease | null
  ruleConfig: RuleSet
  releases: ProcessingEditor["releases"]
  draftDirty: boolean
  saving: boolean
  releasing: boolean
  running: boolean
  canRun: boolean
  scheduleValid: boolean
  onChange: (value: ProcessingScheduleConfig) => void
  onScopeChange: (value: ProcessingReleaseScope) => void
  onRecentSinceChange: (value: string) => void
  onSelectedInputIdsChange: (value: number[]) => void
  onSave: () => void
  onRelease: () => void
  onRun: () => void
  onRestoreRelease?: (config: RuleSet) => void
}

export const defaultProcessingSchedule = (): ProcessingScheduleConfig => ({
  sourceKeys: [],
  historySince: new Date().toISOString(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  enabled: false,
  times: [...defaultTimes],
  pollIntervalMinutes: null,
  readyBy: null,
})

const dateValue = (iso: string, timeZone: string) => {
  const fallback = /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : ""
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return fallback
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        calendar: "gregory",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(new Date(timestamp))
        .map(({ type, value }) => [type, value]),
    )
    if (
      typeof parts.year === "string" &&
      typeof parts.month === "string" &&
      typeof parts.day === "string"
    )
      return `${parts.year}-${parts.month}-${parts.day}`
  } catch {
    // 时区无效时保留可恢复的日期文本，时区校验仍会阻止保存。
  }
  return fallback
}
const isoFromDate = (date: string, timeZone: string) => {
  const parts = date.split("-")
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (![year, month, day].every(Number.isFinite)) return `${date}T00:00:00.000Z`
  const wallTime = Date.UTC(year, month - 1, day)
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
  } catch {
    // 时区输入无效时由校验阻止保存，但日期编辑仍应保留可恢复的 UTC 值。
    return `${date}T00:00:00.000Z`
  }
  // 先用 UTC 猜测值计算目标时区偏移，再反推该时区的本地午夜。
  let candidate = wallTime
  for (let index = 0; index < 2; index += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map(({ type, value }) => [type, value]),
    )
    const localTime = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    candidate = wallTime - (localTime - candidate)
  }
  return new Date(candidate).toISOString()
}
const isValidTimeZone = (timeZone: string) => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone }).format()
    return true
  } catch {
    return false
  }
}

const inputLabel = (input: ProcessingInput, sources: ProcessingEditor["sources"]) => {
  const source = sources.find((item) => item.key === input.sourceKey)
  return `${source?.title ?? input.sourceKey} · ${input.itemId} · ${input.status}`
}

export function ProcessingRunSettings({
  sources,
  inputs,
  runs,
  value,
  scope,
  recentSince,
  selectedInputIds,
  release,
  ruleConfig,
  releases,
  draftDirty,
  saving,
  releasing,
  running,
  canRun,
  scheduleValid,
  onChange,
  onScopeChange,
  onRecentSinceChange,
  onSelectedInputIdsChange,
  onSave,
  onRelease,
  onRun,
  onRestoreRelease,
}: ProcessingRunSettingsProps) {
  const { t } = useTranslation("app")
  const config = value ?? defaultProcessingSchedule()
  const selectedSources = new Set(config.sourceKeys)
  const activeTimes = useMemo(() => new Set(config.times), [config.times])
  const timeSlots = useMemo(
    () => [...new Set([...config.times, ...defaultTimes])].slice(0, 5),
    [config.times],
  )
  // 服务端按创建时间升序返回；展示前倒序截取，确保运行中的最新批次也可见。
  const recentRuns = useMemo(
    () =>
      [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 5),
    [runs],
  )
  const allSourcesSelected =
    sources.length > 0 && sources.every((source) => selectedSources.has(source.key))
  // 没有来源时保存没有可执行范围，避免把空范围写成有效计划。
  const canSave = config.sourceKeys.length > 0 && scheduleValid && !saving
  const change = (next: Partial<ProcessingScheduleConfig>) => onChange({ ...config, ...next })

  return (
    <section
      className="space-y-4 rounded-xl border border-fill-secondary p-4"
      aria-label={t("processing.run.settings")}
    >
      <div>
        <h3 className="font-medium">{t("processing.run.settings")}</h3>
        <p className="mt-1 text-sm text-text-secondary">{t("processing.run.settings_hint")}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => change({ enabled: event.target.checked })}
        />
        {t("processing.run.enabled")}
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("processing.run.sources")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allSourcesSelected}
            disabled={sources.length === 0}
            onChange={(event) =>
              change({
                sourceKeys: event.target.checked ? sources.map((source) => source.key) : [],
              })
            }
          />
          {t("processing.run.select_all_sources", { count: sources.length })}
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          {sources.map((source) => (
            <label key={source.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedSources.has(source.key)}
                onChange={(event) => {
                  const next = new Set(selectedSources)
                  if (event.target.checked) next.add(source.key)
                  else next.delete(source.key)
                  change({ sourceKeys: [...next] })
                }}
              />
              {source.title}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t("processing.run.history_since")}</span>
          <input
            className={processingInputClass}
            type="date"
            value={dateValue(config.historySince, config.timeZone)}
            onChange={(event) =>
              change({ historySince: isoFromDate(event.target.value, config.timeZone) })
            }
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t("processing.run.timezone")}</span>
          <input
            className={processingInputClass}
            value={config.timeZone}
            placeholder="Asia/Shanghai"
            onChange={(event) => change({ timeZone: event.target.value })}
          />
          {!isValidTimeZone(config.timeZone) && (
            <span className="block text-sm text-red">{t("processing.run.timezone_invalid")}</span>
          )}
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("processing.run.times")}</legend>
        {timeSlots.map((time) => {
          const checked = activeTimes.has(time)
          return (
            <label key={time} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const next = new Set(activeTimes)
                  if (event.target.checked) next.add(time)
                  else next.delete(time)
                  change({ times: [...next].sort() })
                }}
              />
              <input
                className={`${processingInputClass} max-w-32`}
                type="time"
                value={time}
                aria-label={t("processing.run.time_value", { time })}
                onChange={(event) => {
                  const next = config.times.filter((item) => item !== time)
                  if (checked && event.target.value) next.push(event.target.value)
                  change({ times: [...new Set(next)].sort() })
                }}
              />
            </label>
          )
        })}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t("processing.run.poll")}</span>
          <select
            className={processingInputClass}
            value={config.pollIntervalMinutes ?? ""}
            onChange={(event) =>
              change({
                pollIntervalMinutes: event.target.value ? Number(event.target.value) : null,
              })
            }
          >
            {pollOptions.map((minutes) => (
              <option key={minutes ?? "off"} value={minutes ?? ""}>
                {minutes === null
                  ? t("processing.run.poll_off")
                  : t("processing.run.poll_minutes", { minutes })}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>{t("processing.run.ready_by")}</span>
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.readyBy !== null}
              onChange={(event) =>
                change({ readyBy: event.target.checked ? { leadMinutes: 30 } : null })
              }
            />
            {t("processing.run.ready_by_enable")}
          </span>
          {config.readyBy && (
            <input
              className={processingInputClass}
              type="number"
              min={0}
              value={config.readyBy.leadMinutes}
              onChange={(event) => change({ readyBy: { leadMinutes: Number(event.target.value) } })}
            />
          )}
        </label>
      </div>
      <div className="space-y-3 border-t border-fill-secondary pt-4">
        <h4 className="text-sm font-medium">{t("processing.run.release")}</h4>
        <div className="flex flex-wrap gap-3 text-sm">
          {(["future", "recent", "selected"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="processing-release-scope"
                checked={scope.mode === mode}
                onChange={() =>
                  onScopeChange(
                    mode === "future"
                      ? { mode }
                      : mode === "recent"
                        ? { mode, since: isoFromDate(recentSince, config.timeZone) }
                        : { mode, inputIds: selectedInputIds },
                  )
                }
              />
              {t(`processing.run.release_scope.${mode}`)}
            </label>
          ))}
        </div>
        {scope.mode === "recent" && (
          <label className="block max-w-xs space-y-1 text-sm">
            <span>{t("processing.run.release_recent_since")}</span>
            <input
              className={processingInputClass}
              type="date"
              value={recentSince}
              onChange={(event) => {
                onRecentSinceChange(event.target.value)
                onScopeChange({
                  mode: "recent",
                  since: isoFromDate(event.target.value, config.timeZone),
                })
              }}
            />
          </label>
        )}
        {scope.mode === "selected" && (
          <div className="grid gap-2 sm:grid-cols-2">
            {inputs.map((input) => (
              <label key={input.seq} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedInputIds.includes(input.seq)}
                  onChange={(event) => {
                    const next = new Set(selectedInputIds)
                    if (event.target.checked) next.add(input.seq)
                    else next.delete(input.seq)
                    const ids = [...next].sort((a, b) => a - b)
                    onSelectedInputIdsChange(ids)
                    onScopeChange({ mode: "selected", inputIds: ids })
                  }}
                />
                {inputLabel(input, sources)}
              </label>
            ))}
          </div>
        )}
        {/* 未发布时只显示服务端影响预览，不把全部输入数量误称为已冻结目标。 */}
        {release && (
          <p className="text-sm text-text-secondary">
            {t("processing.run.release_target_count", { count: release.targetInputIds.length })}
          </p>
        )}
        <ProcessingReleasePanel
          config={ruleConfig}
          releases={releases}
          scope={scope}
          onRestore={onRestoreRelease}
        />
        {draftDirty && (
          <p className="text-sm text-orange">{t("processing.run.release_save_first")}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={processingButtonClass}
            disabled={!canSave}
            onClick={onSave}
          >
            {t("processing.run.save_schedule")}
          </button>
          <button
            type="button"
            className={`${processingButtonClass} bg-accent text-white`}
            disabled={
              draftDirty ||
              releasing ||
              inputs.length === 0 ||
              (scope.mode === "selected" && selectedInputIds.length === 0)
            }
            onClick={onRelease}
          >
            {releasing ? t("processing.run.releasing") : t("processing.run.release_action")}
          </button>
          <button
            type="button"
            className={processingButtonClass}
            disabled={!canRun || running}
            onClick={onRun}
          >
            {running ? t("processing.run.running") : t("processing.run.now")}
          </button>
        </div>
        {!canRun && (
          <p className="text-sm text-text-secondary">{t("processing.run.requires_release")}</p>
        )}
        {runs.length > 0 && (
          <div className="space-y-1 text-sm">
            <h5 className="font-medium">{t("processing.run.history")}</h5>
            {recentRuns.map((run) => (
              <p key={run.id} className="text-text-secondary">
                {run.status} · {run.createdAt}
                {run.error ? ` · ${run.error}` : ""}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
