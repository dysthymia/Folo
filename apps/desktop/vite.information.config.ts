import { defineConfig, mergeConfig } from "vite"

import webConfig from "./vite.config"

export default defineConfig((environment) =>
  mergeConfig(webConfig(environment), {
    plugins: [
      {
        name: "information-page-entry",
        // 信息工作台只读取后台接口，不启动阅读器的浏览器数据库和账号同步。
        transformIndexHtml: {
          order: "pre",
          handler(html: string) {
            return html.replace("/src/main.tsx", "/src/information-main.tsx")
          },
        },
      },
    ],
  }),
)
