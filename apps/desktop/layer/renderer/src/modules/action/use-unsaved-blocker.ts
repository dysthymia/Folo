import { useEffect, useRef } from "react"
import { useBlocker } from "react-router"

import { useDialog } from "~/components/ui/modal/stacked/hooks"
import { getI18n } from "~/i18n"

// 规则编辑统一保护未保存草稿，刷新和离开路由前提示。
export const useUnSavedBlocker = (isDirty: boolean) => {
  const navigationBlocker = useBlocker(({ currentLocation, nextLocation }) => {
    return isDirty && currentLocation.pathname !== nextLocation.pathname
  })

  const isRouterPromptOpenRef = useRef(false)
  const { ask } = useDialog()
  useEffect(() => {
    if (navigationBlocker.state !== "blocked") {
      isRouterPromptOpenRef.current = false
      return
    }
    if (isRouterPromptOpenRef.current) {
      return
    }
    isRouterPromptOpenRef.current = true
    const { t } = getI18n()
    ask({
      title: t("common:words.unsaved_changes"),
      message: t("settings:actions.navigate.prompt"),
      variant: "ask",
      onConfirm: () => navigationBlocker.proceed(),
    })
  }, [ask, navigationBlocker])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const hasUnsavedChanges = isDirty
      if (!hasUnsavedChanges) {
        return
      }
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [isDirty])
}
