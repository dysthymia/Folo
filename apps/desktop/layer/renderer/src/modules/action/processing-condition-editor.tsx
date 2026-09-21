import type { Condition, ConditionSet } from "@follow/information-core"
import { useTranslation } from "react-i18next"

import type { ProcessingEditor } from "./processing-client"

export const processingInputClass =
  "w-full rounded-lg border border-fill-secondary bg-material-opaque px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
export const processingButtonClass =
  "rounded-lg border border-fill-secondary px-3 py-2 text-sm text-text transition-colors hover:bg-fill-secondary disabled:opacity-40"
const viewLabels = [
  "processing.view.0",
  "processing.view.1",
  "processing.view.2",
  "processing.view.3",
  "processing.view.4",
  "processing.view.5",
] as const
const fields = [
  "source_id",
  "subscription_tag",
  "list_id",
  "category_ref",
  "view",
  "entry_title",
  "entry_content",
  "entry_url",
  "status",
  "visible_length",
  "title",
  "category",
  "site_url",
  "feed_url",
  "entry_author",
  "language",
  "platform",
  "content_completeness",
  "entry_media_length",
  "entry_attachments_duration",
  "updated_at",
] as const
type EditableField = (typeof fields)[number]
const defaultCondition = (field: EditableField): Condition => {
  switch (field) {
    case "subscription_tag":
    case "list_id":
    case "source_id":
      return { field, operator: "in", value: [] }
    case "category_ref":
      return { field, operator: "eq", value: { view: 0, name: "" } }
    case "view":
      return { field, operator: "eq", value: 0 }
    case "entry_media_length":
    case "entry_attachments_duration":
      return { field, operator: "gt", value: 0 }
    case "updated_at":
      return { field, operator: "gte", value: new Date().toISOString() }
    case "visible_length":
      return { field, operator: "lt", value: 50 }
    case "status":
      return { field, operator: "eq", value: "unread" }
    default:
      return { field, operator: "contains", value: "" }
  }
}

