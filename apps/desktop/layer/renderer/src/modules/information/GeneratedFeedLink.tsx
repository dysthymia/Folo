import { EllipsisHorizontalTextWithTooltip } from "@follow/components/ui/typography/index.js"
import type { AutomationRule } from "@follow/information-core"
import { useWhoami } from "@follow/store/user/hooks"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router"

import { MenuItemSeparator, MenuItemText, useShowContextMenu } from "~/atoms/context-menu"
import { useContextMenu } from "~/hooks/common/useContextMenu"
import { localAutomationChanged } from "~/modules/action/local-automation-events"
import { createProcessingClient } from "~/modules/action/processing-client"
import { getOneTimeToken, isLocalFoloHost } from "~/modules/ai-chat/local-provider"
import { SourceRow } from "~/modules/subscription-column/SourceRow"
import { UnreadNumber } from "~/modules/subscription-column/UnreadNumber"

import { loadGeneratedFeedStats } from "./generated-feed-client"
import type { GeneratedSourcePreferences } from "./generated-source-preferences"
import {
  generatedSourcePreferencesChanged,
  loadGeneratedSourcePreferences,
  saveGeneratedSourcePreferences,
} from "./generated-source-preferences"

const client = createProcessingClient(getOneTimeToken)
type Stats = Awaited<ReturnType<typeof loadGeneratedFeedStats>>

export function GeneratedFeedLink() {
  const ownerId = useWhoami()?.id
  return isLocalFoloHost() && ownerId ? <PrivateSourceRow key={ownerId} ownerId={ownerId} /> : null
}

