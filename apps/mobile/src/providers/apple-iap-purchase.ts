export type ApplePurchaseIdentity = {
  id: string
  originalTransactionIdentifierIOS?: string | null
  productId: string
  purchaseToken?: string | null
  transactionId?: string | null
}

export type AppleVerificationRequest = {
  originalTransactionId?: string
  signedTransactionInfo?: string
  transactionId?: string
}

const compactJwsSegmentPattern = /^[\w-]+$/

export const isCompactJws = (value?: string | null): value is string => {
  if (!value) {
    return false
  }

  const segments = value.split(".")
  return (
    segments.length === 3 &&
    segments.every((segment) => segment.length > 0 && compactJwsSegmentPattern.test(segment))
  )
}

export const selectSignedTransactionInfo = (...candidates: Array<string | null | undefined>) =>
  candidates.find(isCompactJws)

export const isKnownAppleSubscriptionPurchase = (
  purchase: Pick<ApplePurchaseIdentity, "productId">,
  knownSubscriptionIds: ReadonlySet<string>,
) => knownSubscriptionIds.has(purchase.productId)

export const buildAppleVerificationRequest = (
  purchase: ApplePurchaseIdentity,
  signedTransactionInfo?: string | null,
): AppleVerificationRequest => ({
  originalTransactionId: purchase.originalTransactionIdentifierIOS || undefined,
  signedTransactionInfo: isCompactJws(signedTransactionInfo) ? signedTransactionInfo : undefined,
  transactionId: purchase.transactionId || purchase.id || undefined,
})
