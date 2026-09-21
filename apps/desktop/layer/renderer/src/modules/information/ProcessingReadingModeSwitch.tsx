import { useTranslation } from "react-i18next"

import { originalReadingPath, smartReadingPath } from "./reading-mode-link"

export function ProcessingReadingModeSwitch({ mode }: { mode: "smart" | "original" }) {
  const { t } = useTranslation("app")
  const original =
    mode === "original"
      ? window.location.pathname + window.location.search
      : new URLSearchParams(window.location.search).get("returnTo")
  return (
    <nav
      className="flex shrink-0 items-center gap-1 rounded-lg bg-fill-quaternary p-1 text-xs"
      aria-label={t("processing.reader.mode")}
    >
      {(["original", "smart"] as const).map((value) => (
        <a
          key={value}
          aria-current={mode === value ? "page" : undefined}
          className={
            mode === value
              ? "rounded-md bg-background px-2 py-1 font-medium"
              : "rounded-md px-2 py-1 text-text-secondary hover:bg-fill"
          }
          href={
            value === "original" ? originalReadingPath(original) : smartReadingPath(original ?? "")
          }
        >
          {t(`processing.reader.mode_${value}`)}
        </a>
      ))}
    </nav>
  )
}
