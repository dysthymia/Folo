import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Codex的真实子进程退出测试单独使用node:test，避免嵌套测试运行器。
    exclude: ["**/node_modules/**", "**/dist/**", "**/codex.test.ts"],
  },
})
