#!/bin/zsh

set -euo pipefail

readonly repo_dir="/Volumes/SSD/Dev/Code/Folo"

# 外置磁盘在登录早期可能尚未挂载；launchd 会在失败后自动重试。
if [[ ! -f "${repo_dir}/package.json" ]]; then
  exit 75
fi

cd "${repo_dir}"
exec /opt/homebrew/bin/npx --yes pnpm@10.17.0 dev:web
