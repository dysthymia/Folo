export const nativeOAuthCallbackURL = "folo://"

type LoginWithSocialProviderOptions = {
  providerId: string
  setPendingProviderId: (providerId: string | null) => void
  signInWithProvider: (
    providerId: string,
    options: { callbackURL: typeof nativeOAuthCallbackURL },
  ) => Promise<void>
  signInWithAppleIdentityToken: () => Promise<void>
  syncSession: () => Promise<boolean>
  trackLogin: () => void
  onError?: (error: unknown) => void
}

export async function loginWithSocialProvider({
  providerId,
  setPendingProviderId,
  signInWithProvider,
  signInWithAppleIdentityToken,
  syncSession,
  trackLogin,
  onError,
}: LoginWithSocialProviderOptions) {
  setPendingProviderId(providerId)

  try {
    if (providerId === "apple") {
      await signInWithAppleIdentityToken()
    } else {
      await signInWithProvider(providerId, { callbackURL: nativeOAuthCallbackURL })
    }

    const hasSession = await syncSession()
    if (hasSession) {
      trackLogin()
    }
    return hasSession
  } catch (error) {
    onError?.(error)
    return false
  } finally {
    setPendingProviderId(null)
  }
}
