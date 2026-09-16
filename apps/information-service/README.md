# Folo Information Service

独立 Node 后台：复用主站登录授权、保存来源和分页进度、通过 Codex CLI 调用后台配置的模型，将结果交给 Folo 的生产 Web `/information` 页面。当前已接入规则编辑、发布、处理计划与 Story；完整 v3.1 的真实验收仍以台账为准。

早期 P0 实测见 [P0 验证记录](../../docs/information-p0-verification.md)。真实 Feed 已跑通读取、模型处理、落盘和同域展示；长期观察及分页覆盖边界仍待验收。

v3.1 的完整开发范围和逐项状态见 [开发与验收台账](../../docs/information-v3.1-progress.md)。新增规则核心和 `/information/v1/` 草稿/发布/预览 API 已有定向测试，尚未部署，也尚未连接规则执行 worker 或现有 Actions 编辑器；不能将这些接口视为完整自动化功能。

## 运行

需要 Node >=24.5（本机已测26.8.1）、pnpm、Codex CLI >=0.134，以及当前浏览器中的 Folo 主站登录；千问模式使用独立 API Key，OpenAI 模式才需要 Codex 登录。命令从仓库根目录执行。

```sh
pnpm install --frozen-lockfile
pnpm --filter @follow/information-service build
pnpm --filter @follow/information-service build:web

# 推荐：安装或更新 macOS 登录后常驻服务（等待当前任务结束再执行）。
python3 apps/information-service/scripts/install-launch-agent.py

# 临时调试可使用 serve；不要与已安装的常驻 worker 同时运行。
# pnpm --filter @follow/information-service start serve

# 在已登录 Folo 的浏览器打开 http://local.folo.is/information，无需 connect。
```

打开工作台时，页面沿用主站的认证客户端生成一次性凭据；同源 POST 交给后台，后台通过官方 apply 接口和 get-session 核验账号后返回快照。没有另一套工作台登录或绑定操作。未登录时提供主站登录入口；账号不符时不显示已有数据；返回页面和刷新时重新核验。

后台凭据原子保存在 `~/.local/share/folo-information-p0/web-credential.json`（0600），不写入页面、日志或业务快照，也不改写 `~/.folo/config.json`。每项后台任务优先读取网页授权；旧安装尚无网页授权时才兼容 CLI 配置。网页授权失效后不会悄悄回退到另一个账号，重新打开已登录的工作台即可更新。

`connect` 命令仅保留打开工作台的兼容入口，不签发本地会话。旧 `/information/connect` 返回 410，旧 Cookie 不再授权；快照接口只接受同源 POST 和新的一次性凭据。服务仍仅监听127.0.0.1:2240，Apache 代理 `/information` 与 `/information-static/`，主站页面也由同域生产构建提供。

## 扫描与处理

```sh
# 使用 sync 返回的真实来源 key，支持 feed/、list/、inbox/。
pnpm --filter @follow/information-service start scan --source 'feed/<id>' --limit 5 --pages 3
pnpm --filter @follow/information-service start status
pnpm --filter @follow/information-service start items

# 可在 status / 结果快照中查看任务；单次 worker 适合调试恢复。
pnpm --filter @follow/information-service start run-once

# 使用 Folo 后台保存的 provider/model；也可用 --model 覆盖本条任务的模型。
pnpm --filter @follow/information-service start process --source 'feed/<id>' --entry '<entry-id>'

# 继续预算暂停或失败的扫描，保留已经落盘的游标。
pnpm --filter @follow/information-service start resume --job '<scan-job-id>'

# 验证已订阅列表的成员与完整性。
pnpm --filter @follow/information-service start members --source 'list/<id>'
```

`scan` / `process` 只入队；`serve` 或 `run-once` 执行队列，二者不能同时作为 worker。扫描默认3页、每页5条并取详情，不代表历史全量完成。`status` 返回最近100项任务；Web最多展示最近200条输入和100条结果。分页字段 `coverage` 区分 `pending`、`budget`、`end`、`timestamp_boundary`，`succeeded` 只代表本次作业正常结束。

