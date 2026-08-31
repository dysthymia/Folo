import { runInNewContext } from "node:vm"

import { minify } from "html-minifier-terser"
import { parseHTML } from "linkedom"
import { describe, expect, it } from "vitest"

import { createHydrationScript, injectHydrationScript } from "./hydration-script"

describe("hydration script", () => {
  it("keeps attacker-controlled keys and data inside a single script element", () => {
    const key = `profile</ScRiPt><script id="key-payload">`
    const data = {
      name: `</script><script id="data-payload">globalThis.__pwned__ = true</script><!--`,
      characters: "<>&\u2028\u2029",
    }
    const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>")

    injectHydrationScript(document, key, data)

    const serializedHtml = document.toString()
    const { document: reparsedDocument } = parseHTML(serializedHtml)
    const scripts = reparsedDocument.querySelectorAll("script")
    const scriptSource = scripts[0]?.textContent

    expect(scripts).toHaveLength(1)
    expect(reparsedDocument.querySelector("#key-payload")).toBeNull()
    expect(reparsedDocument.querySelector("#data-payload")).toBeNull()
    expect(scriptSource).not.toContain("<")
    expect(scriptSource).not.toContain(">")
    expect(scriptSource).not.toContain("&")
    expect(scriptSource).not.toContain("\u2028")
    expect(scriptSource).not.toContain("\u2029")

    const window = {} as {
      __HYDRATE__?: Record<string, unknown>
    }
    runInNewContext(scriptSource!, { window })

    expect(window.__HYDRATE__?.[key]).toEqual(data)
  })

  it("preserves JSON.parse semantics for __proto__ properties", () => {
    const data = JSON.parse(`{"__proto__":{"polluted":true}}`)
    const window = {} as {
      __HYDRATE__?: Record<string, unknown>
    }

    runInNewContext(createHydrationScript("profile", data), { window })

    const hydrated = window.__HYDRATE__?.profile as Record<string, unknown>
    expect(Object.hasOwn(hydrated, "__proto__")).toBe(true)
    expect((Object.getPrototypeOf(hydrated) as { polluted?: boolean }).polluted).toBeUndefined()
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it("defines a __proto__ hydration key without changing the store prototype", () => {
    const window = {} as {
      __HYDRATE__?: Record<string, unknown>
    }

    runInNewContext(createHydrationScript("__proto__", { value: "safe" }), { window })

    const hydrationStore = window.__HYDRATE__!
    expect(Object.hasOwn(hydrationStore, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(hydrationStore, "__proto__")?.value).toEqual({
      value: "safe",
    })
    expect((Object.getPrototypeOf(hydrationStore) as { value?: string }).value).toBeUndefined()
  })

  it("remains safe after production HTML and JavaScript minification", async () => {
    const key = "profile"
    const data = {
      name: `</script><script id="minified-payload">globalThis.__pwned__ = true</script>`,
    }
    const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>")
    injectHydrationScript(document, key, data)

    const minifiedHtml = await minify(document.toString(), {
      collapseBooleanAttributes: true,
      collapseInlineTagWhitespace: true,
      collapseWhitespace: true,
      html5: true,
      minifyCSS: true,
      minifyJS: true,
      removeComments: true,
      removeTagWhitespace: true,
    })
    const { document: reparsedDocument } = parseHTML(minifiedHtml)
    const scripts = reparsedDocument.querySelectorAll("script")
    const scriptSource = scripts[0]?.textContent

    expect(scripts).toHaveLength(1)
    expect(reparsedDocument.querySelector("#minified-payload")).toBeNull()
    expect(scriptSource?.toLowerCase()).not.toContain("</script")

    const window = {} as {
      __HYDRATE__?: Record<string, unknown>
    }
    runInNewContext(scriptSource!, { window })
    expect(window.__HYDRATE__?.[key]).toEqual(data)
  })

  it("rejects top-level values that JSON cannot serialize", () => {
    expect(() => createHydrationScript("profile", undefined)).toThrow(
      "Hydration data must be JSON serializable",
    )
  })
})
