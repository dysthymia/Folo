import { Button } from "@follow/components/ui/button/index.js"
import { useActionRules } from "@follow/store/action/hooks"
import { useLocalActionHydration, useLocalActionRules } from "@follow/store/action/local-hooks"
import { localActionActions } from "@follow/store/action/local-store"
import { actionActions } from "@follow/store/action/store"
import { useWhoami } from "@follow/store/user/hooks"
import { JsonObfuscatedCodec } from "@follow/utils/json-codec"
import { cn } from "@follow/utils/utils"
import { repository } from "@pkg"
import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { HeaderActionButton, HeaderActionGroup } from "~/components/ui/button/HeaderActionButton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu/dropdown-menu.js"
import { copyToClipboard, readFromClipboard } from "~/lib/clipboard"
import { toastFetchError } from "~/lib/error-parser"
import { downloadJsonFile, selectJsonFile } from "~/lib/export"
import {
  ActionScopeProvider,
  useScopedActionActions,
  useScopedActionDataDirty,
  useScopedActionRules,
  useScopedUpdateActionsMutation,
} from "~/modules/action/action-scope"
import { RuleCard } from "~/modules/action/rule-card"
import {
  buildActionSummary,
  buildConditionSummary,
  getRuleDisplayName,
} from "~/modules/action/rule-summary"
import type { UnifiedRuleRow, UnifiedRuleScope } from "~/modules/action/unified-action-list"
import {
  buildProcessingActionSummary,
  buildProcessingConditionSummary,
  UnifiedActionList,
} from "~/modules/action/unified-action-list"

import { isLocalFoloHost } from "../ai-chat/local-provider"
import { useSetSubViewRightView } from "../app-layout/subview/hooks"
import { ProcessingServiceDetail } from "./processing-service-detail"
import { useProcessingServiceRules } from "./use-processing-service-rules"
import { useUnSavedBlocker } from "./use-unsaved-blocker"
import { generateExportFilename } from "./utils"

