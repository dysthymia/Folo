import type { TagDefinition } from "@follow/information-core"
import { useWhoami } from "@follow/store/user/hooks"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"
import { loadSemanticTagCatalog } from "~/modules/information/processing-semantic-client"

const tagKinds = ["topic", "event", "form", "signal", "workflow"] as const
type TagKindFilter = "all" | TagDefinition["kind"]

export function SettingSemanticTags() {
  const ownerId = useWhoami()?.id
  // 切换账号后重新读取；非本机页面不向官方请求这个本地目录。
  return isLocalFoloHost() && ownerId ? <SemanticTagCatalog key={ownerId} /> : null
}

export function SemanticTagCatalog() {
  const { t } = useTranslation("settings")
  const { t: tagName } = useTranslation("app")
  const [definitions, setDefinitions] = useState<TagDefinition[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [search, setSearch] = useState("")
  const [kind, setKind] = useState<TagKindFilter>("all")

  useEffect(() => {
    const controller = new AbortController()
    setDefinitions(null)
    setFailed(false)
    void loadSemanticTagCatalog(controller.signal)
      .then(({ definitions }) => {
        if (!controller.signal.aborted) setDefinitions(definitions)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [reload])

  // 搜索覆盖真实定义、正反例和别名；仅筛选已读取的目录，不额外请求或调用 AI。
  const query = search.normalize("NFKC").trim().toLocaleLowerCase()
  const matches = (definitions ?? []).filter(
    (definition) =>
      (kind === "all" || kind === definition.kind) &&
      [
        definition.id,
        definition.name,
        tagName(`semantic.tag.${definition.id}`, { nsSeparator: false }),
        definition.description,
        ...definition.aliases,
        ...definition.positiveExamples,
        ...definition.negativeExamples,
      ].some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(query)),
  )

  return (
    <div className="space-y-5 pb-6 text-sm">
      <p className="leading-relaxed text-text-secondary">{t("tags.description")}</p>
      <aside className="space-y-2 rounded-xl bg-fill-quaternary p-4 text-text-secondary">
        <p>{t("tags.entities_hint")}</p>
        <p>{t("tags.combination_hint")}</p>
        <p className="text-xs">{t("tags.readonly_hint")}</p>
      </aside>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <span className="text-red">{t("tags.load_failed")}</span>
          <button
            type="button"
            className="rounded px-2 py-1 text-accent focus-visible:outline focus-visible:outline-accent"
            onClick={() => setReload((value) => value + 1)}
          >
            {t("tags.retry")}
          </button>
        </div>
      ) : definitions === null ? (
        <p role="status" className="text-text-secondary">
          {t("tags.loading")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="block text-xs text-text-secondary">{t("tags.search")}</span>
              <input
                type="search"
                className="w-full rounded-lg border border-fill-secondary bg-material-opaque px-3 py-2"
                placeholder={t("tags.search_placeholder")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs text-text-secondary">{t("tags.kind_label")}</span>
              <select
                className="max-w-full rounded-lg border border-fill-secondary bg-material-opaque px-3 py-2"
                value={kind}
                onChange={(event) => setKind(event.target.value as TagKindFilter)}
              >
                <option value="all">{t("tags.all")}</option>
                {tagKinds
                  .filter((kind) => definitions.some((definition) => definition.kind === kind))
                  .map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`tags.kind.${kind}`)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <p role="status" className="text-xs text-text-secondary">
            {t("tags.count", { visible: matches.length, total: definitions.length })}
          </p>
          {matches.length === 0 && <p className="text-text-secondary">{t("tags.empty")}</p>}
          {tagKinds.map((kind) => {
            const group = matches.filter((definition) => definition.kind === kind)
            return group.length === 0 ? null : (
              <section key={kind} aria-labelledby={`semantic-tags-${kind}`} className="space-y-3">
                <h2 id={`semantic-tags-${kind}`} className="font-semibold">
                  {t(`tags.kind.${kind}`)} · {group.length}
                </h2>
                {group.map((definition) => (
                  <article
                    key={definition.id}
                    className="min-w-0 rounded-xl border border-fill-secondary p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">
                        {tagName(`semantic.tag.${definition.id}`, { nsSeparator: false })}
                      </h3>
                      <span className="rounded bg-fill-quaternary px-2 py-0.5 text-xs text-text-secondary">
                        {t("tags.version", { version: definition.definitionVersion })}
                      </span>
                      {!definition.enabled && (
                        <span className="text-xs text-text-tertiary">{t("tags.disabled")}</span>
                      )}
                    </div>
                    {/* 正文直接展示服务端定义，不用简化后的界面翻译替代模型判断标准。 */}
                    <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-text-secondary">
                      {definition.description}
                    </p>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-accent">
                        {t("tags.details")}
                      </summary>
                      <div className="mt-3 space-y-3">
                        {(["positiveExamples", "negativeExamples"] as const).map((field) => (
                          <div key={field}>
                            <h4 className="text-xs font-medium">{t(`tags.${field}`)}</h4>
                            <ul className="mt-1 list-disc space-y-1 break-words pl-5 text-text-secondary">
                              {definition[field].map((example) => (
                                <li key={example}>{example}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                        <dl className="space-y-1 break-words text-xs text-text-secondary">
                          <div>
                            <dt className="inline font-medium">{t("tags.identifier")}：</dt>
                            <dd className="inline">{definition.id}</dd>
                          </div>
                          <div>
                            <dt className="inline font-medium">{t("tags.origin_label")}：</dt>
                            <dd className="inline">{t(`tags.origin.${definition.origin}`)}</dd>
                          </div>
                          {definition.parentId && (
                            <div>
                              <dt className="inline font-medium">{t("tags.parent")}：</dt>
                              <dd className="inline">
                                {tagName(`semantic.tag.${definition.parentId}`, {
                                  nsSeparator: false,
                                })}
                              </dd>
                            </div>
                          )}
                          {definition.aliases.length > 0 && (
                            <div>
                              <dt className="inline font-medium">{t("tags.aliases")}：</dt>
                              <dd className="inline">{definition.aliases.join(" · ")}</dd>
                            </div>
                          )}
                        </dl>
                      </div>
                    </details>
                  </article>
                ))}
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}
