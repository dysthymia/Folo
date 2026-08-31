import { describe, expect, it } from "vitest"

import {
  buildAppleVerificationRequest,
  isCompactJws,
  isKnownAppleSubscriptionPurchase,
  selectSignedTransactionInfo,
} from "./apple-iap-purchase"

describe("Apple IAP purchase identifiers", () => {
  it("matches subscriptions by product ID instead of transaction ID", () => {
    const knownSubscriptionIds = new Set(["is.follow.basic.monthly"])
    const purchase = {
      id: "2000001234567890",
      productId: "is.follow.basic.monthly",
    }

    expect(isKnownAppleSubscriptionPurchase(purchase, knownSubscriptionIds)).toBe(true)
  })

  it("builds verification hints from transaction identifiers", () => {
    const request = buildAppleVerificationRequest(
      {
        id: "2000001234567890",
        originalTransactionIdentifierIOS: "2000001000000000",
        productId: "is.follow.basic.monthly",
        transactionId: "2000001234567890",
      },
      "header.payload.signature",
    )

    expect(request).toEqual({
      originalTransactionId: "2000001000000000",
      signedTransactionInfo: "header.payload.signature",
      transactionId: "2000001234567890",
    })
  })

  it("falls back to the purchase ID when transactionId is absent", () => {
    expect(
      buildAppleVerificationRequest({
        id: "2000001234567890",
        productId: "is.follow.basic.monthly",
      }),
    ).toEqual({
      originalTransactionId: undefined,
      signedTransactionInfo: undefined,
      transactionId: "2000001234567890",
    })
  })

  it("does not submit a transaction ID as signed transaction info", () => {
    expect(isCompactJws("2000001234567890")).toBe(false)
    expect(selectSignedTransactionInfo("2000001234567890", null, "header.payload.signature")).toBe(
      "header.payload.signature",
    )
    expect(
      buildAppleVerificationRequest(
        {
          id: "2000001234567890",
          productId: "is.follow.basic.monthly",
          purchaseToken: "2000001234567890",
        },
        "2000001234567890",
      ),
    ).toEqual({
      originalTransactionId: undefined,
      signedTransactionInfo: undefined,
      transactionId: "2000001234567890",
    })
  })
})
