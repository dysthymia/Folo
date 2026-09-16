# P0 验证记录 — 2026-09-10

**状态：真实 Feed 的读取 → 模型 → SQLite → 同域生产页面链路通过；P0 整体验收仍待长期观察及覆盖边界验证，暂不进入 P1。**

页面：[local.folo.is/information](http://local.folo.is/information)。以下时间为北京时间。

## 本轮真实验证

| 项目       | 结论与证据                                                                                                                          | 限制                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 官方授权   | 9 月 10 日 sync 成功绑定真实账号，返回 94 Feed、1 List、1 inbox；每项任务重新读取凭据并核对账号                                     | 9 月 8 日旧会话 200/null 已正确识别失效；尚未做运行中强制失效再恢复的真实续抓                    |
| Feed       | MarsBit 首次 2 页、6 条详情；换成常驻进程后保留游标续至 4 页、12 条                                                                 | 详情接口 6 条样本均无正文/描述；官方 readability 对所选文章返回 5438 字符 HTML，清理后 4242 字符 |
| inbox      | 邮箱订阅读取 2 页、6 条，详情含邮件正文                                                                                             | 未调用模型处理邮箱；未验证所有历史邮件                                                           |
| List       | 项目方列表成员接口返回 0 个、complete=true；扫描返回空末页                                                                          | 只有空 List 样本，无法验收非空成员、文章详情和多页                                               |
| 真实模型   | MarsBit 的 Upbit 文章使用显式模型 gpt-5.6-luna，结构校验通过，摘要与 8 个要点落盘                                                   | gpt-5.4-mini 在当前 ChatGPT 登录下被上游明确拒绝；失败保留，没有自动备用模型                     |
| 指标       | 18,426ms；输入 13,587 tokens、输出 434、缓存 0；成功路径未发现工具事件                                                              | 单篇样本，不代表全量成本或完整工具隔离                                                           |
| 恢复与幂等 | Feed 游标从 2026-08-16T23:47:12.305Z 推进至 2026-08-16T06:01:04.373Z；重启后相同文章和模型成功复用结果，结果仍为 1 条且生成时间不变 | coverage=budget，不代表完整历史已覆盖                                                            |
| 生产 Web   | 真实账号 96 来源、1 条结果在同域页面渲染；服务重启后刷新仍显示；HTTP 200，使用独立生产产物                                          | 原阅读器仍为现有 Vite 服务，没有切换整个主站到生产版                                             |
| 常驻       | 已安装 is.folo.local.information LaunchAgent；内置磁盘运行独立构建，验证安装、更新及重启成功                                        | 用户登录级后台，注销/休眠不保证持续运行；未安装周期性扫描或模型任务                              |
| 48 小时    | 9 月 10 日 08:29 完成最后一次验证重启，可作为后续观察起点                                                                           | **尚未完成，不能把常驻进程存在等同于 48 小时通过**                                               |

真实数据保存在 `~/.local/share/folo-information-p0/information.sqlite`，没有混入隔离探针。模型结果 ID：`117bda0b34ebb6386396ef86a827d47d9c2344132c613321642d3689f4e6ee68`，生成时间 `2026-09-10T00:27:14.397Z`。

任务证据：Feed 扫描 `b4cee460-796e-44c9-920b-42decfe90b28`；List `2019fbe9-389b-4f3a-881c-e57b723d40fb`；inbox `b4520732-a007-4ded-9cae-e8be20ff2dac`；真实处理 `4f89dee0-ef36-413f-acde-3e9ef0804e13`；重启后幂等验证 `c897bfe1-9070-4ed5-8995-2e63006275c4`。此前材料缺失与模型不支持的失败任务保留作为诊断记录。

截图：`/tmp/folo-p0-evidence/real-source-after-restart.png`。日志：`~/Library/Logs/FoloInformation/service.log`、`service.error.log`（只记录固定错误分类，不记录认证或原始模型日志）。

## 实现与本轮根因修复

- 新包 `apps/information-service`：官方授权读取、三类来源、分页断点、SQLite 事务、显式模型和结构化输出、同源只读结果接口。结果页复用 UIKit 样式与三语文案。
- Feed/List 详情可能没有正文；处理时补充官方按条目 ID 的 readability 请求。正文请求失败明确报错；无正文但有描述时才标记 description_only；邮箱不请求网页正文。不会主动抓取任意外链。
- 原临时服务依赖终端会话，结束后域名返回 503。改为用户级 LaunchAgent 管理；首次常驻启动卡在外置目录的 Node getcwd/open，改为把完整单文件后台与 Web 构建安装到内置磁盘。
- LaunchAgent 更新时 bootout 返回并不保证旧进程已退出；安装器现在等待退出再注册，复测更新成功。运行中任务会阻止安装，避免主动中断模型调用。
- 结果工作台使用独立 production 入口，避免原阅读器 hydrateDatabaseToStore 阻塞。`/information` 和 `/information-static/` 由 Apache 转发到内部 2240，默认公开入口仍是 http://local.folo.is；连接票据不记访问日志。

此前已修复：SDK 在 JSON 顶层 null 上执行 `"code" in null` 的会话误判；页面事务提交前内存水位变化；HEAD 消耗连接票据；tsup 移除 node:sqlite 前缀；CLI 实验提示被误识别为工具事件。

## 验证与范围

- 本轮后台 TypeScript、ESLint、格式检查通过；受影响 service 17 项测试通过，包含正文补全、认证失败、邮箱边界、材料限制、幂等和扫描事务。
- 单文件后台构建通过（约 1.59MB），安装后真实执行与生产页面读取通过；Python 安装器实际安装和重复更新验证通过。
- 前轮后台 54 条 Vitest + 13 条真实子进程测试、Web 快照 9 项通过；后续同域 HTTP 14 项定向测试通过。本轮没有重跑无关全仓测试。
- 独立 Web 构建、入口严格类型检查和相关 Lint 前轮通过；本轮没有修改 Web 源码。
- renderer 整体类型检查仍有未改动文件诊断（前轮日志 57 行，主要 IPC/React 参数），不能声称全仓质量门禁通过。日志 `/tmp/folo-p0-ui-typecheck.log`。
- 工作区 `/Volumes/SSD/Dev/Code/Folo`，分支 `codex/web-actions-ai-v3`，基线 `91869135a066d932b26cb44814655a487b5e7014`；尚未提交或推送。原有未跟踪 `.pnpm-store/`、`scripts/local-folo/` 保留。
- 未实施规则设置、定时全量处理、Story、多账号服务或正式发布。

## 剩余通过条件

1. 非空 List 的成员、详情、多页真实样本。
2. 真实运行中授权失效后，恢复授权并从原水位补抓。
3. 上游时间戳密集边界、迟到条目、内容更新及历史保留范围的覆盖结论；当前仅有停滞/乱序检测及边界缺口标记。
4. 跨日、48 小时常驻和凭据生命周期观察。当前任务为手动入队，不能据此声称自动轮询已启用。

Codex 事件检测不是完整安全容器或事前阻止一切副作用的保证；超长材料报 needs_context，不静默截断。运行与更新方式见 [服务 README](../apps/information-service/README.md)。

## 主站登录复用修正 — 2026-09-10

- 信息工作台改为复用主站认证客户端，每次读取先生成一次性凭据，再经同源 POST 由后台向官方核验；不再要求 CLI 登录或 connect，不再信任旧工作台 Cookie。
- “已绑定”改为“当前 Folo 账号 / 已登录”。未登录显示主站登录入口；账号不一致或登录失效时清空已有结果。页面隐藏时清除快照，返回时重新核验。
- 后台凭据保存在数据目录的 web-credential.json（0600 原子写入），已有 CLI 配置不改动；后台每项任务优先读取此凭据。没有网页授权时才兼容旧 CLI 配置。
- 受影响后台 20 项 HTTP/授权测试、前端 15 项快照/会话测试通过；后台及独立入口严格类型检查、相关 Lint、两端构建通过。
- 本节替代此前一次性 connect → 8 小时本地 Cookie 的页面授权方案。常驻服务重新部署，48 小时观察应从本轮最终重启重新计时。

真实联调补充：使用已有账号向官方 generate 取得一次性凭据，通过同源 POST 验证新后台，返回 200、96 来源、1 结果，web-credential.json 为 0600。此探针使用 Node，不能算浏览器成功登录证据。Chrome 的 HTTP 认证请求被 InvalidLocalNetworkAccess 阻止；尝试现有 HTTPS 时遇到 NET::ERR_CERT_AUTHORITY_INVALID，未绕过警告，并撤回强制 HTTPS 跳转。内置浏览器返回主站未登录提示，正确隐藏旧结果；需要该浏览器自身完成主站登录才能验收已登录页面。保留原 HTTP 入口，未修改浏览器安全设置或证书信任。

安装器增加启动就绪检查：页面实际返回 200 后才报告安装成功，避免 launchctl 异步启动瞬间把 503 当作部署完成。

## 千问模型与独立 Codex profile — 2026-09-10 晚

信息工作台及 `local.folo.is` 原有 AI 聊天共用后台模型设置，当前 provider=`qianwen`、model=`qwen3.8-flash`。执行框架保持 Codex CLI 0.151.0；每次运行创建独立 `CODEX_HOME` 和 `folo.config.toml`，使用 `--profile folo`。不会写入用户 Codex 配置、客户端模型或全局环境变量。

- 模型设置位于 `/information#model-settings`，支持 provider、模型 ID 和 Key 输入；POST 读取元信息、PUT 保存，均需主站新 OTT 和同源 Origin。真实账号接口返回 200，保存空 Key 后原私有 Key 保留；响应只有 `provider/model/hasApiKey`。
- Key 仅存 `~/.local/share/folo-information-p0/ai-config.json`（0600），按次注入 CLI 子进程环境。专用 profile 和模型目录不含 Key，退出后清理临时目录；未修改 `~/.codex/config.toml` 或账号认证。
- 真实 CLI 连通性探针：`qwen3.8-flash` 返回有效 JSON，约 3.2 秒、3072 输入 / 41 输出 tokens、0 工具事件。
- 常驻服务真实摘要任务 `9a13512d-985f-4288-98cd-1c0212567f8b` 成功；结果 `bc978e50926931ef29f72df887860c18afd2d4d29bb623cd63e1055386a62932`，2026-09-10 21:50:32 保存，source_text，14139ms，输入5923、输出812、缓存1024 tokens。旧 gpt-5.6-luna 结果保持原记录。
- 实际摘要暴露了 Responses 兼容差异：千问未按 CLI 的 text.format 强制输出，曾返回 Markdown 围栏和多余字段。现将完整 Schema 写入专用模型系统指令，同时保留原严格解析/校验，未用剥围栏或删字段掩盖错误。无自动重试或备用模型。
- 自定义模型目录的 shell_type=`default` 在当前 CLI 中是 unified_exec 别名；现明确设为 `disabled`，并保留原工具事件检查。早期失败任务保留，最终常驻执行成功；事件监控仍不能作为完整独立安全容器的证明。
- 原聊天保留对话和用户 Markdown，当前文章从官方接口补全文本；时间线取样最多4个来源、各5篇，并在提示中明确覆盖范围。本轮没有附件解析和联网工具。CLI JSON 校验成功后一次性通过 AI SDK SSE 返回正文；开始/结束/标题事件与客户端兼容，浏览器断连取消 CLI。当前响应不是逐 token 展示。
- 本地聊天不请求官方模型菜单、套餐额度配置，也不把官方已选模型覆盖后台设置；其他 hostname 路径维持原行为。SSE 模型元信息映射为原 UI 的 modelUsed 字段。
- 真实同源 HTTP 聊天（经官方账号生成 OTT）返回200，完整 start → text → title → finish 事件，识别前文测试词，确认服务使用后台 qwen3.8-flash 而非客户端提交的模型字段。
- 定向检查：后台严格 TypeScript / ESLint，独立工作台 TypeScript / ESLint、两端构建通过。前端相关14项测试通过。后台72项 Vitest（含配置隐私、聊天上下文、真实HTTP设置/SSE/断连取消）以及14项真实子进程测试；没有运行无关全仓门禁。
- 更新已安装的用户级 LaunchAgent，生产入口仍为 `http://local.folo.is/information`。内置浏览器真实页面当前显示未登录，隐藏数据及设置；上述真实账号联调使用 Node，不能替代已登录浏览器端到端验收。未绕过认证或改变证书信任。

配置格式参考：[Codex profiles](https://developers.openai.com/codex/config-advanced/#profiles)、[千问 Responses API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)。

最终复测：重复摘要任务 `852c852b-fe59-4356-895c-5fea8716cbc5` 成功复用结果，千问结果仍为1条，生成时间未变。最终部署的 HTTP 聊天耗时6073ms，返回前文测试词“青松”，完成事件 model=`qwen3.8-flash`；设置读取/保存均200。最终后台72项 Vitest +14项子进程测试全部通过。本地官方配置隔离同时排除 TanStack Query 已存在的缓存，避免 enabled=false 仍读到旧套餐配额。
