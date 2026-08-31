import type { FollowClient } from "@follow-app/client-sdk"
import { describe, expect, it, vi } from "vitest"

import { getUserProfile, resolveUserProfileParams } from "./user-profile-params"

vi.mock("@follow/utils/utils", () => ({
  isBizId: (value: string | undefined) => value === "41125409313095680",
}))

describe("resolveUserProfileParams", () => {
  it("uses a handle without also sending it as an id", () => {
    expect(resolveUserProfileParams("DIYgod")).toEqual({
      id: undefined,
      handle: "DIYgod",
    })
  })

  it("removes a leading at sign from handles", () => {
    expect(resolveUserProfileParams("@DIYgod")).toEqual({
      id: undefined,
      handle: "DIYgod",
    })
  })

  it("uses a business id without also sending it as a handle", () => {
    expect(resolveUserProfileParams("41125409313095680")).toEqual({
      id: "41125409313095680",
      handle: undefined,
    })
  })

  it("uses the resolved parameters for the profile request", async () => {
    const getProfile = vi.fn().mockResolvedValue({ data: { id: "profile-id" } })
    const apiClient = {
      api: {
        profiles: {
          getProfile,
        },
      },
    } as unknown as FollowClient

    await getUserProfile(apiClient, "DIYgod")

    expect(getProfile).toHaveBeenCalledOnce()
    expect(getProfile).toHaveBeenCalledWith({
      id: undefined,
      handle: "DIYgod",
    })
  })
})