/** 复用原生来源行呈现；私人身份和操作始终留在处理服务及本地偏好。 */
function PrivateSourceRow({ ownerId }: { ownerId: string }) {
  const { t } = useTranslation("app")
  const navigate = useNavigate()
  const location = useLocation()
  const showContextMenu = useShowContextMenu()
  const [preferences, setPreferences] = useState(() => loadGeneratedSourcePreferences(ownerId))
  const [preferenceError, setPreferenceError] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsError, setStatsError] = useState(false)
  const [aggregateRules, setAggregateRules] = useState<AutomationRule[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const statsRequestRef = useRef<AbortController | null>(null)
  const configRequestRef = useRef<AbortController | null>(null)
  const isActive = location.pathname === "/events" || location.pathname.startsWith("/events/")
  useEffect(() => {
    // 进入已选来源时展开其本地分组；之后用户仍可手工折叠。
    if (isActive)
      setPreferences((previous) =>
        previous.collapsed ? { ...previous, collapsed: false } : previous,
      )
  }, [isActive])
  const updatePreferences = (next: GeneratedSourcePreferences) => {
    setPreferences(next)
    setPreferenceError(!saveGeneratedSourcePreferences(ownerId, next))
  }
  useEffect(() => {
    const restore = () => setPreferences(loadGeneratedSourcePreferences(ownerId))
    window.addEventListener(generatedSourcePreferencesChanged, restore)
    window.addEventListener("storage", restore)
    return () => {
      window.removeEventListener(generatedSourcePreferencesChanged, restore)
      window.removeEventListener("storage", restore)
    }
  }, [ownerId])
  useEffect(() => {
    let disposed = false
    const refreshStats = () => {
      if (document.visibilityState === "hidden") return
      statsRequestRef.current?.abort()
      const controller = new AbortController()
      statsRequestRef.current = controller
      void loadGeneratedFeedStats(controller.signal)
        .then((value) => {
          if (disposed || controller.signal.aborted) return
          setStats(value)
          setStatsError(false)
        })
        .catch(() => {
          if (disposed || controller.signal.aborted) return
          setStats(null)
          setStatsError(true)
        })
    }
    const refreshConfig = () => {
      if (document.visibilityState === "hidden") return
      configRequestRef.current?.abort()
      const controller = new AbortController()
      configRequestRef.current = controller
      void client
        .loadEffective(controller.signal)
        .then((value) => {
          if (disposed || controller.signal.aborted) return
          // 生成来源没有原文 source_id；只能定位已经发布的综述规则。
          setAggregateRules(
            (value.config?.rules ?? []).filter(
              (rule) =>
                rule.enabled && rule.actions.some((action) => action.type === "ai_aggregate"),
            ),
          )
          setGroups(
            [
              ...new Set(
                value.sources
                  .map((source) => source.category)
                  .filter((name): name is string => !!name),
              ),
            ].sort(),
          )
        })
        .catch(() => {
          if (disposed || controller.signal.aborted) return
          setAggregateRules([])
          setGroups([])
        })
    }
    const published = () => {
      refreshStats()
      refreshConfig()
    }
    const visible = () => {
      if (document.visibilityState === "hidden") {
        statsRequestRef.current?.abort()
        configRequestRef.current?.abort()
      } else published()
    }
    published()
    const timer = window.setInterval(refreshStats, 60_000)
    window.addEventListener(localAutomationChanged, published)
    window.addEventListener("processing-reading-invalidated", refreshStats)
    window.addEventListener("processing-story-state-changed", refreshStats)
    document.addEventListener("visibilitychange", visible)
    return () => {
      disposed = true
      statsRequestRef.current?.abort()
      configRequestRef.current?.abort()
      window.clearInterval(timer)
      window.removeEventListener(localAutomationChanged, published)
      window.removeEventListener("processing-reading-invalidated", refreshStats)
      window.removeEventListener("processing-story-state-changed", refreshStats)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [ownerId])
  const openRule = (ruleId?: string) => {
    const search = new URLSearchParams({ scope: "processing_service" })
    if (ruleId) search.set("ruleId", ruleId)
    const readingPath = `${location.pathname}${location.search}${location.hash}`
    search.set(
      "returnTo",
      /^\/(?:timeline|events)(?:\/|\?|$)/u.test(readingPath) ? readingPath : "/events",
    )
    navigate(`/action?${search}`)
  }
  const contextMenuProps = useContextMenu({
    onContextMenu: async (event) => {
      event.stopPropagation()
      event.preventDefault()
      const groupNames = [...new Set([...groups, preferences.group].filter(Boolean))]
      const items = [
        new MenuItemText({
          label: t("processing.generated.title"),
          click: () => navigate("/events"),
        }),
        new MenuItemText({
          label: t("processing.generated.rules"),
          ...(aggregateRules.length
            ? {
                submenu: aggregateRules.map(
                  (rule) =>
                    new MenuItemText({
                      label: rule.name,
                      click: () => openRule(rule.id),
                      requiresLogin: true,
                    }),
                ),
              }
            : { click: () => openRule(), requiresLogin: true }),
        }),
        new MenuItemText({
          label: t("processing.generated.group"),
          submenu: [
            new MenuItemText({
              label: t("processing.generated.ungrouped"),
              checked: !preferences.group,
              click: () => updatePreferences({ ...preferences, group: "", collapsed: false }),
            }),
            ...groupNames.map(
              (name) =>
                new MenuItemText({
                  label: name,
                  checked: preferences.group === name,
                  click: () => updatePreferences({ ...preferences, group: name, collapsed: false }),
                }),
            ),
          ],
        }),
        MenuItemSeparator.default,
        new MenuItemText({
          label: t(preferences.visible ? "processing.generated.hide" : "processing.generated.show"),
          click: () => updatePreferences({ ...preferences, visible: !preferences.visible }),
        }),
      ]
      setMenuOpen(true)
      try {
        await showContextMenu(items, event)
      } finally {
        setMenuOpen(false)
      }
    },
  })
  if (!preferences.visible)
    return (
      <div className="mx-3 mb-1" {...contextMenuProps}>
        <button
          type="button"
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text"
          onClick={(event) => {
            event.stopPropagation()
            updatePreferences({ ...preferences, visible: true })
          }}
        >
          <i className="i-mgc-eye-cute-re" aria-hidden />
          {t("processing.generated.show")}
        </button>
        {preferenceError && (
          <p role="alert" className="text-xs text-orange">
            {t("processing.generated.preference_error")}
          </p>
        )}
      </div>
    )
  return (
    <div className="mx-3 mb-1" data-generated-source-group={preferences.group || undefined}>
      {preferences.group && (
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-text-secondary hover:bg-theme-item-hover"
          aria-expanded={!preferences.collapsed}
          onClick={(event) => {
            event.stopPropagation()
            updatePreferences({ ...preferences, collapsed: !preferences.collapsed })
          }}
        >
          <i
            className={preferences.collapsed ? "i-mgc-right-cute-re" : "i-mgc-down-cute-re"}
            aria-hidden
          />
          <span className="truncate">{preferences.group}</span>
          <span className="ml-auto shrink-0 text-[0.65rem]">
            {t("processing.generated.local_group")}
          </span>
        </button>
      )}
      {(!preferences.group || !preferences.collapsed) && (
        <SourceRow
          role="button"
          tabIndex={0}
          data-source-origin="generated"
          data-generated-feed-id="generated:events"
          data-active={isActive || menuOpen}
          aria-current={isActive ? "page" : undefined}
          aria-label={t("processing.generated.title")}
          className={preferences.group ? "pl-3" : "pl-1.5"}
          title={t("processing.generated.private_hint")}
          trailing={
            statsError ? (
              <i
                className="i-mgc-warning-cute-re ml-2 text-orange"
                title={t("processing.generated.stats_error")}
              />
            ) : (
              <UnreadNumber unread={stats?.unread} className="ml-2" />
            )
          }
          onClick={(event) => {
            event.stopPropagation()
            navigate("/events")
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              event.stopPropagation()
              navigate("/events")
            }
          }}
          {...contextMenuProps}
        >
          <i className="i-mgc-news-cute-re mr-1.5 size-4 shrink-0" aria-hidden />
          <EllipsisHorizontalTextWithTooltip className="truncate">
            {t("processing.generated.title")}
          </EllipsisHorizontalTextWithTooltip>
          <span className="ml-1 shrink-0 rounded bg-fill-secondary px-1 text-[0.6rem] text-text-secondary">
            {t("processing.generated.private")}
          </span>
        </SourceRow>
      )}
      {preferenceError && (
        <p role="alert" className="text-xs text-orange">
          {t("processing.generated.preference_error")}
        </p>
      )}
    </div>
  )
}
