# Local Folo runtime

This directory keeps `http://local.folo.is` available after macOS restarts.

- `is.folo.local.proxy` checks every 600 seconds that Docker is responsive, the Apache container has persistent Folo virtual-host mounts, the installed production backend responds on port 2240, and the main page is reachable through `local.folo.is`. A Docker probe is limited to 15 seconds. If proxy health fails after the Docker services process accumulates at least 50,000 open files, it restarts the existing high-file-limit Docker LaunchAgent and restores the container immediately; otherwise it only restarts the proxy container.
- `is.folo.local.information` serves the installed production main page, information page and backend APIs from the internal disk. Builds are installed with `apps/information-service/scripts/install-launch-agent.py`; the domain no longer depends on Vite.
- `is.folo.local.dev-web` is an optional development stack; it starts the pinned `pnpm@10.17.0` web/SSR development stack and restarts it if it exits.

The LaunchAgents are installed in `~/Library/LaunchAgents`, while executable copies live in `~/Library/Application Support/FoloLocal` so macOS can start them before the external workspace is ready. Runtime logs are written to `/tmp/folo-local-proxy*.log` and `/tmp/folo-dev-web*.log`.

To disable both services:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/is.folo.local.proxy.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/is.folo.local.dev-web.plist
```

## 生产更新与回退

先构建主站 `pnpm --filter Folo exec cross-env WEB_BUILD=1 vite build`，再构建信息页和服务。使用 `backup-information-db.ts` 备份业务数据库后运行安装脚本。安装器拒绝切换正在执行的扫描或模型任务，保留上一份部署产物；模型配置和主站授权仍使用数据目录中的私有文件。

主站根路径及 `/information` 都由 2240 的生产服务响应。开发时可以运行 2233，但不会自动替换域名上的生产版本。原开发代理配置可恢复到 `ProxyPass / http://host.docker.internal:2233/`，经 Apache 配置校验后平滑重载；不要重建业务库或重置 Codex 模型配置。
