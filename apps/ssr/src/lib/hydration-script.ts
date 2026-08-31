const serializeJsonForInlineScript = (value: unknown): string => {
  const serialized = JSON.stringify(value)

  if (serialized === undefined) {
    throw new TypeError("Hydration data must be JSON serializable")
  }

  return serialized
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}

export const createHydrationScript = (key: string, data: unknown): string => {
  const serializedData = JSON.stringify(data)

  if (serializedData === undefined) {
    throw new TypeError("Hydration data must be JSON serializable")
  }

  return `
    window.__HYDRATE__ = window.__HYDRATE__ || {}
    Object.defineProperty(window.__HYDRATE__, ${serializeJsonForInlineScript(key)}, {
      configurable: true,
      enumerable: true,
      value: JSON.parse(${serializeJsonForInlineScript(serializedData)}),
      writable: true,
    })
  `
}

export const injectHydrationScript = (document: Document, key: string, data: unknown): void => {
  const script = document.createElement("script")
  script.textContent = createHydrationScript(key, data)
  document.head.append(script)
}