现有上游分页用 `publishedAfter` 表示继续读取更早条目。没有可验证的 ID 次序游标，时间戳密集边界、API保留范围、迟到条目和更新覆盖都必须实测；不能把短页当作全部历史已覆盖的证明。适配器在游标不前进或页面逆序时失败并保留断点。检测到多条相同边界时间时保留覆盖缺口标记，不使用减1毫秒跳过数据。

页面详情与水位在同一 SQLite 事务提交；事务回滚时内存水位也不前进。进程重启后扫描恢复排队，运行中的模型任务标为 `interrupted_model_outcome_unknown`，不自动重复调用。对相同账号、来源、条目、正文、标题、材料类型、模型与 Prompt 版本，成功结果幂等复用。需重试失败的模型任务时明确重新入队。

`source_text` 表示上游提供的正文，不保证是外站文章全文。Feed/List 详情没有有效正文时，按条目 ID 请求 Folo 官方 readability 接口；仍没有正文才处理描述并标记 `description_only`。正文接口认证或网络错误显式失败；邮箱只使用邮件自身材料。没有材料报 `material_missing`；超过60000字符报 `needs_context`，不静默截断。P0不主动抓取任意外部URL，不修改官方条目阅读状态。

## Folo AI 模型设置

打开 [模型设置](http://local.folo.is/information#model-settings)，填写 provider、模型 ID 和 API Key。当前已配置 `qwen3.8-flash`。信息工作台新处理任务及 `local.folo.is` 原有 AI 聊天共用此设置；其他部署的聊天仍走原官方接口。新处理目标开始时固定 provider/model，旧结果保持原模型记录。

**执行框架始终是 Codex CLI。** 千问调用使用任务专用 `CODEX_HOME` 和 `folo.config.toml`，通过 `codex exec --profile folo` 请求每任务独立的回环 Responses 桥。桥将 Codex 的 `text.format` 转换为千问 Chat Completions 的 `response_format.json_schema`（严格模式），固定请求 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` 并关闭 thinking；这样避免千问 Responses 忽略格式约束。模型能力目录和实际输出 Schema 保留在专用目录，最终仍严格验证 JSON、业务结构与原文引用。桥仅接受纯文本输入，不向上游转发工具声明，拒绝实际工具调用；失败不自动换模型或重复付费调用。

单篇与长文的模型输出只选择本次请求中的原文证据编号，服务端据此还原连续原文引文；Story 聚合和修复按候选条目与事实编号交叉校验引用。未知编号与模型自由输出的 quote 均被拒绝，映射后仍保留原有引用和展示策略校验。编号保证引用出自原文，不代表摘要或事实表述已经完成人工语义验收。已保存的决策格式不变，新 Prompt 版本隔离待处理任务的缓存。

密钥只存数据目录 `ai-config.json`（0600），运行时由父进程中的桥持有；Codex 子进程仅获得一次性回环令牌 `FOLO_QIANWEN_PROXY_TOKEN`，不会获得真实千问 Key。profile、命令行、浏览器响应、日志和数据库不含真实 Key。任务完成后关闭回环端口并删除专用目录。不会修改 `~/.codex/config.toml`、客户端模型选择或全局环境变量。设置中的空密码表示保留已有 Key。

接口均要求同源请求及新的主站 OTT：`POST /information/api/settings` 读取元信息，`PUT` 保存；`POST /information/api/chat` 接收 AI SDK UIMessage。聊天读取用户的富文本 Markdown 和历史对话，当前文章通过 Folo 官方接口补全，时间线最多取 4 个来源各 5 篇并告知覆盖范围；本轮没有接入附件解析和联网工具。CLI 完成并校验后通过 UIMessage SSE 返回正文，等待期间显示进行中，关闭连接会取消 CLI 子进程。

## 配置与数据

| 环境变量                         | 默认值                                      |
| -------------------------------- | ------------------------------------------- |
| `FOLO_INFORMATION_DATA_DIR`      | `~/.local/share/folo-information-p0`        |
| `FOLO_INFORMATION_CLI_CONFIG`    | `~/.folo/config.json`                       |
| `FOLO_INFORMATION_PUBLIC_ORIGIN` | `http://local.folo.is`                      |
| `FOLO_INFORMATION_PORT`          | `2240`                                      |
| `FOLO_INFORMATION_WEB_ROOT`      | 包目录下的 `../desktop/out/information-web` |

SQLite文件权限0600，初建目录0700，使用WAL。服务错误仅打印固定分类，不输出SDK异常正文或Codex原始日志。Codex调用使用独立临时目录、stdin输入、结构化输出和运行时校验，关闭Web搜索并配置工具限制，检测到工具事件立即中止。该限制**不是独立安全容器**：CLI 0.151.0对 `unified_exec=false` 的实际行为有限制，不能把事件检测称为事前阻止全部副作用的保证。

网络沿用进程中的代理变量；本机 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 为已有配置，启动脚本启用 Node 的环境代理支持，不修改全局设置。官方 API origin 当前限定为 `https://api.folo.is`。

## 定向检查

```sh
pnpm --filter @follow/information-service typecheck
pnpm --filter @follow/information-service lint
pnpm --filter @follow/information-service format:check
pnpm --filter @follow/information-service test
pnpm --filter @follow/information-service build
pnpm --filter @follow/information-service build:web
```

Folo读取、SQLite恢复、服务授权测试使用可控测试数据；Codex适配器使用真实子进程的假CLI测试取消和异常退出。离线测试不能替代目标账号的真实权限与分页验收。

## local.folo.is 反向代理

本机已在 `output/local-folo.conf` 的虚拟主机中将以下规则置于现有根路径代理之前，并通过 Apache 配置检查与平滑重载。该文件属于本机运行配置，未纳入 Git。

```apache
# 信息工作台及生产静态资源使用同一站点域名。
ProxyPass /information-static/ http://host.docker.internal:2240/information-static/
ProxyPassReverse /information-static/ http://host.docker.internal:2240/information-static/
ProxyPass /information http://host.docker.internal:2240/information
ProxyPassReverse /information http://host.docker.internal:2240/information
```

保留 `ProxyPreserveHost On`。访问日志使用 `SetEnvIf Request_URI "^/information/connect$" folo_information_connect`，并在原 `CustomLog` 后添加 `env=!folo_information_connect`，使一次性连接票据不进入访问日志。

`build:web` 复用桌面 Vite 配置、页面组件和UIKit样式，独立入口为 `information-main.tsx`，静态资源基路径为 `/information-static/`。它仅初始化页面翻译和后台读接口，不等待阅读器数据库的初始化或账号同步；避免同域打开时被阅读器初始化阻塞。

## macOS 常驻部署

安装器将已构建的单文件后台和 Web 产物复制到 `~/Library/Application Support/FoloLocal/information-runtime`，由 `is.folo.local.information` LaunchAgent 管理。旧产物保留在相邻的 `information-runtime-previous`；数据库仍在原数据目录。后台不依赖外置工作区挂载，修改源码后须重新 build、build:web（涉及 UI 时）并运行安装器。

日志：`~/Library/Logs/FoloInformation/service.log` 和 `service.error.log`。这是登录用户级常驻，退出账号或休眠时不保证继续工作；安装器不自行创建规则或启用计划；服务会执行用户已保存、发布并启用的处理计划。安装器只继承已有代理及运行目录，不复制认证密钥。千问模式由每次运行的独立 profile 提供配置；OpenAI 模式保留本机 Codex 登录，没有自动备用模型。

```sh
# 检查服务；停止时只卸载此服务，保留部署产物和数据库。
launchctl print "gui/$(id -u)/is.folo.local.information"
launchctl bootout "gui/$(id -u)/is.folo.local.information"
```
