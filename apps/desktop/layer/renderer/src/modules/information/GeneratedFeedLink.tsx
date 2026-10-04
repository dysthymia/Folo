import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router"

import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"

/** 与普通来源共用侧栏导航，点击后立即进入三栏阅读。 */
export function GeneratedFeedLink() {
  const { t } = useTranslation("app")
  const navigate = useNavigate()
  const location = useLocation()
  if (!isLocalFoloHost()) return null
  return (
    <button
      type="button"
      className="mx-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-fill-secondary"
      aria-current={location.pathname === "/events" ? "page" : undefined}
      onClick={(event) => {
        event.stopPropagation()
        navigate("/events")
      }}
    >
      <i className="i-mgc-news-cute-re" />
      {t("processing.generated.title")}
    </button>
  )
}