export function ProcessingConditionEditor({
  value,
  onChange,
  sources,
  tags = [],
  listMemberships = [],
  sourceInventoryKnown = false,
}: {
  value: ConditionSet
  onChange: (value: ConditionSet) => void
  sources: ProcessingEditor["sources"]
  tags?: ProcessingEditor["subscriptionTags"]["tags"]
  listMemberships?: ProcessingEditor["listMemberships"]
  sourceInventoryKnown?: boolean
}) {
  const { t } = useTranslation("app")
  const groups = "anyOf" in value ? value.anyOf : []
  const updateGroup = (index: number, allOf: Condition[]) =>
    onChange({ anyOf: groups.map((group, i) => (i === index ? { allOf } : group)) })
  return (
    <div className="space-y-3">
      <select
        aria-label={t("processing.match_mode")}
        className={processingInputClass}
        value={"all" in value ? "all" : "conditions"}
        onChange={(e) =>
          onChange(
            e.target.value === "all"
              ? { all: true }
              : { anyOf: [{ allOf: [defaultCondition("entry_title")] }] },
          )
        }
      >
        <option value="all">{t("processing.all")}</option>
        <option value="conditions">{t("processing.conditions")}</option>
      </select>
      {groups.map((group, groupIndex) => (
        <div key={groupIndex} className="space-y-2 rounded-lg border border-fill-secondary p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">
              {groupIndex ? t("processing.or_group") : t("processing.and_group")}
            </span>
            <button
              type="button"
              className={processingButtonClass}
              onClick={() => onChange({ anyOf: groups.filter((_, i) => i !== groupIndex) })}
            >
              {t("processing.remove_group")}
            </button>
          </div>
          {group.allOf.map((condition, index) => (
            <div key={index} className="flex items-start gap-2">
              <ConditionRow
                value={condition}
                sources={sources}
                tags={tags}
                listMemberships={listMemberships}
                sourceInventoryKnown={sourceInventoryKnown}
                onChange={(next) =>
                  updateGroup(
                    groupIndex,
                    group.allOf.map((item, i) => (i === index ? next : item)),
                  )
                }
              />
              <button
                type="button"
                className={processingButtonClass}
                aria-label={t("processing.remove_condition")}
                onClick={() =>
                  updateGroup(
                    groupIndex,
                    group.allOf.filter((_, i) => i !== index),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={processingButtonClass}
            onClick={() =>
              updateGroup(groupIndex, [...group.allOf, defaultCondition("entry_title")])
            }
          >
            {t("processing.add_condition")}
          </button>
        </div>
      ))}
      {"anyOf" in value && (
        <button
          type="button"
          className={processingButtonClass}
          onClick={() =>
            onChange({ anyOf: [...groups, { allOf: [defaultCondition("entry_title")] }] })
          }
        >
          {t("processing.add_group")}
        </button>
      )}
      {/* 删除最后一项仍是无效草稿，只有明确选择 ALL 才能成为全匹配。 */}
      {"anyOf" in value && (!groups.length || groups.some((group) => !group.allOf.length)) && (
        <p role="alert" className="text-sm text-red">
          {t("processing.empty_conditions")}
        </p>
      )}
    </div>
  )
}

function ConditionRow({
  value,
  onChange,
  sources,
  tags = [],
  listMemberships = [],
  sourceInventoryKnown = false,
}: {
  value: Condition
  onChange: (value: Condition) => void
  sources: ProcessingEditor["sources"]
  tags?: ProcessingEditor["subscriptionTags"]["tags"]
  listMemberships?: ProcessingEditor["listMemberships"]
  sourceInventoryKnown?: boolean
}) {
  const { t } = useTranslation("app")
  if (!(fields as readonly string[]).includes(value.field))
    return (
      <p className="flex-1 text-sm text-text-secondary">
        {t("processing.preserved_condition", {
          field: value.field,
          value:
            typeof value.value === "object" ? JSON.stringify(value.value) : String(value.value),
        })}
      </p>
    )
  const operators: Condition["operator"][] =
    value.field === "source_id" || value.field === "list_id" || value.field === "subscription_tag"
      ? ["in", "not_in", "contains_any", "contains_all", "not_contains_any"]
      : value.field === "category_ref" || value.field === "status" || value.field === "view"
        ? ["eq", "not_eq"]
        : [
              "visible_length",
              "entry_media_length",
              "entry_attachments_duration",
              "updated_at",
            ].includes(value.field)
          ? ["lt", "lte", "gt", "gte", "eq", "not_eq"]
          : ["contains", "not_contains", "eq", "not_eq", "regex"]
  // 字段切换创建对应类型的空条件；保存与预览前仍由共享 Schema 完整校验。
  return (
    <div className="grid flex-1 gap-2 sm:grid-cols-3">
      <select
        className={processingInputClass}
        aria-label={t("processing.field_label")}
        value={value.field}
        onChange={(e) => onChange(defaultCondition(e.target.value as EditableField))}
      >
        {fields.map((field) => (
          <option key={field} value={field}>
            {t(`processing.field.${field}`)}
          </option>
        ))}
      </select>
      <select
        className={processingInputClass}
        aria-label={t("processing.operator_label")}
        value={value.operator}
        onChange={(e) => onChange({ ...value, operator: e.target.value } as Condition)}
      >
        {[...new Set([...operators, value.operator])].map((operator) => (
          <option key={operator} value={operator}>
            {t(`processing.operator.${operator}`)}
          </option>
        ))}
      </select>
      {value.field === "source_id" ||
      value.field === "list_id" ||
      value.field === "subscription_tag" ? (
        <select
          multiple
          className={processingInputClass}
          aria-label={t("processing.value")}
          value={value.value}
          onChange={(e) =>
            onChange({ ...value, value: [...e.target.selectedOptions].map((item) => item.value) })
          }
        >
          {(value.field === "subscription_tag"
            ? tags.map((tag) => ({ key: tag.id, title: tag.name, disabled: false }))
            : value.field === "list_id"
              ? sources
                  .filter((source) => source.kind === "list")
                  .map((source) => {
                    const membership = listMemberships.find((item) => item.listKey === source.key)
                    const verified =
                      membership?.status === "complete" && membership.complete === true
                    const owner = membership?.ownerId
                      ? t("processing.list_owner", { ownerId: membership.ownerId })
                      : t("processing.list_owner_unknown")
                    const status = verified
                      ? t("processing.list_membership_complete", {
                          revision: membership.revision,
                          syncedAt: membership.syncedAt ?? "--",
                        })
                      : t("processing.list_membership_unknown")
                    return {
                      key: source.id,
                      title: `${source.title} · ${owner} · ${status}`,
                      disabled: !verified,
                    }
                  })
              : sources
                  .filter((source) => source.kind !== "list")
                  .map((source) => ({ ...source, disabled: false }))
          ).map((item) => (
            <option key={item.key} value={item.key} disabled={item.disabled}>
              {item.title} ({item.key})
            </option>
          ))}
          {value.value
            .filter((key) =>
              value.field === "subscription_tag"
                ? !tags.some((tag) => tag.id === key)
                : value.field === "list_id"
                  ? !sources.some((source) => source.id === key && source.kind === "list")
                  : !sources.some((source) => source.key === key),
            )
            .map((key) => (
              <option key={key} value={key}>
                {t("processing.unavailable_source", { source: key })}
              </option>
            ))}
        </select>
      ) : value.field === "category_ref" ? (
        <CategoryReferenceSelect
          value={value}
          sources={sources}
          sourceInventoryKnown={sourceInventoryKnown}
          onChange={onChange}
        />
      ) : value.field === "view" ? (
        <select
          className={processingInputClass}
          aria-label={t("processing.value")}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
        >
          {[0, 1, 2, 3, 4, 5].map((view) => (
            <option key={view} value={view}>
              {t(viewLabels[view] ?? "processing.choose")}
            </option>
          ))}
        </select>
      ) : value.field === "status" ? (
        <select
          className={processingInputClass}
          aria-label={t("processing.value")}
          value={value.value}
          onChange={(e) =>
            onChange({ ...value, value: e.target.value as "read" | "unread" | "collected" })
          }
        >
          {(["read", "unread", "collected"] as const).map((status) => (
            <option key={status} value={status}>
              {t(`processing.${status}`)}
            </option>
          ))}
        </select>
      ) : value.field === "visible_length" ||
        value.field === "entry_media_length" ||
        value.field === "entry_attachments_duration" ? (
        <input
          className={processingInputClass}
          aria-label={t("processing.value")}
          type="number"
          min={0}
          value={Number.isFinite(value.value) ? value.value : ""}
          onChange={(e) =>
            onChange({
              ...value,
              value: e.target.value === "" ? Number.NaN : Number(e.target.value),
            })
          }
        />
      ) : value.field === "updated_at" ? (
        <input
          className={processingInputClass}
          aria-label={t("processing.value")}
          type="datetime-local"
          value={
            Number.isFinite(Date.parse(value.value))
              ? new Date(
                  Date.parse(value.value) - new Date(value.value).getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)
              : ""
          }
          onChange={(event) =>
            onChange({
              ...value,
              value: event.target.value ? new Date(event.target.value).toISOString() : "",
            })
          }
        />
      ) : (
        <input
          className={processingInputClass}
          aria-label={t("processing.value")}
          value={String(value.value)}
          onChange={(e) => onChange({ ...value, value: e.target.value } as Condition)}
        />
      )}
    </div>
  )
}

function CategoryReferenceSelect({
  value,
  sources,
  sourceInventoryKnown,
  onChange,
}: {
  value: Extract<Condition, { field: "category_ref" }>
  sources: ProcessingEditor["sources"]
  sourceInventoryKnown: boolean
  onChange: (value: Condition) => void
}) {
  const { t } = useTranslation("app")
  const serialized = JSON.stringify(value.value)
  const activeCategories = [
    ...new Set(
      sources
        .filter((source) => source.category !== null && source.view >= 0)
        .map((source) => JSON.stringify({ view: source.view, name: source.category })),
    ),
  ]
  const active = activeCategories.includes(serialized)
  const identityStatus = active ? "active" : sourceInventoryKnown ? "missing" : "unknown"
  const selectedLabel = value.value.name
    ? `${value.value.name} · ${t(viewLabels[value.value.view] ?? "processing.choose")}`
    : t("processing.choose")
  return (
    <div className="space-y-1">
      <select
        className={processingInputClass}
        aria-label={t("processing.value")}
        value={serialized}
        onChange={(event) =>
          onChange({
            ...value,
            value: JSON.parse(event.target.value) as { view: number; name: string },
          })
        }
      >
        <option value={serialized}>
          {selectedLabel}
          {identityStatus === "missing"
            ? ` · ${t("processing.category_identity_missing")}`
            : identityStatus === "unknown"
              ? ` · ${t("processing.category_identity_unknown")}`
              : ""}
        </option>
        {activeCategories
          .filter((category) => category !== serialized)
          .map((category) => {
            const item = JSON.parse(category) as { view: number; name: string }
            return (
              <option key={category} value={category}>
                {item.name} · {t(viewLabels[item.view] ?? "processing.choose")}
              </option>
            )
          })}
      </select>
      {identityStatus === "missing" && (
        <p role="alert" className="text-sm text-red">
          {t("processing.category_identity_repair", {
            name: value.value.name,
            view: value.value.view,
          })}
        </p>
      )}
      {identityStatus === "unknown" && value.value.name && (
        <p className="text-sm text-text-secondary">
          {t("processing.category_identity_unverified")}
        </p>
      )}
    </div>
  )
}
