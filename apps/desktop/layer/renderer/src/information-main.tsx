import "./styles/information.css"

import { createInstance } from "i18next"
import * as React from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { I18nextProvider, initReactI18next } from "react-i18next"

import en from "../../../../../locales/app/en.json"
import ja from "../../../../../locales/app/ja.json"
import zhCN from "../../../../../locales/app/zh-CN.json"
import { InformationPage } from "./modules/information/InformationPage"

// 同域生产入口只初始化翻译；沿用构建插件转换后的命名空间，不启动阅读器数据库。
const language = navigator.language.startsWith("zh")
  ? "zh-CN"
  : navigator.language.startsWith("ja")
    ? "ja"
    : "en"
const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: language,
  fallbackLng: "en",
  defaultNS: "app",
  resources: {
    en: { app: en },
    ja: { app: ja },
    "zh-CN": { app: zhCN },
  },
})
document.documentElement.lang = language
document.documentElement.dataset.informationPage = ""
document.title = i18n.t("information.title")
const container = document.getElementById("root")
if (!container) throw new Error("information_root_missing")
flushSync(() =>
  createRoot(container).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <InformationPage />
      </I18nextProvider>
    </React.StrictMode>,
  ),
)
// 首屏提交后移除共用 HTML 的阅读器占位层。
document.getElementById("app-skeleton")?.remove()