const EmptyActionPlaceholder = ({ onCreateRule }: { onCreateRule: () => void }) => {
  const { t } = useTranslation(["settings", "common"])

  return (
    <div className="flex min-h-96 w-full items-center justify-center py-10">
      <div className="flex w-full max-w-xl flex-col items-center gap-6 rounded-3xl border border-fill-secondary bg-material-ultra-thin px-8 py-10 text-center shadow-sm">
        <div className="flex size-16 items-center justify-center rounded-2xl border border-fill-secondary bg-fill-quinary">
          <i className="i-mgc-magic-2-cute-re size-8 text-text-secondary" />
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-text">
            {t("actions.action_card.empty.title")}
          </h2>
          <p className="max-w-sm text-sm text-text-secondary">
            {t("actions.action_card.empty.description")}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={onCreateRule}>
            <i className="i-mgc-add-cute-re mr-2 size-4" />
            {t("actions.action_card.empty.cta")}
          </Button>
          <a
            href={`${repository.url}/wiki/Actions`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-fill-secondary hover:text-text"
          >
            <i className="i-mgc-book-6-cute-re size-4" />
            <span>{t("words.documentation", { ns: "common" })}</span>
          </a>
        </div>
      </div>
    </div>
  )
}

// 执行位置降为详情内的标识，不再作为主界面入口。?scope= 仅作初始定位，不强制先选执行位置。
const parseRequestedScope = (): UnifiedRuleScope | null => {
  const requested = new URLSearchParams(window.location.search).get("scope")

  if (requested === "cloud" || requested === "local") return requested
  // 处理服务只在本机部署可用，不接受跨域直接进入。
  if (requested === "processing_service" && isLocalFoloHost()) return "processing_service"

  return null
}

const parseRowId = (id: string): { scope: UnifiedRuleScope; key: string } | null => {
  const separator = id.indexOf(":")
  if (separator < 0) return null
  return { scope: id.slice(0, separator) as UnifiedRuleScope, key: id.slice(separator + 1) }
}

export const ActionSetting = () => {
  const { t: tSettings } = useTranslation("settings")
  const { t: tApp } = useTranslation("app")
  const user = useWhoami()

  useLocalActionHydration(user?.id)

  const initialScope = useMemo(() => parseRequestedScope(), [])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const cloudRules = useActionRules()
  const localRules = useLocalActionRules()
  const { rules: processingRules, available: processingAvailable } = useProcessingServiceRules()

  const cloudRows: UnifiedRuleRow[] = cloudRules.map((rule, index) => ({
    id: `cloud:${index}`,
    scope: "cloud",
    name: getRuleDisplayName(rule, index, tSettings),
    conditionSummary: buildConditionSummary(rule, tSettings),
    actionSummary: buildActionSummary(rule, tSettings),
    enabled: !rule.result.disabled,
  }))
  const localRows: UnifiedRuleRow[] = localRules.map((rule, index) => ({
    id: `local:${index}`,
    scope: "local",
    name: getRuleDisplayName(rule, index, tSettings),
    conditionSummary: buildConditionSummary(rule, tSettings),
    actionSummary: buildActionSummary(rule, tSettings),
    enabled: !rule.result.disabled,
  }))
  // 摘要函数只依赖 (key) => string，收窄一次避免把命名空间的字面量键类型带进去。
  const tSettingsKey = useCallback((key: string) => tSettings(key as never), [tSettings])
  const tAppKey = useCallback((key: string) => tApp(key as never), [tApp])

  const processingRows: UnifiedRuleRow[] = processingRules.map((rule) => ({
    id: `processing_service:${rule.id}`,
    scope: "processing_service",
    name: rule.name,
    conditionSummary: buildProcessingConditionSummary(rule.when, tSettingsKey),
    actionSummary: buildProcessingActionSummary(rule.actions, tAppKey),
    enabled: rule.enabled,
    enableBlocked: !processingAvailable,
  }))

  const unifiedRows = useMemo(
    () => [...cloudRows, ...localRows, ...processingRows],
    [cloudRows, localRows, processingRows],
  )
  const hasRules = unifiedRows.length > 0

  // 深链 ?scope= 仅作初始定位：选中该执行位置下的第一条规则，不强制先选执行位置。
  useEffect(() => {
    if (selectedId || !initialScope || unifiedRows.length === 0) return
    const first = unifiedRows.find((rule) => rule.scope === initialScope)
    if (first) setSelectedId(first.id)
  }, [initialScope, selectedId, unifiedRows])

  const selected = selectedId ? parseRowId(selectedId) : null

  const handleCreateRule = useCallback(() => {
    if (!selected || (selected.scope !== "cloud" && selected.scope !== "local")) return
    const actions = selected.scope === "local" ? localActionActions : actionActions
    const baseLength = selected.scope === "local" ? localRules.length : cloudRules.length
    actions.addRule((number) => tSettings("actions.actionName", { number }))
    setSelectedId(`${selected.scope}:${baseLength}`)
  }, [selected, cloudRules.length, localRules.length, tSettings])

  const handleCreateRuleTop = useCallback(() => {
    actionActions.addRule((number) => tSettings("actions.actionName", { number }))
    setSelectedId(`cloud:${cloudRules.length}`)
  }, [cloudRules.length, tSettings])

  let detail: React.ReactNode = null
  if (selected) {
    if (selected.scope === "processing_service") {
      detail = <ProcessingServiceDetail available={!!processingAvailable} onDirty={() => {}} />
    } else {
      const index = Number(selected.key)
      detail = (
        <ActionScopeProvider value={selected.scope}>
          <ActionButtonGroup onCreateRule={handleCreateRule} />
          <div className="min-h-0 flex-1">
            <RuleCard index={index} mode="detail" />
          </div>
        </ActionScopeProvider>
      )
    }
  }

  return (
    <>
      <ExecutionLocationNote />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ActionScopeProvider value={selected?.scope === "local" ? "local" : "cloud"}>
          <ShareImportSection />
        </ActionScopeProvider>
      </div>
      {hasRules ? (
        <div className="flex min-h-0 w-full flex-1">
          <UnifiedActionList rules={unifiedRows} selectedId={selectedId} onSelect={setSelectedId} />
          <div className="flex min-h-0 flex-1 border-l border-fill-secondary">
            {detail ?? (
              <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
                {tApp("automation.select_rule_hint")}
              </div>
            )}
          </div>
        </div>
      ) : (
        <EmptyActionPlaceholder onCreateRule={handleCreateRuleTop} />
      )}
    </>
  )
}

// 自动化页顶部常驻说明（非 tooltip）：讲清各执行位置的可用性。
const ExecutionLocationNote = () => {
  const { t } = useTranslation("app")
  const local = isLocalFoloHost()
  return (
    <p className="mb-4 max-w-2xl text-xs leading-5 text-text-secondary">
      {t("automation.execution_location_note")}
      {!local && <span> {t("automation.processing_only_local")}</span>}
    </p>
  )
}

const ShareImportSection = () => {
  const { t } = useTranslation("settings")
  const actionLength = useScopedActionRules((actions) => actions.length)
  const scopedActionActions = useScopedActionActions()
  const hasActions = actionLength > 0

  const handleExport = useCallback(() => {
    try {
      const jsonData = scopedActionActions.exportRules()
      const filename = generateExportFilename()
      downloadJsonFile(jsonData, filename)
      toast.success(`Action rules exported successfully as ${filename}`)
    } catch {
      toast.error("Failed to export action rules")
    }
  }, [scopedActionActions])

  const handleImport = useCallback(async () => {
    try {
      const jsonData = await selectJsonFile()
      const result = scopedActionActions.importRules(jsonData)

      if (result.success) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      if (error instanceof Error && error.message === "No file selected") {
        return
      }
      toast.error("Failed to import action rules")
    }
  }, [scopedActionActions])

  const foloPrefix = "folo:actions#"
  const handleCopyToClipboard = useCallback(async () => {
    try {
      const jsonData = scopedActionActions.exportRules()
      const codecData = JsonObfuscatedCodec.encode(jsonData)
      await copyToClipboard(`${foloPrefix}${codecData}`)
      toast.success("Action rules copied to clipboard")
    } catch (error) {
      toast.error("Failed to copy action rules to clipboard")
      console.error(error)
    }
  }, [foloPrefix, scopedActionActions])

  const handleImportFromClipboard = useCallback(async () => {
    try {
      const clipboardData = await readFromClipboard()
      if (!clipboardData.startsWith(foloPrefix)) {
        toast.error("Invalid clipboard data")
        return
      }
      const codecData = clipboardData.slice(foloPrefix.length)
      const jsonData = JsonObfuscatedCodec.decode(codecData)
      const result = scopedActionActions.importRules(jsonData)

      if (result.success) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("clipboard")) {
        toast.error(error.message)
      } else {
        toast.error("Failed to import from clipboard")
      }
      console.error(error)
    }
  }, [foloPrefix, scopedActionActions])

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            buttonClassName="size-9 p-0"
            aria-label={
              hasActions
                ? t("actions.action_card.summary.share")
                : t("actions.action_card.summary.import")
            }
          >
            <i
              className={cn(
                "size-4",
                hasActions ? "i-mgc-share-forward-cute-re" : "i-mgc-file-import-cute-re",
              )}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={handleExport} disabled={!hasActions}>
            <i className="i-mgc-download-2-cute-re mr-3 size-4" />
            {t("actions.action_card.summary.export")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleImport}>
            <i className="i-mgc-file-upload-cute-re mr-3 size-4" />
            {t("actions.action_card.summary.import_file")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleCopyToClipboard} disabled={!hasActions}>
            <i className="i-mgc-copy-2-cute-re mr-3 size-4" />
            {t("actions.action_card.summary.copy")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleImportFromClipboard}>
            <i className="i-mgc-paste-cute-re mr-3 size-4" />
            {t("actions.action_card.summary.import_clipboard")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const ActionButtonGroup = ({ onCreateRule }: { onCreateRule: () => void }) => {
  const queryClient = useQueryClient()
  const actionLength = useScopedActionRules((actions) => actions.length)
  const isDirty = useScopedActionDataDirty()
  const { t } = useTranslation("settings")

  useUnSavedBlocker(isDirty)

  const mutation = useScopedUpdateActionsMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["entries"],
      })
      toast(t("actions.saveSuccess"))
    },
    onError: (error) => {
      toastFetchError(error)
    },
  })

  const hasActions = actionLength > 0

  const setRightView = useSetSubViewRightView()
  useEffect(() => {
    setRightView(
      <HeaderActionGroup>
        <HeaderActionButton variant="primary" icon="i-mgc-add-cute-re" onClick={onCreateRule}>
          {t("actions.newRule")}
        </HeaderActionButton>

        {hasActions && (
          <HeaderActionButton
            variant="accent"
            icon="i-mgc-check-circle-cute-re"
            disabled={!isDirty}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Saving..." : t("actions.save")}
          </HeaderActionButton>
        )}
      </HeaderActionGroup>,
    )
    return () => {
      setRightView(null)
    }
  }, [setRightView, actionLength, hasActions, isDirty, mutation, onCreateRule, t])

  return null
}
