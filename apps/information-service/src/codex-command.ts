import { accessSync, constants } from "node:fs"

// 目录与推理共用同一 CLI；macOS 优先使用正在交付新版模型能力的客户端内置版本。
export function resolveCodexCommand(
  options: {
    override?: string
    platform?: string
    bundledPath?: string
  } = {},
): string {
  const override = options.override ?? process.env.CODEX_BIN
  if (override) return override
  if ((options.platform ?? process.platform) === "darwin") {
    const bundled =
      options.bundledPath ??
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
    try {
      accessSync(bundled, constants.X_OK)
      return bundled
    } catch {
      // 无桌面客户端的环境继续使用 PATH 中安装的 CLI，不改变用户配置。
    }
  }
  return "codex"
}
