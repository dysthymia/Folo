import { describe, expect, it } from "vitest"

import createExpoConfig, { resolveRuntimeVersion } from "../app.config.base"

describe("resolveRuntimeVersion", () => {
  it("keeps the development runtime version stable", () => {
    expect(
      resolveRuntimeVersion({
        isDevelopment: true,
        packageVersion: "0.4.2",
        otaRuntimeVersionOverride: "0.4.1",
      }),
    ).toBe("0.0.0-dev")
  })

  it("uses OTA_RUNTIME_VERSION for OTA exports", () => {
    expect(
      resolveRuntimeVersion({
        isDevelopment: false,
        packageVersion: "0.4.2",
        otaRuntimeVersionOverride: "0.4.1",
      }),
    ).toBe("0.4.1")
  })

  it("rejects invalid OTA runtime versions", () => {
    expect(() =>
      resolveRuntimeVersion({
        isDevelopment: false,
        packageVersion: "0.4.2",
        otaRuntimeVersionOverride: "0.4",
      }),
    ).toThrow(/OTA_RUNTIME_VERSION/i)
  })
})

describe("Android media permissions", () => {
  const config = createExpoConfig({
    config: {},
  } as Parameters<typeof createExpoConfig>[0])

  it("blocks broad media access that is not required by the app", () => {
    expect(config.android?.blockedPermissions).toEqual([
      "android.permission.ACCESS_MEDIA_LOCATION",
      "android.permission.CAMERA",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      "android.permission.RECORD_AUDIO",
    ])
  })

  it("configures media APIs for picker and write-only access", () => {
    expect(config.plugins).toContainEqual([
      "expo-media-library",
      {
        photosPermission: "Allow $(PRODUCT_NAME) to access your photos.",
        savePhotosPermission: "Allow $(PRODUCT_NAME) to save photos.",
        isAccessMediaLocationEnabled: false,
        granularPermissions: [],
      },
    ])
    expect(config.plugins).toContainEqual([
      "expo-image-picker",
      {
        photosPermission: "Allow $(PRODUCT_NAME) to access your photos.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ])
  })
})
