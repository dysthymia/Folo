import { Popover, PopoverContent, PopoverTrigger } from "@follow/components/ui/popover/index.js"
import type { SemanticTagId, TagDefinition } from "@follow/information-core"
import { semanticTagDefinitions } from "@follow/information-core"
import { cn } from "@follow/utils/utils"
import { Anchor as PopoverAnchor } from "@radix-ui/react-popover"
import { Command } from "cmdk"
import { useState } from "react"
import { useTranslation } from "react-i18next"

const tagKinds = ["topic", "event", "form", "signal", "workflow"] as const
const definitionsById = new Map(semanticTagDefinitions.map((tag) => [tag.id, tag]))
// 按语义类别使用柔和底色，同一个标签在已选区与菜单中保持一致。
const tagColors: Record<TagDefinition["kind"], string> = {
  topic: "bg-blue/10",
  event: "bg-purple/10",
  form: "bg-orange/10",
  signal: "bg-green/10",
  workflow: "bg-gray/10",
}

export function SemanticTagPicker({
  value,
  onChange,
}: {
  value: readonly SemanticTagId[]
  onChange: (value: SemanticTagId[]) => void
}) {
  const { t } = useTranslation("app")
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const name = (id: SemanticTagId) => t(`semantic.tag.${id}`, { nsSeparator: false })
  const selected = value.flatMap((id) => {
    const tag = definitionsById.get(id)
    return tag ? [tag] : []
  })
  const query = search.normalize("NFKC").trim().toLocaleLowerCase()
  const matches = semanticTagDefinitions.filter(
    (tag) =>
      tag.enabled &&
      [name(tag.id), tag.name, tag.id, ...tag.aliases].some((text) =>
        text.normalize("NFKC").toLocaleLowerCase().includes(query),
      ),
  )
  // 多选只更新当前草稿，保留原选项顺序；连续选择时菜单保持打开。
  const toggle = (id: SemanticTagId) =>
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch("")
      }}
    >
      {/* 菜单定位到整个标签框，向上展开时也不会覆盖已经选中的标签。 */}
      <PopoverAnchor asChild>
        <div
          role="group"
          aria-label={t("processing.semantic_tags")}
          className="flex min-h-10 min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-fill-secondary bg-material-opaque p-2 focus-within:border-accent"
        >
          {selected.map((tag) => (
            <span
              key={tag.id}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded px-2 py-0.5 text-xs text-text",
                tagColors[tag.kind],
              )}
            >
              <span className="min-w-0 break-words">{name(tag.id)}</span>
              <button
                type="button"
                aria-label={t("processing.semantic_picker.remove", { name: name(tag.id) })}
                className="rounded p-0.5 text-text-secondary hover:bg-fill-secondary focus-visible:outline focus-visible:outline-accent"
                onClick={() => onChange(value.filter((id) => id !== tag.id))}
              >
                <i aria-hidden className="i-mgc-close-cute-re block size-3" />
              </button>
            </span>
          ))}
          {/* 移除按钮与打开菜单的按钮并列，避免把按钮嵌在另一个按钮里。 */}
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("processing.semantic_tags")}
              className="flex min-w-20 flex-1 items-center gap-1 whitespace-nowrap rounded px-1 py-1 text-left text-xs text-text-secondary hover:bg-fill-quaternary focus-visible:outline focus-visible:outline-accent"
            >
              {selected.length > 0 && (
                <i aria-hidden className="i-mgc-add-cute-re size-3 shrink-0" />
              )}
              <span>
                {t(`processing.semantic_picker.${selected.length ? "add" : "placeholder"}`)}
              </span>
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      {/* 关闭时不挂载 Portal，静态渲染和多个条件行都不创建隐藏菜单。 */}
      {open && (
        <PopoverContent
          align="start"
          className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] flex-col p-0"
          aria-label={t("processing.semantic_tags")}
        >
          <Command shouldFilter={false} className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-fill-secondary px-3 py-2">
              <i aria-hidden className="i-mgc-search-cute-re size-4 shrink-0 text-text-tertiary" />
              <Command.Input
                autoFocus
                aria-label={t("processing.semantic_picker.search")}
                placeholder={t("processing.semantic_picker.search")}
                value={search}
                onValueChange={setSearch}
                className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
              />
            </div>
            <Command.List className="max-h-64 min-h-0 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-sm text-text-secondary">
                {t("processing.semantic_picker.empty")}
              </Command.Empty>
              {tagKinds.map((kind) => {
                const group = matches.filter((tag) => tag.kind === kind)
                return group.length === 0 ? null : (
                  <Command.Group
                    key={kind}
                    heading={t(`processing.semantic_picker.group_${kind}`)}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-text-tertiary"
                  >
                    {group.map((tag) => {
                      const checked = value.includes(tag.id)
                      return (
                        <Command.Item
                          key={tag.id}
                          value={tag.id}
                          title={tag.description}
                          aria-label={t(
                            `processing.semantic_picker.${checked ? "option_remove" : "option_add"}`,
                            { name: name(tag.id) },
                          )}
                          onSelect={() => toggle(tag.id)}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 outline-none data-[selected=true]:bg-fill-secondary"
                        >
                          <span
                            className={cn("rounded px-2 py-0.5 text-xs text-text", tagColors[kind])}
                          >
                            {name(tag.id)}
                          </span>
                          {checked && (
                            <i aria-hidden className="i-mgc-check-cute-re size-4 text-accent" />
                          )}
                        </Command.Item>
                      )
                    })}
                  </Command.Group>
                )
              })}
            </Command.List>
          </Command>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-fill-secondary px-3 py-2 text-xs">
            <span className="text-text-secondary">
              {t("processing.semantic_picker.count", { count: value.length })}
            </span>
            <button
              type="button"
              disabled={value.length === 0}
              onClick={() => onChange([])}
              className="rounded px-1 py-0.5 text-text-secondary hover:bg-fill-secondary disabled:opacity-40"
            >
              {t("processing.semantic_picker.clear")}
            </button>
          </div>
        </PopoverContent>
      )}
    </Popover>
  )
}
