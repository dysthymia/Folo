import { isBizId } from "@follow/utils/utils"
import type { FollowClient } from "@follow-app/client-sdk"

export const resolveUserProfileParams = (handleOrId: string | undefined) => {
  if (isBizId(handleOrId || "")) {
    return {
      id: handleOrId,
      handle: undefined,
    }
  }

  return {
    id: undefined,
    handle: handleOrId?.startsWith("@") ? handleOrId.slice(1) : handleOrId,
  }
}

export const getUserProfile = (apiClient: FollowClient, handleOrId: string | undefined) =>
  apiClient.api.profiles.getProfile(resolveUserProfileParams(handleOrId))
