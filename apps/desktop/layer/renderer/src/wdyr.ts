import { SHOULD_SHOW_DEBUG_OVERLAYS } from "~/lib/debug-overlays"

if (SHOULD_SHOW_DEBUG_OVERLAYS) {
  const { scan } = await import("react-scan")
  scan({ enabled: false, log: false, showToolbar: true })
}
