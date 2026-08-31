import { getLuminance } from "@follow/utils/color"

export const USER_HEADER_BANNER_TOP_SPACING = 22

export const getSettingsContentMarginTop = (headerHeight: number) =>
  USER_HEADER_BANNER_TOP_SPACING - headerHeight

type UserHeaderImageColors =
  | { dominant: string; platform: "android" }
  | { platform: "ios"; primary: string }
  | { platform: "web" }

export const isUserHeaderGradientLight = (imageColors?: UserHeaderImageColors) => {
  if (!imageColors || imageColors.platform === "web") return false

  const dominantColor =
    imageColors.platform === "android" ? imageColors.dominant : imageColors.primary
  return getLuminance(dominantColor) > 0.5
}
