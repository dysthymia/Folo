import { describe, expect, it } from "vitest"

import {
  getSettingsContentMarginTop,
  isUserHeaderGradientLight,
  USER_HEADER_BANNER_TOP_SPACING,
} from "./layout"

describe("getSettingsContentMarginTop", () => {
  it.each([
    { device: "iPhone 16 Pro", headerHeight: 112, safeAreaTop: 62 },
    { device: "iPhone with a notch", headerHeight: 91, safeAreaTop: 47 },
    { device: "Android with a tall cutout", headerHeight: 112, safeAreaTop: 48 },
  ])("keeps the settings banner flush with the top on $device", ({ headerHeight, safeAreaTop }) => {
    const bannerMarginTop = -safeAreaTop - USER_HEADER_BANNER_TOP_SPACING
    const bannerTop =
      safeAreaTop + headerHeight + getSettingsContentMarginTop(headerHeight) + bannerMarginTop

    expect(bannerTop).toBe(0)
  })
})

describe("isUserHeaderGradientLight", () => {
  it.each([
    { expected: false, imageColors: undefined, scenario: "missing image colors" },
    { expected: false, imageColors: { platform: "web" as const }, scenario: "web colors" },
    {
      expected: false,
      imageColors: { dominant: "#110000", platform: "android" as const },
      scenario: "dark Android colors",
    },
    {
      expected: true,
      imageColors: { platform: "ios" as const, primary: "#f5f5f5" },
      scenario: "light iOS colors",
    },
  ])("returns $expected for $scenario", ({ expected, imageColors }) => {
    expect(isUserHeaderGradientLight(imageColors)).toBe(expected)
  })
})
