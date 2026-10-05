import { z } from "zod"

const preferenceSchema = z
  .object({
    visible: z.boolean(),
    group: z.string().trim().max(100),
    collapsed: z.boolean(),
  })
  .strict()
export type GeneratedSourcePreferences = z.infer<typeof preferenceSchema>
export const generatedSourcePreferencesChanged = "folo:generated-source-preferences"
const defaultPreferences: GeneratedSourcePreferences = {
  visible: true,
  group: "",
  collapsed: false,
}
const storageKey = (ownerId: string) => `folo:generated-source:${encodeURIComponent(ownerId)}`

/** 私人来源分组是当前设备的阅读偏好，不写官方订阅或删除历史综述。 */
export function loadGeneratedSourcePreferences(
  ownerId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): GeneratedSourcePreferences {
  try {
    const value = storage.getItem(storageKey(ownerId))
    if (!value || value.length > 2048) return { ...defaultPreferences }
    const parsed = preferenceSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : { ...defaultPreferences }
  } catch {
    return { ...defaultPreferences }
  }
}

export function saveGeneratedSourcePreferences(
  ownerId: string,
  value: GeneratedSourcePreferences,
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  try {
    storage.setItem(storageKey(ownerId), JSON.stringify(preferenceSchema.parse(value)))
    window.dispatchEvent(
      new CustomEvent(generatedSourcePreferencesChanged, { detail: { ownerId } }),
    )
    return true
  } catch {
    return false
  }
}
