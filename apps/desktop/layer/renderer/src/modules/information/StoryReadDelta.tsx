import { useTranslation } from "react-i18next"

import type { StoryDigest } from "./processing-reader-client"

type Delta = NonNullable<Extract<StoryDigest, { status: "ready" }>["readDelta"]>
type DeltaFact = Delta["added"][number]

// 在原有综述阅读流里解释累积变化；反证和不确定说法保留原文引用供读者核对。
export function StoryReadDelta({ delta }: { delta: Delta }) {
  const { t } = useTranslation("app")
  return (
    <section
      className="space-y-2 rounded-lg bg-fill-quaternary p-3"
      data-story-read-delta={delta.scope}
    >
      <h4 className="font-medium">{t("processing.digest.delta.title")}</h4>
      <p className="text-xs text-text-secondary">
        {t(`processing.digest.delta.${delta.scope}`, {
          from: delta.fromRevision,
          to: delta.toRevision,
          count: delta.substantiveUpdateCount,
        })}
      </p>
      {delta.toRevision < delta.currentRevision && (
        <p className="text-xs text-text-secondary">
          {t("processing.digest.delta.frozen", { revision: delta.currentRevision })}
        </p>
      )}
      {delta.scope === "since_read" && (
        <>
          {delta.revised.length > 0 && (
            <div className="space-y-2">
              <h5 className="text-sm font-medium">{t("processing.digest.delta.revised")}</h5>
              {delta.revised.map(({ before, after }, index) => (
                <div key={index} className="space-y-2">
                  <p className="text-xs text-text-secondary">
                    {t("processing.digest.delta.before")}
                  </p>
                  <DeltaFactView fact={before} />
                  <p className="text-xs text-text-secondary">
                    {t("processing.digest.delta.after")}
                  </p>
                  <DeltaFactView fact={after} />
                </div>
              ))}
            </div>
          )}
          {(["added", "removed"] as const).map(
            (kind) =>
              delta[kind].length > 0 && (
                <div key={kind} className="space-y-2">
                  <h5 className="text-sm font-medium">{t(`processing.digest.delta.${kind}`)}</h5>
                  {delta[kind].map((fact, index) => (
                    <DeltaFactView key={index} fact={fact} />
                  ))}
                </div>
              ),
          )}
          {!delta.added.length && !delta.removed.length && !delta.revised.length && (
            <p className="text-xs text-text-secondary">
              {t("processing.digest.delta.no_net_change")}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function DeltaFactView({ fact }: { fact: DeltaFact }) {
  const { t } = useTranslation("app")
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="mr-2 text-xs text-text-secondary">
          {t(`processing.digest.delta.kind_${fact.kind}`)}
        </span>
        {fact.text}
      </p>
      {fact.dependencies.length > 0 && (
        <p className="text-xs text-text-secondary">
          {t("processing.digest.delta.depends_on", { facts: fact.dependencies.join("; ") })}
        </p>
      )}
      {fact.citations.length === 0 && (
        <p className="text-xs text-text-tertiary">
          {t("processing.digest.delta.citation_unavailable")}
        </p>
      )}
      {fact.citations.map((citation) => (
        <div className="text-xs text-text-secondary" key={citation.id}>
          {citation.sourceUrl ? (
            <a
              className="underline hover:text-text"
              href={citation.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {citation.sourceTitle}
            </a>
          ) : (
            citation.sourceTitle
          )}
          <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-fill pl-2 text-text-tertiary">
            {citation.quote}
          </blockquote>
        </div>
      ))}
    </div>
  )
}
