/**
 * `crypto.randomUUID()` is restricted to secure contexts, so it disappears when the app is
 * served over plain HTTP — `http://local.folo.is`, where the information service runs. Electron
 * and HTTPS origins are unaffected, which is why this only shows up on the local deployment.
 * `crypto.getRandomValues()` carries no such restriction, so it can stand in with the same v4 UUID.
 *
 * Installed for the whole page rather than per call site: bundled dependencies reach for
 * `crypto.randomUUID()` unguarded as well (the realtime chat client sets `event_id` that way).
 */

/** v4 UUID shape, used to keep the fallback honest in tests. */
export const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function randomUuidFromRandomValues(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  // RFC 4122: version 4 in the high nibble of byte 6, variant 10xx in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function installRandomUuidPolyfill() {
  const cryptoObject = globalThis.crypto
  // Without WebCrypto there is nothing to build on, so leave the call site to fail loudly.
  if (!cryptoObject || typeof cryptoObject.getRandomValues !== "function") return
  if (typeof cryptoObject.randomUUID === "function") return

  Object.defineProperty(cryptoObject, "randomUUID", {
    configurable: true,
    value: randomUuidFromRandomValues,
    writable: true,
  })
}

installRandomUuidPolyfill()
