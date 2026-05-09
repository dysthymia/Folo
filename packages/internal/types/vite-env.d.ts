/// <reference types="vite/client" />

interface ImportMetaEnv {
  VITE_WEB_URL: string
  VITE_API_URL: string
  VITE_SENTRY_DSN: string
  VITE_FIREBASE_CONFIG: string
  VITE_SHOW_DEBUG_OVERLAYS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
