import { describe, expect, it, vi } from "vitest"

import {
  APNSTokenUnavailableError,
  registerMessagingToken,
  shouldRetryMessagingTokenRegistration,
} from "./messaging-registration"

describe("messaging registration", () => {
  it("waits for an APNs token before requesting and saving the FCM token", async () => {
    const calls: string[] = []
    const getAPNSToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("apns-token")

    const result = await registerMessagingToken({
      platform: "ios",
      requestPermission: async () => {
        calls.push("permission")
        return true
      },
      registerDeviceForRemoteMessages: async () => {
        calls.push("register")
      },
      getAPNSToken: async () => {
        calls.push("apns")
        return getAPNSToken()
      },
      getToken: async () => {
        calls.push("fcm")
        return "fcm-token"
      },
      saveToken: async (token) => {
        calls.push(`save:${token}`)
      },
      apnsTokenRetryDelaysMs: [10],
      waitForRetry: async (delayMs) => {
        calls.push(`wait:${delayMs}`)
      },
    })

    expect(result).toBe("fcm-token")
    expect(calls).toEqual([
      "permission",
      "apns",
      "register",
      "apns",
      "wait:10",
      "apns",
      "fcm",
      "save:fcm-token",
    ])
  })

  it("uses an existing APNs token without registering again", async () => {
    const registerDeviceForRemoteMessages = vi.fn<() => Promise<void>>()

    await registerMessagingToken({
      platform: "ios",
      requestPermission: async () => true,
      registerDeviceForRemoteMessages,
      getAPNSToken: async () => "apns-token",
      getToken: async () => "fcm-token",
      saveToken: async () => {},
    })

    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
  })

  it("re-attempts native APNs registration after a registration failure", async () => {
    let apnsToken: string | null = null
    const registerDeviceForRemoteMessages = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("registration failed"))
      .mockImplementationOnce(async () => {
        apnsToken = "apns-token"
      })

    const registration = () =>
      registerMessagingToken({
        platform: "ios",
        requestPermission: async () => true,
        registerDeviceForRemoteMessages,
        getAPNSToken: async () => apnsToken,
        getToken: async () => "fcm-token",
        saveToken: async () => {},
        apnsTokenRetryDelaysMs: [],
      })

    await expect(registration()).rejects.toThrow("registration failed")
    await expect(registration()).resolves.toBe("fcm-token")
    expect(registerDeviceForRemoteMessages).toHaveBeenCalledTimes(2)
  })

  it("does not request a token when notification permission is denied", async () => {
    const getToken = vi.fn<() => Promise<string>>()
    const saveToken = vi.fn<(token: string) => Promise<void>>()

    const result = await registerMessagingToken({
      platform: "ios",
      requestPermission: async () => false,
      registerDeviceForRemoteMessages: vi.fn<() => Promise<void>>(),
      getAPNSToken: vi.fn<() => Promise<string | null>>(),
      getToken,
      saveToken,
    })

    expect(result).toBeNull()
    expect(getToken).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled()
  })

  it("skips APNs registration on Android", async () => {
    const registerDeviceForRemoteMessages = vi.fn<() => Promise<void>>()
    const getAPNSToken = vi.fn<() => Promise<string | null>>()
    const saveToken = vi.fn<(token: string) => Promise<void>>().mockResolvedValue()

    const result = await registerMessagingToken({
      platform: "android",
      requestPermission: async () => true,
      registerDeviceForRemoteMessages,
      getAPNSToken,
      getToken: async () => "android-fcm-token",
      saveToken,
    })

    expect(result).toBe("android-fcm-token")
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(getAPNSToken).not.toHaveBeenCalled()
    expect(saveToken).toHaveBeenCalledWith("android-fcm-token")
  })

  it("fails before requesting an FCM token when the APNs token never arrives", async () => {
    const getToken = vi.fn<() => Promise<string>>()
    const saveToken = vi.fn<(token: string) => Promise<void>>()

    await expect(
      registerMessagingToken({
        platform: "ios",
        requestPermission: async () => true,
        registerDeviceForRemoteMessages: vi.fn<() => Promise<void>>(),
        getAPNSToken: async () => null,
        getToken,
        saveToken,
        apnsTokenRetryDelaysMs: [10, 20],
        waitForRetry: async () => {},
      }),
    ).rejects.toBeInstanceOf(APNSTokenUnavailableError)

    expect(getToken).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled()
  })

  it("retries only transient failures and stops after three retries", () => {
    expect(shouldRetryMessagingTokenRegistration(0, new Error("offline"))).toBe(true)
    expect(shouldRetryMessagingTokenRegistration(2, { status: 503 })).toBe(true)
    expect(shouldRetryMessagingTokenRegistration(2, { statusCode: 429 })).toBe(true)
    expect(shouldRetryMessagingTokenRegistration(2, { status: 401 })).toBe(false)
    expect(shouldRetryMessagingTokenRegistration(3, new Error("offline"))).toBe(false)
  })
})
