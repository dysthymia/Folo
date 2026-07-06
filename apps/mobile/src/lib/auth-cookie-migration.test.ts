import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCookie: vi.fn(() => "better-auth.session_token=session"),
  getInstallerPackageName: vi.fn(async () => "com.android.vending"),
  getUserAgent: vi.fn(async () => "Folo/0.5.5"),
  oneTimeTokenApply: vi.fn(async () => {}),
}))

vi.mock("@follow/utils/headers", () => ({
  createMobileAPIHeaders: vi.fn(() => ({
    "x-app-version": "0.5.5",
  })),
}))

vi.mock("expo-application", () => ({
  nativeApplicationVersion: "0.5.5",
}))

vi.mock("react-native", () => ({
  Platform: {
    OS: "android",
    isPad: false,
  },
}))

vi.mock("react-native-device-info", () => ({
  default: {
    getInstallerPackageName: mocks.getInstallerPackageName,
  },
}))

vi.mock("./auth", () => ({
  getCookie: mocks.getCookie,
  oneTimeToken: {
    apply: mocks.oneTimeTokenApply,
  },
}))

vi.mock("./client-session", () => ({
  getClientId: () => "client-id",
  getSessionId: () => "session-id",
}))

vi.mock("./native/user-agent", () => ({
  getUserAgent: mocks.getUserAgent,
}))

vi.mock("./proxy-env", () => ({
  proxyEnv: {
    API_URL: "https://api.folo.is",
  },
}))

const { migrateLegacyApiSession } = await import("./auth-cookie-migration")

describe("migrateLegacyApiSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("uses the Folo native app scheme as the migration auth origin", async () => {
    const fetchMock = vi.fn(async (input: string, _options?: RequestInit): Promise<Response> => {
      if (input === "https://api.folo.is/better-auth/get-session") {
        return new Response(null, { status: 401 })
      }

      if (input === "https://api.follow.is/better-auth/get-session") {
        return Response.json({ user: { id: "user-id" } })
      }

      if (input === "https://api.follow.is/better-auth/one-time-token/generate") {
        return Response.json({ token: "one-time-token" })
      }

      return new Response(null, { status: 404 })
    })

    vi.stubGlobal("fetch", fetchMock)

    await migrateLegacyApiSession()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).toMatchObject({
        "expo-origin": "folo://",
      })
    }
    expect(mocks.oneTimeTokenApply).toHaveBeenCalledWith({ token: "one-time-token" })
  })
})
