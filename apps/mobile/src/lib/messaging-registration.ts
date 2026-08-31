const DEFAULT_APNS_TOKEN_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const
const TRANSIENT_HTTP_STATUS_CODES = new Set([408, 425, 429])
const MAX_RETRY_COUNT = 3

const wait = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })

const getErrorStatus = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return
  }

  let status: unknown
  if ("status" in error) {
    status = error.status
  } else if ("statusCode" in error) {
    status = error.statusCode
  } else {
    return
  }

  const numericStatus = Number(status)
  if (Number.isInteger(numericStatus)) {
    return numericStatus
  }
}

export class APNSTokenUnavailableError extends Error {
  constructor() {
    super("APNs token is not available after registering for remote messages")
    this.name = "APNSTokenUnavailableError"
  }
}

export function shouldRetryMessagingTokenRegistration(failureCount: number, error: unknown) {
  if (failureCount >= MAX_RETRY_COUNT) {
    return false
  }

  const status = getErrorStatus(error)
  if (status === undefined) {
    return true
  }

  return status >= 500 || TRANSIENT_HTTP_STATUS_CODES.has(status)
}

export async function waitForAPNSToken({
  getAPNSToken,
  retryDelaysMs = DEFAULT_APNS_TOKEN_RETRY_DELAYS_MS,
  waitForRetry = wait,
}: {
  getAPNSToken: () => Promise<string | null>
  retryDelaysMs?: readonly number[]
  waitForRetry?: (delayMs: number) => Promise<void>
}) {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const token = await getAPNSToken()
    if (token) {
      return token
    }

    const retryDelayMs = retryDelaysMs[attempt]
    if (retryDelayMs !== undefined) {
      await waitForRetry(retryDelayMs)
    }
  }

  throw new APNSTokenUnavailableError()
}

export async function registerMessagingToken({
  platform,
  requestPermission,
  registerDeviceForRemoteMessages,
  getAPNSToken,
  getToken,
  saveToken,
  apnsTokenRetryDelaysMs,
  waitForRetry,
}: {
  platform: string
  requestPermission: () => Promise<boolean>
  registerDeviceForRemoteMessages: () => Promise<void>
  getAPNSToken: () => Promise<string | null>
  getToken: () => Promise<string>
  saveToken: (token: string) => Promise<void>
  apnsTokenRetryDelaysMs?: readonly number[]
  waitForRetry?: (delayMs: number) => Promise<void>
}) {
  const permissionGranted = await requestPermission()
  if (!permissionGranted) {
    return null
  }

  if (platform === "ios") {
    const existingAPNSToken = await getAPNSToken()
    if (!existingAPNSToken) {
      await registerDeviceForRemoteMessages()
      await waitForAPNSToken({
        getAPNSToken,
        retryDelaysMs: apnsTokenRetryDelaysMs,
        waitForRetry,
      })
    }
  }

  const token = await getToken()
  await saveToken(token)
  return token
}
