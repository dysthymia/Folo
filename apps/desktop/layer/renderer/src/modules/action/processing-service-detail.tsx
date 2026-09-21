import { useTranslation } from "react-i18next"

import { ProcessingSetting } from "./processing-setting"

/**
 * 处理服务规则的详情面板（§2 D2）。
 *
 * 可用时复用既有编辑面板（仍写本机 2240）；不可用时只说明原因与前提，不隐藏入口、
 * 也不用灰按钮替代解释——规则内容始终可以查看与编辑，只是不能启用/运行。
 */
export const ProcessingServiceDetail = ({
  available,
  onDirty,
}: {
  available: boolean
  onDirty: (dirty: boolean) => void
}) => {
  const { t } = useTranslation("app")
  if (!available) {
    return (
      <section className="mx-auto max-w-2xl space-y-3 p-6">
        <h2 className="text-base font-semibold text-text">
          {t("automation.processing_unavailable_title")}
        </h2>
        <p className="text-sm text-text-secondary">
          {t("automation.processing_unavailable_reason")}
        </p>
        <p className="text-sm text-text-secondary">
          {t("automation.processing_unavailable_prerequisite")}
        </p>
      </section>
    )
  }
  return <ProcessingSetting onDirty={onDirty} />
}
