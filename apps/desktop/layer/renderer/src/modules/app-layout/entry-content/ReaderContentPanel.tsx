import { Tabs, TabsContent, TabsList, TabsTrigger } from "@follow/components/ui/tabs/index.js"
import { useWhoami } from "@follow/store/user/hooks"
import { cn } from "@follow/utils/utils"
import type { ReactNode } from "react"
import { Activity, useState } from "react"
import { useTranslation } from "react-i18next"

import { useAutomationDebugEnabled } from "~/modules/action/use-automation-debug"
import { AutomationDebugPanel } from "~/providers/automation-debug-panel"

/** 复用正文侧栏承载调试；关闭开关时保持原有文章布局。 */
export function ReaderContentPanel({
  children,
  enabled = true,
}: {
  children: ReactNode
  enabled?: boolean
}) {
  const debugEnabled = useAutomationDebugEnabled()
  const ownerId = useWhoami()?.id
  if (!enabled || !debugEnabled) return children
  return (
    <ReaderContentTabs key={ownerId ?? "anonymous"} ownerId={ownerId}>
      {children}
    </ReaderContentTabs>
  )
}

function ReaderContentTabs({ children, ownerId }: { children: ReactNode; ownerId?: string }) {
  const { t } = useTranslation("app")
  const [tab, setTab] = useState("article")
  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-theme-background text-text"
    >
      <TabsList
        aria-label={t("automation.debug.reader_tabs")}
        className="no-drag-region h-11 shrink-0 justify-start border-b border-fill-secondary px-3 print:hidden"
      >
        <TabsTrigger
          value="article"
          className={cn(
            "gap-2 rounded-md px-4 py-2",
            tab === "article" && "bg-fill-secondary font-semibold",
          )}
        >
          <i aria-hidden="true" className="i-mgc-document-cute-re size-4" />
          {t("automation.debug.article_tab")}
        </TabsTrigger>
        <TabsTrigger
          value="debug"
          className={cn(
            "gap-2 rounded-md px-4 py-2",
            tab === "debug" && "bg-fill-secondary font-semibold",
          )}
        >
          <i aria-hidden="true" className="i-mgc-bug-cute-re size-4" />
          {t("automation.debug.debug_tab")}
        </TabsTrigger>
      </TabsList>
      {/* 保留正文 DOM 与滚动位置，隐藏期间暂停正文快捷键和调试轮询。 */}
      <Activity mode={tab === "article" ? "visible" : "hidden"}>
        <TabsContent
          forceMount
          value="article"
          className="relative mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden print:block"
        >
          {children}
        </TabsContent>
      </Activity>
      <Activity mode={tab === "debug" ? "visible" : "hidden"}>
        <TabsContent
          forceMount
          value="debug"
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden print:hidden"
        >
          <AutomationDebugPanel ownerId={ownerId} />
        </TabsContent>
      </Activity>
    </Tabs>
  )
}
