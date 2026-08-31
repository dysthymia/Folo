import { UserRole } from "@follow/constants"

type DevPaidFeatureGlobal = typeof globalThis & {
  __foloDevPaidFeatureUnlock?: boolean
}

// 使用同一个全局容器，确保桌面入口与共享 store 在热更新后仍读取同一开关。
const devPaidFeatureGlobal = globalThis as DevPaidFeatureGlobal

const paidFeatureUnlockEnabledValues = new Set(["1", "true", "yes", "on"])

export const resolveDevPaidFeatureUnlock = ({
  isDev,
  value,
}: {
  isDev: boolean
  value?: string | null
}) => {
  return isDev && paidFeatureUnlockEnabledValues.has(value?.trim().toLowerCase() ?? "")
}

export const setDevPaidFeatureUnlock = (enabled: boolean) => {
  devPaidFeatureGlobal.__foloDevPaidFeatureUnlock = enabled
}

export const isDevPaidFeatureUnlockEnabled = () => {
  return devPaidFeatureGlobal.__foloDevPaidFeatureUnlock === true
}

export const getEffectiveUserRole = (role: UserRole | null | undefined): UserRole | null => {
  if (isDevPaidFeatureUnlockEnabled()) {
    return UserRole.Pro
  }
  return role ?? null
}

export const isEffectiveFreeRole = (role: UserRole | null | undefined) => {
  const effectiveRole = getEffectiveUserRole(role)
  return effectiveRole ? effectiveRole === UserRole.Free || effectiveRole === UserRole.Trial : true
}

export const hasPaidFeatureAccess = (role: UserRole | null | undefined) => {
  return !isEffectiveFreeRole(role)
}
