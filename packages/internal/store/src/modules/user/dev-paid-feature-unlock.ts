import { UserRole } from "@follow/constants"

declare global {
  var __foloDevPaidFeatureUnlock: boolean | undefined
}

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
  globalThis.__foloDevPaidFeatureUnlock = enabled
}

export const isDevPaidFeatureUnlockEnabled = () => {
  return globalThis.__foloDevPaidFeatureUnlock === true
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
