import type { AttentionSettings } from "@follow/information-core"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { processingButtonClass, processingInputClass } from "./processing-condition-editor"

// 关注清单留在原有全局规则编辑器，沿用保存/发布流程及草稿校验。
export function ProcessingAttentionSettings({
  value,
  onChange,
}: {
  value?: AttentionSettings
  onChange: (value: AttentionSettings) => void
}) {
  const { t } = useTranslation("app")
  const settings = value ?? { enabled: true, watchlist: [], nearDeadlineHours: 48 }
  const update = (index: number, patch: Partial<AttentionSettings["watchlist"][number]>) =>
    onChange({
      ...settings,
      watchlist: settings.watchlist.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    })
  return (
    <section className="space-y-3 rounded-lg bg-fill-quaternary p-3">
      <h3 className="font-medium">{t("processing.attention.title")}</h3>
      <p className="text-sm text-text-secondary">{t("processing.attention.settings_hint")}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
        />
        {t("processing.attention.enabled")}
      </label>
      <label className="block text-sm">
        {t("processing.attention.near_hours")}
        <input
          className={processingInputClass}
          type="number"
          min={1}
          max={168}
          value={settings.nearDeadlineHours ?? 48}
          onChange={(event) =>
            onChange({ ...settings, nearDeadlineHours: event.target.valueAsNumber })
          }
        />
      </label>
      {settings.watchlist.length === 0 && (
        <p className="text-sm text-text-secondary">{t("processing.attention.watch_empty")}</p>
      )}
      {settings.watchlist.map((watch, index) => (
        <div key={watch.id} className="space-y-2 rounded bg-fill-quinary p-2">
          <label className="block text-sm">
            {t("processing.attention.watch_name")}
            <input
              className={processingInputClass}
              value={watch.name}
              maxLength={100}
              onChange={(event) => update(index, { name: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t("processing.attention.watch_aliases")}
            <WatchAliases
              aliases={watch.aliases}
              onChange={(aliases) => update(index, { aliases })}
            />
          </label>
          <button
            type="button"
            className={processingButtonClass}
            onClick={() =>
              onChange({
                ...settings,
                watchlist: settings.watchlist.filter((_, position) => position !== index),
              })
            }
          >
            {t("processing.attention.watch_remove")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className={processingButtonClass}
        disabled={settings.watchlist.length >= 100}
        onClick={() =>
          onChange({
            ...settings,
            watchlist: [...settings.watchlist, { id: crypto.randomUUID(), name: "", aliases: [] }],
          })
        }
      >
        {t("processing.attention.watch_add")}
      </button>
    </section>
  )
}

// 保留用户正在输入的分隔符，不能每个按键都归一化后把末尾逗号吃掉。
function WatchAliases({
  aliases,
  onChange,
}: {
  aliases: string[]
  onChange: (aliases: string[]) => void
}) {
  const [text, setText] = useState(aliases.join(", "))
  const parse = (value: string) =>
    value
      .split(/[,，]/u)
      .map((item) => item.trim())
      .filter(Boolean)
  useEffect(() => {
    if (JSON.stringify(parse(text)) !== JSON.stringify(aliases)) setText(aliases.join(", "))
  }, [aliases, text])
  return (
    <input
      className={processingInputClass}
      value={text}
      maxLength={2000}
      onChange={(event) => {
        setText(event.target.value)
        onChange(parse(event.target.value))
      }}
    />
  )
}
