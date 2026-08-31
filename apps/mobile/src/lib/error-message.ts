const FOLLOW_API_REQUEST_CONTEXT_PATTERN = /\r?\nRequest:[\s\S]*$/u

export const sanitizeErrorMessage = (message: string) =>
  message.replace(FOLLOW_API_REQUEST_CONTEXT_PATTERN, "").trim()
