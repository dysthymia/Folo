#!/bin/zsh

set -euo pipefail

readonly repo_dir="/Volumes/SSD/Dev/Code/Folo"
readonly npm_cache_dir="/Volumes/SSD/Dev/Caches/npm"

# 外置磁盘在登录早期可能尚未挂载；launchd 会在失败后自动重试。
if [[ ! -f "${repo_dir}/package.json" ]]; then
  exit 75
fi

# launchd 不读取交互式配置，继续沿用本机现有的 SSD 缓存路径。
export NPM_CONFIG_CACHE="${npm_cache_dir}"

cd "${repo_dir}"
# 由项目 packageManager 选择版本，避免启动器与锁文件使用不同代际的 pnpm。
exec /opt/homebrew/bin/pnpm dev:web
