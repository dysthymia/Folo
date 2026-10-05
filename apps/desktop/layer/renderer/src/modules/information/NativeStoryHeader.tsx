import { useGlobalFocusableScopeSelector } from "@follow/components/common/Focusable/hooks.js"
import { ActionButton } from "@follow/components/ui/button/index.js"
import { checkIsEditableElement } from "@follow/utils/dom"
import { EventBus } from "@follow/utils/event-bus"
import { useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"
import { tinykeys } from "tinykeys"

import { FocusablePresets } from "~/components/common/Focusable"
import { CommandActionButton } from "~/components/ui/button/CommandActionButton"
import { COMMAND_ID } from "~/modules/command/commands/id"
import { useCommandShortcuts } from "~/modules/command/hooks/use-command-binding"
import { EntryHeaderFrame } from "~/modules/entry-content/components/entry-header/internal/context"

import { useNativeReader } from "./native-reader-context"

// Jotai 选择器必须保持身份稳定，避免每次渲染生成新 atom 并阻塞路由过渡。
const isReaderScope: Parameters<typeof useGlobalFocusableScopeSelector>[0] = (scope) =>
  FocusablePresets.isEntryRender(scope) || FocusablePresets.isTimeline(scope)

/** 复用原生工具栏和命令偏好，命令对象明确指向私人 Story。 */
export function NativeStoryHeader() {
  const reader = useNativeReader()
  const { t } = useTranslation("app")
  const navigate = useNavigate()
  const location = useLocation()
  const shortcuts = useCommandShortcuts()
  const when = useGlobalFocusableScopeSelector(isReaderScope)
  const target = reader?.mutationTarget
  const mutate = useCallback(
    (state: { read?: boolean; collected?: boolean }) => {
      if (target?.kind === "story") void reader?.mutateItem(target, state)
    },
    [reader, target],
  )
  const close = useCallback(() => {
    const search = new URLSearchParams(location.search)
    search.delete("story")
    search.delete("item")
    void navigate({ pathname: location.pathname, search: search.size ? `?${search}` : "" })
  }, [location, navigate])
  // 原生复制快捷键与工具栏共享同一个 Story 深链，避免命令层使用残留的原文编号。
  const copyLink = useCallback(() => {
    void navigator.clipboard
      .writeText(window.location.href)
      .catch(() => toast.error(t("processing.reader.error.request")))
  }, [t])
  useEffect(() => {
    if (!when || target?.kind !== "story") return
    const bindings: Record<string, (event: KeyboardEvent) => void> = {}
    for (const [shortcut, action] of [
      [shortcuts[COMMAND_ID.entry.star], () => mutate({ collected: !reader?.selectedCollected })],
      [shortcuts[COMMAND_ID.entry.read], () => mutate({ read: !reader?.selectedRead })],
      [shortcuts[COMMAND_ID.entry.copyLink], copyLink],
      ["Escape", close],
    ] as const) {
      for (const key of shortcut?.split(",") ?? [])
        bindings[key.trim()] = (event) => {
          if (checkIsEditableElement(event.target as HTMLElement)) return
          event.preventDefault()
          event.stopPropagation()
          action()
        }
    }
    return tinykeys(document.documentElement, bindings)
  }, [
    when,
    target,
    reader?.selectedRead,
    reader?.selectedCollected,
    shortcuts,
    close,
    copyLink,
    mutate,
  ])
  return (
    <EntryHeaderFrame>
      <nav
        className="group/header relative z-10 flex h-top-header w-full items-center justify-between gap-3 bg-background px-4 @container"
        data-hide-in-print
      >
        <div className="flex min-w-0 items-center gap-1">
          <ActionButton tooltip={t("processing.reader.close")} onClick={close}>
            <i className="i-mgc-close-cute-re" />
          </ActionButton>
          <i className="i-mgc-news-cute-re hidden shrink-0 text-accent @md:inline-block" />
          <span className="hidden truncate text-sm text-text-secondary @md:inline">
            {reader?.selected?.title ?? t("processing.generated.title")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ActionButton
            tooltip={t("processing.reader.previous")}
            onClick={() => EventBus.dispatch(COMMAND_ID.timeline.switchToPrevious)}
          >
            <i className="i-mgc-left-small-sharp" />
          </ActionButton>
          <ActionButton
            tooltip={t("processing.reader.next")}
            onClick={() => EventBus.dispatch(COMMAND_ID.timeline.switchToNext)}
          >
            <i className="i-mgc-right-small-sharp" />
          </ActionButton>
          <CommandActionButton
            commandId={COMMAND_ID.entry.read}
            active={!!reader?.selectedRead}
            disabled={reader?.changing || !target}
            disableTriggerShortcut
            onClick={() => mutate({ read: !reader?.selectedRead })}
          />
          <CommandActionButton
            commandId={COMMAND_ID.entry.star}
            active={!!reader?.selectedCollected}
            aria-pressed={!!reader?.selectedCollected}
            disabled={reader?.changing || !target}
            disableTriggerShortcut
            onClick={() => mutate({ collected: !reader?.selectedCollected })}
          />
          <CommandActionButton
            commandId={COMMAND_ID.entry.copyLink}
            disableTriggerShortcut
            onClick={copyLink}
          />
        </div>
      </nav>
    </EntryHeaderFrame>
  )
}
