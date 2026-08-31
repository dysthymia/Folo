import postcss from "postcss"
import { cssToReactNativeRuntime } from "react-native-css-interop/css-to-rn"
import { withUIKit } from "react-native-uikit-colors/tailwind"
import tailwindcss from "tailwindcss"
import { describe, expect, it } from "vitest"

const alphaColorClasses = [
  "border-separator",
  "border-non-opaque-separator",
  "bg-system-fill",
  "bg-secondary-system-fill",
  "bg-tertiary-system-fill",
  "bg-quaternary-system-fill",
  "text-secondary-label",
  "text-tertiary-label",
  "text-quaternary-label",
]

describe("UIKit alpha colors", () => {
  it("compiles semantic colors for the native runtime", async () => {
    const config = withUIKit({
      content: [{ raw: alphaColorClasses.join(" ") }],
    })
    const { css } = await postcss([tailwindcss(config)]).process("@tailwind utilities;", {
      from: undefined,
    })
    const compiled = cssToReactNativeRuntime(css)

    for (const className of alphaColorClasses) {
      const ruleSet = compiled.rules?.[className]
      const hasDeclarations = ruleSet?.n?.some((rule) => (rule.d?.length ?? 0) > 0)

      expect(ruleSet?.warnings, className).toBeUndefined()
      expect(hasDeclarations, className).toBe(true)
    }
  })
})
