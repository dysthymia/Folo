# Folo AI 处理 · v3.2 开发输入

**用途**：把外部评审（`~/Downloads/区块链投资&交易 - 改造交易系统-round-2.md`）的方向性意见，与对源码的逐条核查结果合并，转成下一轮可直接施工的输入。不是新计划书，不扩功能。
**基准提交**：`codex/web-actions-ai-v3` @ `32c2c8c3c`（评审所依据的同一提交）。
**证据边界**：静态源码核对 + 只读健康探测（`local.folo.is`、`127.0.0.1:2240`、`127.0.0.1:2233`）。~~**未运行测试套件、未做真机交互验证**。~~ 这是**首版**的边界；后续各轮已补齐测试套件与真机交互证据，实际证据见 §9–§12。凡涉及部署状态与语义质量的结论，只引用 `docs/information-v3.1-progress.md` 与 `docs/information-runtime-status.json`。

---

## 0. 结论

- 评审方向可用：**自动化负责配置，时间线负责阅读，后台负责执行**。五项收敛的优先级排序合理，本轮不应再加功能。
- 直接照它开工前必须补三件事：一条架构决策（§2 D1）、一张能力矩阵（§2 D2）、一套可判定验收标准（§6）。
- **§2 的 D1–D5 已全部决议**（D5 于 2026-09-21 早先决议，D2/D3/D4 于同日补齐）。本轮按 §7 施工到第三轮，出口是 §6 三场景验收；**未验收 ≠ 可删除**，台账 U01–U14 仍需单独确认。
- 评审有三处需要修正（§3），另有一处会改变施工方案的遗漏（§1.2）。
- **未验收 ≠ 可删除**。台账 U01–U14 全为"未验收"，这既不构成功能失效，也不构成重写许可。
- **当前状态（2026-09-25 18:00）**：§6 三个场景的判据已逐条标注通过／部分通过／无数据前提（见 §6 本身）。场景一、场景三全部通过；场景二通过（例外与"已读不影响原文"两条无数据前提或未验收）。本轮另修掉两个真实回归（`/inputs` 的 `skipped` 枚举、`/action` 的 4 处 i18n raw key），均已在真机上复核，见 §11。仍明确**未验收**的：隐藏条目的处理理由文本与就地恢复入口、"相反表述"抽查、Story 已读对原文 read 的影响。

---

## 1. 已核实的事实

### 1.1 评审主张逐条核对

| #   | 评审主张                                    | 源码位置                                                                                                                            | 判定 |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 三套规则执行位置，处理服务复用入口但不统一  | `modules/action/action-setting.tsx:92-157`（`122-131` 挂 `ProcessingSetting` 并跳过旧查询与保存）                                   | ✅   |
| 2   | 智能阅读是跳转到另一个页面                  | `modules/information/reading-mode-link.ts:12-14`；`ProcessingReadingModeSwitch.tsx:16-31` 用 `<a>`                                  | ✅   |
| 3   | 智能阅读不继承当前分类／订阅／视图          | `/reading-snapshot` POST 只收 `snapshotId/offset/limit/view`：`information-service/src/processing-api.ts:256-272`                   | ✅   |
| 4   | 跨篇整合必须是显式 `ai_aggregate`           | `information-service/src/story-engine.ts:127-134`                                                                                   | ✅   |
| 5   | 聚合还要单独填模式、范围、创建／更新 Prompt | `modules/action/processing-client.ts:165-180`；新建时 `scope:{all:true}`、`createPrompt:""`：`processing-action-editor.tsx:222-240` | ✅   |
| 6   | "立即运行"被四重条件锁住                    | `modules/action/processing-setting.tsx:90-98`                                                                                       | ✅   |
| 7   | "全选来源"是当时的名单快照                  | `modules/action/processing-run-settings.tsx:210-218`                                                                                | ✅   |
| 8   | 切标签丢阅读状态                            | `InformationPage.tsx:76-91`；`ProcessingReader.tsx:148-169`（161 行回到偏移 0）                                                     | ✅   |
| 9   | 验收未覆盖用户最在意的场景                  | `information-v3.1-progress.md` U01–U14 全"未验收"，用户确认语义样本 0                                                               | ✅   |

补充事实（评审未提但影响判断）：

- 原文在新标签打开：`ProcessingReader.tsx:335-336`。
- 工作台同时渲染两套结果：`InformationPage.tsx:172`（ProcessingReader）与 `294`（`snapshot.results`，即单篇 AI 摘要列表，见 `modules/information/snapshot.ts:40-51`）。
- 处理服务相关入口全部受 `isLocalFoloHost()` 门控：`action-setting.tsx:152-154`、`entry-column/layouts/EntryListHeader.tsx:168`；后台为 LaunchAgent `is.folo.local.information`。
- 时间线头部**已有**智能阅读入口（`EntryListHeader.tsx:168`）。因此问题不是"找不到入口"，而是两个入口通向**不同范围口径**（见 §3.1）。

### 1.2 评审遗漏：时间线里已经有一套 AI 处理链路

| 事实                 | 证据                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 客户端语义去重实现   | `packages/internal/store/src/modules/entry/semantic-dedupe.ts`（887 行；阈值 0.85 在 11 行）                           |
| 仅对部分分类生效     | 同文件:19 `SEMANTIC_DEDUPE_ALLOWED_CATEGORIES = {ai, blockchain, internet, 互联网}`                                    |
| 它在时间线里过滤条目 | `modules/entry-column/hooks/useEntriesByView.ts:277-288`（`role !== "duplicate"` 才保留）                              |
| 它有整合角标         | `modules/entry-column/semantic-duplicate-badge.tsx`、`EntryItemWrapper.tsx:210`                                        |
| 它的开关在 AI 设置里 | `modules/settings/tabs/ai/SemanticDedupeSection.tsx`；默认开启 `packages/internal/shared/src/settings/defaults.ts:168` |
| 该文件不在上游 `dev` | `git cat-file -e dev:...semantic-dedupe.ts` → 不存在（来自 `yangtao-dev`／本分支自研）                                 |

**这直接对应你要的"重复内容被整合"**，但它：

1. 配置入口在 AI 设置，不在自动化 → 同一件事现在有 **4 个配置面**：自动化、信息工作台、AI 设置、AI 聊天；
2. 与后台 `story-engine` 是两套并行实现，互不知情；
3. **在你实际使用的页面上是空转**。评估器只在 Electron 或 DEV 下注册（`providers/semantic-dedupe-provider.tsx:237-277`；Electron 侧实现见 `apps/desktop/layer/main/src/ipc/services/semantic-dedupe.ts:20-24`）。只读探测：`local.folo.is` 与 `127.0.0.1:2240` 响应不含 Vite 客户端（生产构建），`127.0.0.1:2233` 含；`local.folo.is/__semantic-dedupe/evaluate` 返回 405。

> 推论（待真机确认）：在 `local.folo.is` 这个生产构建页面上，语义去重评估器为 `null`，列表不做去重；开关显示"已开启"但无效果。Electron 桌面端才会真正执行。
> 含义：**"AI 处理后"视图一旦接入，必须先把两套链路的关系定下来，否则会接出第三条。**

---

## 2. 施工前必须钉死的决策

### D1 「AI 处理后」视图的数据路径（唯一需要先定的架构决策）

评审要求"把智能结果接回原时间线并贯通筛选"，但未给路径。现状是：时间线条目来自本地库与订阅同步，处理结论在服务独立库里；已有两种可复用的先例：

| 方案                          | 做法                                                                                                                                               | 代价                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **A. 复用读态机制**           | 沿用处理服务的"隐藏"→ 标记已读，借 Folo 现成的未读过滤（`entry/hooks.ts:191-194`、`entry/store.ts:276-287` 的 `if (unreadOnly && read) continue`） | 改动最小；但只能隐藏，**承载不了 Story 这类新条目类型**，且会与已定下的"Story 已读与原文 read 分开维护"冲突    |
| **B. 复用时间线的角色过滤点** | 把服务端决策映射到 `useEntriesByView.ts:277-288` 的同一过滤点与角标位（`EntryItemWrapper.tsx:210`），由一个统一来源提供 `role`                     | 与现有语义去重同构、改动集中在客户端；需解决状态持久化归属（现为 `localStorage`：`follow:semantic-dedupe:v1`） |
| **C. 引入第二数据源**         | 条目列在渲染层合并"处理结果"与"原始条目"两个流                                                                                                     | 能原生承载 Story；但必须定义合并分页、排序、快照稳定性、离线行为，工作量最大                                   |

**建议：选 B**，把 `semantic-dedupe` 的角色过滤点抽象为通用的"条目处理角色"（落点见 D5 的角色层模块），由处理服务做决策源。理由：与现有实现同构、能承载 Story 角标语义、且不必先发明一套跨库合并分页规则。C 只在 B 被证否（如 Story 需要独立正文区）时启用。

### D2 本地部署边界能力矩阵（2026-09-21 已决议）

**决议：合并为一处配置面，执行位置降级为规则详情内的标识；能力边界在界面内常驻说明，不靠隐藏。**

- 官方 `cloud` / `local` 规则与新规则**同列在一个列表**里，规则详情显示执行位置标识（`cloud` / `local` / `processing_service`）；编辑任何规则都不需要先选执行位置。
- **处理服务不可用时**（非 `local.folo.is`，或 2240 不可达）：规则仍可查看与编辑，但 `processing_service` 规则的启用与「立即运行」不可用，并在该规则详情内写明原因与前提。不用灰按钮代替解释，也不隐藏入口。
- **Electron 与浏览器能力差**：受 `isLocalFoloHost()` 门控，Electron 下处理服务入口不可见、本地兜底去重可用；浏览器开 `local.folo.is` 时相反。两处各有一条常驻说明（不是 tooltip）：自动化页顶部一条讲执行位置可用性，AI 设置里一条讲本地执行器可用性。

### D3 「原始内容可恢复查看」的机制（2026-09-21 已决议）

**决议：条目级 restore 覆盖 + 时间线就地视图切换，两者都做，缺一不满足「可恢复」。**

- **时间线就地切换**：头部新增「AI 处理后 / 原始内容」两态切换，**不再跳转**信息工作台。切到「原始内容」时，该视图内被隐藏与被并入的条目全部恢复显示、计数随之恢复（对应 §6 场景一判据）。
- **条目级恢复**：沿用 `processing_entry_overrides` 的 `restore`，并把豁免范围从「仅隐藏」扩展到「隐藏 + 并入」——这正是 §9 记录为已知缺陷的那条。恢复后该条目在「AI 处理后」视图里单独可见，并标注「已手动恢复」。
- 不引入第二套口径：`restore` 只影响角色投影，**不改原文 read 状态**（§5.2）。

### D4 运行范围的动态语义（2026-09-21 已决议）

**决议：范围三态，落库只存描述符；只有固定名单保存名单快照。**

| 范围     | 落库形态                               | 新增来源                                                   |
| -------- | -------------------------------------- | ---------------------------------------------------------- |
| 全部订阅 | `{ mode: "all" }`                      | 自动纳入                                                   |
| 当前分类 | `{ mode: "category", view, category }` | 该分类下的新来源自动纳入                                   |
| 固定名单 | `{ mode: "fixed", sourceKeys: [...] }` | **不**自动纳入，界面上标明「固定名单，不会自动纳入新来源」 |

三种范围共用同一份解析（发布目标计算与运行范围读取不再各写一遍），避免出现「全局说明不覆盖后来新增的订阅」。当前把「全选」落库为当时 `sourceKeys`（`processing-run-settings.tsx:214`）的做法废弃。

### D5 语义去重与 Story 的整合（评审未提及，2026-09-21 已决议）

**决议：不合并两套引擎，也不让它们各自直连 UI；把"条目在时间线里的处理角色"抽成唯一出口，两套引擎都只作为角色来源。**

分工维持不变，各自回答不同问题：

| 引擎           | 回答的问题                     | 执行位置           | 决策粒度              |
| -------------- | ------------------------------ | ------------------ | --------------------- |
| 客户端语义去重 | 这条和那条是同一件事吗？       | 客户端（Electron） | 成对（keeper + 重复） |
| 处理服务 Story | 这几条该合成一篇什么样的综述？ | 本机后台           | 跨来源、按规则        |

整合点有三处，缺一不可：

1. **角色层（新增，唯一出口）**：`packages/internal/store/src/modules/entry/processing-role.ts`。
   统一角色为 `hidden | keeper | story`；来源为 `service | local-dedupe`，**优先级 service > local-dedupe**
   （服务端按规则决策且持久，本地去重是即时近似；服务端没覆盖到的条目才落回本地去重）。
2. **消费层（收敛为一份）**：
   - 时间线过滤：`modules/entry-column/hooks/useEntriesByView.ts:277-288` 改为读角色层，不再直接读去重 store；
   - 条目角标：`modules/entry-column/semantic-duplicate-badge.tsx` 的数据源改为角色层的"合并来源"，
     现有的三个挂载点（`all-item.tsx:209`、`list-item-template.tsx:203`、`grid-item-template.tsx:121`）不动；
   - 条目解释：与 `ProcessingEntryExplanation` 共用同一份理由字段。
3. **配置层（收敛 4 → 2）**：去重不再是"AI 设置里的另一个开关"，而是处理服务规则下的一种处理方式；
   AI 设置里保留的开关只作为**本地兜底执行器的启停**，并在界面上说明它受执行环境限制。

**必须一并处理的两个已知缺陷**（否则整合只搬了位置）：

- **分类白名单是硬编码的**：`semantic-dedupe.ts:19` 限定 `ai / blockchain / internet / 互联网`。
  处理服务是按规则工作的，硬编码类别正是本轮要消灭的"隐藏行为"。迁移项：改为规则决定，或在角色层显式标注"仅本地去重覆盖"。
- **在浏览器页面空转**：评估器只在 Electron 或 DEV 下注册（`providers/semantic-dedupe-provider.tsx:237-277`）。
  执行位置降级后，浏览器端必须能看到"当前没有本地执行器"，而不是开关显示已开启却无效果。

**迁移顺序**：角色层落地（本轮，行为不变）→ 处理服务决策接入角色层（第二轮，P0-1）→
去重开关迁入处理服务配置（第三轮）。**不做 D5，P0-1 必然接出第三条链路。**

---

## 3. 对评审的三处修正

**3.1 "必须穿过信息工作台才能找到智能阅读"——偏重。**
时间线头部已有入口（`EntryListHeader.tsx:168`）。真实症结是**同一份数据的两个范围口径**：时间线按分类／订阅／视图，智能页按计划的 `sourceKeys + historySince`（`processing-reading-store.ts:556-560`）。另外，评审"没有把你当前的分类解析成筛选条件"这句准确，但容易被读成"完全没有范围"，应表述为"范围口径不同"。

**3.2 P0 第一项缺数据路径。** 见 §2 D1。这是评审里唯一没有落到可实现层面的关键项。

**3.3 "预设自动生成聚合配置"的落点要改。**
`ai_aggregate` 自带 `scope: conditionSet`，与规则 `when` 重复；`createPrompt` 有 `min(1)` 校验而新建时为空串。正确落点是**让 `scope` 默认继承规则条件、界面折叠为一句"使用本条规则范围"**，而不是再加一层预设概念——否则等于多教用户一个词。

---

## 4. 五项收敛的落点

| 优先级 | 改动                                       | 施工落点                                                                                                                                                                          |
| ------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | 统一自动化入口，执行位置降为详情           | `action-setting.tsx:92-157`：以规则列表为主界面，`cloud/local/processing_service` 改为规则详情内的标识；`processing_service` 分支不再独占一套编辑体验（`122-131`）                |
| **P0** | 简化 AI 动作                               | `processing-action-editor.tsx:222-240` 的"添加聚合"改为预设入口；`scope` 默认继承 `when` 并折叠（§3.3）；`createPrompt/updatePrompt` 由预设注入而不是要用户各填一遍               |
| **P0** | 智能结果接回时间线，贯通分类／订阅／视图   | 走 D1 方案 B：统一 `useEntriesByView.ts:277-288` 的角色过滤点；Story 作为新条目类型在**渲染层**扩展（角标位 `EntryItemWrapper.tsx:210`），不新建阅读器                            |
| **P1** | "保存并启用"一体化；计划范围支持动态范围   | `processing-setting.tsx:85-98` 收敛为单主按钮 + 可勾选"重新处理近期内容"；门槛（`92-98`）降为高级功能；范围三态见 D4                                                              |
| **P1** | 修复切标签状态丢失；清理重复结果与运维面板 | `InformationPage.tsx:76-91` 改为回页时**核验账号**而非无条件清空；`ProcessingReader.tsx:148-169` 保留页码／滚动／所选；`InformationPage.tsx:294` 的 `snapshot.results` 撤出主路径 |

---

## 5. 回归红线（不得为了简化而破坏）

1. **快照稳定性**：阅读基于固定快照，刷新需显式触发，不在阅读中跳位。
2. **Story 已读与原文 read 分开维护**，不默认批量改动原文状态。
3. **引用校验不放松**：连续原文校验、身份与策略校验、失败分类不合并。
4. **发布／草稿版本语义**：历史发布只读，复制为草稿后才可再发布。
5. **旧 local 规则迁移守卫**：仅在新规则发布成功且旧规则身份未变时才停用旧规则。
6. **未验收项不得当作已删除**：台账 U01–U14 的处理需单独确认，不随界面收敛一起消失。

---

## 6. 可判定验收标准

只用原有三个场景验收，每项给出判据与不通过判据。

**场景一 · 社交媒体过滤**

- [x] 配置侧：自动化主界面只有"条件／处理方式／启停"，无需选择执行位置即可保存启用。
- [x] 阅读侧：在时间线该社交视图的"AI 处理后"中，短帖与娱乐内容为 0；切到"原始内容"同一范围**条目集与角色分布恢复**。
  - **判据口径已修正**：原文写的是"计数恢复"，但时间线头部不显示总数（见 §11.2 末尾的纠正）。可判定的等价判据是条目集与角色分布：`221 / hidden 0` → `231 / hidden 6`。
- [-] 可追溯：被隐藏条目仍能在条目详情看到原文与处理理由（含命中规则）。
  - **部分通过**：结论标识可追溯（`aria-label="AI 已隐藏"`，§11.2）；**处理理由文本未在时间线展示、悬停卡为空、且没有就地恢复入口**——这三项如实记为未验收。
- 不通过：需要用户到计划里重复选一次来源；或隐藏只能靠"标记全部已读"且无法恢复未读。

**场景二 · Blockchain 同事件综述**

- [x] 在 Blockchain 分类列表**内**直接看到整合条目，不跳页；条目显示来源数 ≥2、句段引用、更新时间。
- [ ] 项目方公告类订阅的条目仍单独可见（例外生效）。**无数据前提可判**：58 条 `standalone='always'` 全是 `needs_context`（证据不足），没有一条真正的"项目方公告"，见 §11.5。
- [-] 正文保留分歧：可抽查 ≥2 个来源的相反表述，引用通过连续原文校验。**部分通过**：digest 面板渲染出 5 条句段引用、`sourceCount=2`；"相反表述"这一抽查未做。
- [ ] 对该 Story 标记已读后，原文 read 状态不变（对应 §5.2）。**未验收**。
- 不通过：整合结果只能在信息工作台看到；或必须先理解 `ai_transform` 与 `ai_aggregate` 的差别才能建该规则。

**场景三 · 读前准备**

- [x] 关闭浏览器后，计划时点仍产生 scheduled 记录（引用运行记录）。55 条 scheduled 的 `scheduled_for` 100% 命中计划时点、54 条延迟 0–1s，见 §11.4。
- [x] 重新打开同一分类，"AI 处理后"直接可用，无需先发布；有草稿时明确提示"当前使用已生效版本 vN"。
- [x] 切换标签页再回来，页码／滚动位置／所选条目保持，不回到偏移 0。
- 不通过：需要用户判断"该按哪个按钮"；或计划与草稿都无改动时"立即运行"仍禁用。

每轮出口统一执行：`typecheck` → `lint` → `test`；并在 `local.folo.is` 生产构建上留一次真实交互证据。浏览器扩展阻挡时如实记为未验收，不折算为通过。

---

## 7. 分期与顺序

| 阶段    | 内容                          | 理由                                                   |
| ------- | ----------------------------- | ------------------------------------------------------ |
| 第 0 步 | 落实 D1–D5 决策，写入本文档   | 五项里有三项依赖它们；未定就编码会重复这一轮           |
| 第一轮  | P0-2 统一入口 + P0-3 简化动作 | 同属 UI／编排层，先固定规则与状态口径                  |
| 第二轮  | P0-1 接回时间线               | 数据层改动，界面要消费第一轮确定的状态语义，**不并行** |
| 第三轮  | P1-4 + P1-5                   | 依赖前两轮确定的范围语义与状态模型                     |

第二轮开跑前，先用 **一个分类**（Blockchain）跑通技术验证，再铺开到社交视图与订阅级视图。

---

## 8. 风险与未验证项

1. **重复建设**：客户端语义去重、服务端 Story、`presentation` 展示策略三处都能"让内容消失或合并"。无 D5 决策则必然出现第三套。
2. **静默空转**：AI 设置里"语义去重"默认开启，但在生产 Web 页面不执行（§1.2）。这属于"看起来已配置"的陷阱，方案必须显式处理：接线，或在非 Electron 环境禁用并说明。
3. **状态持久化**：时间线角色过滤目前依赖客户端内存与 `localStorage`，清缓存或换设备即丢。若"AI 处理后"建立在其上，需明确持久化归属（服务端还是本地库）。
4. **能力门控**：处理服务全部入口受 `isLocalFoloHost()` 限制，"统一自动化入口"在正式版上是残缺的，需 D2 给出表述。
5. **未验证**：本轮评审与本文档均未运行测试、未做真机交互；语义质量（100–200 条用户确认样本）仍为 0，不因界面收敛而改善。

---

## 9. 落地状态（2026-09-21）

### 已完成

| 项                                    | 落点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 证据                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **D5 角色层**（整合第 1 步）          | 新增 `packages/internal/store/src/modules/entry/processing-role.ts`：`hidden / merged / keeper / story` 四类角色，来源 `service > local-dedupe`，服务端角色先留出写入口                                                                                                                                                                                                                                                                                                                                             | `processing-role.test.ts` 6 项通过                                                                                                  |
| 去重引擎降为角色来源                  | `semantic-dedupe.ts` 新增 `getSemanticDuplicateRoleDetail`；删除被角色层取代的 3 个 UI 级导出（含 `getSemanticDuplicateEntriesForKeeper`），对应测试迁到角色层                                                                                                                                                                                                                                                                                                                                                      | `semantic-dedupe.test.ts` 10 项通过（原 11 项，1 项迁走）                                                                           |
| 时间线过滤单一出口                    | `entry-column/hooks/useEntriesByView.ts` 改读 `isEntryHiddenByProcessingRole`；本地去重关闭时不再读取本地决策                                                                                                                                                                                                                                                                                                                                                                                                       | 渲染层 156 项通过                                                                                                                   |
| 角标收敛                              | `semantic-duplicate-badge.tsx` → `merged-entries-badge.tsx`（`MergedEntriesBadge`），数据源改为角色层的合并来源，3 个挂载点不变                                                                                                                                                                                                                                                                                                                                                                                     | 同上                                                                                                                                |
| 条目角色可观测                        | `EntryItemWrapper.tsx` 输出 `data-processing-role` / `data-processing-role-source`（原 `data-semantic-duplicate-role` 全仓仅此一处用）                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                   |
| **P0-3 同事件综述默认动作**           | 新增 `createSameEventAggregateAction()`：自动带上 P06/P07 预设，用户不必先手写两段 Prompt；`scope` 默认 `{all:true}` 即沿用规则范围（服务端 `candidatesForAction` 确认 scope 与 when 是叠加关系）                                                                                                                                                                                                                                                                                                                   | `processing-action-editor.test.ts` 新增 1 项，断言默认动作直接通过 `actionSchema`                                                   |
| P0-3 范围不再挡路                     | 聚合范围默认折叠为一句"将对本条规则范围内的相关内容做跨文章整合。"，可展开自定义、可一键改回                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                   |
| **P0-2 第一步：执行位置降级**         | `action-setting.tsx` 本机部署默认进入处理服务（`?scope=cloud\|local` 仍可直接访问），选择器下沉并加说明                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                   |
| **P0-1 第一步：服务端决策接回时间线** | 服务端新增 `GET /processing/roles`（`processing-reading-store.ts` 的 `roles()`）：按隐藏判定 + 活跃 Story 成员 + 同内容转载，投影出 `hidden / story / merged` 三类角色，范围取全部 current input（不受计划 scope 限制）。渲染层新增 `modules/information/processing-role-client.ts`：拉取后 1:1 搬运进 `replaceServiceRoles()`，只在 `isLocalFoloHost()` 下工作                                                                                                                                                     | 服务端 270 项通过（新增 4 项角色投影）；渲染层 262 项通过（新增 3 项）                                                              |
| 隐藏/代表判定单一来源                 | `refresh()` 里内联的隐藏表达式抽成 `entryHidden(override, decision)`，快照成员与时间线角色共用；行为不变                                                                                                                                                                                                                                                                                                                                                                                                            | 快照既有 6 项测试未改仍通过                                                                                                         |
| 角标承载综述                          | `MergedEntriesBadge` 在角色带 `storyId` 时改为"综述 · N"（N=并入条数+1），悬停卡显示综述标题、被并入条目与"在智能阅读中查看"入口；本地去重角标行为不变                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                   |
| **D2 统一规则列表**                   | 新增 `modules/action/unified-action-list.tsx`（单一列表：名称／条件摘要／处理方式摘要／启停／执行位置徽标）与 `use-processing-service-rules.ts`（取本机 2240 规则）；`action-setting.tsx` 去掉「先选执行位置」的 `SegmentGroup` 主路径，`?scope=` 退化为初始筛选；处理服务不可用时规则仍可查看编辑，启用与「立即运行」在详情内说明原因与前提（`processing-service-detail.tsx`）                                                                                                                                     | `unified-action-list.test.tsx` 4 项通过                                                                                             |
| **D3 条目级 restore 豁免并入**        | `processing-reading-store.ts` 角色类型新增 `restored`：`roles()` 末尾统一覆盖，使 restore 同时豁免隐藏与并入（语义去重 `merged`／综述 `merged`／同内容转载）；综述代表与保留条目的来源计数同步扣掉被恢复条目；代表自身被恢复不改变归属（它本来就是可见的那一条）。**第二轮实现有缺陷、第三轮已修**：原判定要求「当前角色是 hidden 或 merged」，但恢复覆盖本身已让 `entryHidden` 为 false，该分支对 hidden 永不成立，导致恢复只让条目悄悄回到列表、`restored` 角标永不出现；改为按「若没有这次恢复是否会被隐藏」判定 | 服务端 298 项通过（新增 6 项 restore/摘要用例）；真机库副本核对：seq=4437 由规则隐藏 → 打 restore 后角色为 `restored`（修复前为空） |
| **D3 时间线就地切换**                 | 新增 `entry-column/atoms/processing-timeline.ts`（`timelineContentModeAtom`）与 `layouts/ProcessingTimelineModeSwitch.tsx`（「AI 处理后 / 原始内容」两态，挂进 `EntryListHeader`）；`useEntriesByView` 的 `rawEntryIds` 单一过滤点上，「原始内容」直接返回未过滤的 `rawEntryIds`，范围与排序不变、计数随之恢复                                                                                                                                                                                                      | —                                                                                                                                   |
| **P0-1 Story 内联渲染 + 深链**        | 服务端新增 `GET /processing/stories/:storyId/digest`（`processing-reading-store.ts` 的 `storyDigest()`：正文、逐句引用、来源清单、`updatedAt`、`sourceCount`、`revision`；未知 storyId 返回 `missing`、正文版本失效返回 `repairing`）；渲染层新增 `StoryDigestPanel.tsx`，在综述角标处就地打开，显示来源数、更新时间与句段引用，并带 `storyId` 深链（`smartReadingPath(path, storyId)` → `ProcessingReader` 的 `deepLinkedStoryIdRef` 直接 `openStory`），只有要改综述才进工作台                                    | 服务端新增 2 项摘要测试通过；**真实库里 story 总数为 0，尚无端到端证据**                                                            |
| **P1-4 保存并启用一体化**             | `processing-setting.tsx` 收敛为单主按钮「保存并启用」（保存草稿 → 发布生效 → 保存计划），新增可勾选「重新处理近期内容」（默认不勾）；原「必须已发布、无脏改动」门槛降级为高级说明，草稿无改动时「立即运行」也可用已生效版本跑；常驻提示「有草稿时当前使用已生效版本 vN」                                                                                                                                                                                                                                            | —                                                                                                                                   |
| **D4 运行范围三态**                   | 新增共享解析器 `packages/internal/information-core/src/schedule-scope.ts`（`{mode:"all"}`／`{mode:"category",view,category}`／`{mode:"fixed",sourceKeys}`，旧扁平 `sourceKeys` 读作 `fixed`），并在 `index.ts` 导出；服务端 `processing-schedule.ts` 与渲染层 `processing-client.ts` / `processing-run-settings.tsx` 共用它，废弃「全选落库为当时 sourceKeys」                                                                                                                                                      | `schedule-scope.test.ts` 5 项、服务端新增 3 项通过                                                                                  |
| **D5 去重开关降级**                   | 删除 `SEMANTIC_DEDUPE_ALLOWED_CATEGORIES` 硬编码白名单（任意非空分类合格）；新增 `useSemanticDedupeEvaluatorAvailability()` 判定本地执行器可执行性；`SemanticDedupeSection.tsx` 的开关降级为「本地兜底执行器启停」并给出运行时可执行性提示                                                                                                                                                                                                                                                                          | `semantic-dedupe.test.ts` 通过                                                                                                      |
| **P1-5 切标签状态保持**               | `InformationPage.tsx` 隐藏时只 `abort()` 在途请求、不再 `setSnapshot(null)`；回前台按 `ownerId` 核验账号后复用快照；删除主路径重复的 AI 摘要结果列表。`ProcessingReader.tsx` 新增 `offsetRef`，回前台重载当前页并保留选中项，仅 `initial` 清空选择                                                                                                                                                                                                                                                                  | `InformationPage.test.tsx` / `ProcessingReader.test.tsx` 新增用例通过                                                               |
| **角色刷新时机**                      | `processing-role-client.ts` 在挂载与 `visibilitychange` 之外，可见期间每 60s 轮询一次角色投影；隐藏时停表，避免无意义的本机请求                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                   |
| **覆盖写入后的强制刷新（缺陷修复）**  | 新增 `refreshServiceProcessingRoles()`：先等在途轮询收尾再发起一次全新读取。原实现直接复用 `syncServiceProcessingRoles()`，它的 `pendingSync ??=` 重入门闩会让覆盖写入后恰好撞上在途轮询的界面拿到**写入之前**的响应，表现为「点了恢复没反应」，最长要等下一次轮询（60s）才生效。同时 `merged-entries-badge.tsx` 把写入失败显示出来（原本只置一个内部标志）                                                                                                                                                         | `processing-role-client.test.ts` 5 项通过（新增 2 项：并发复用同一在途结果、强制刷新不被在途轮询吞掉）                              |
| **已读条目退出处理队列**              | 新增终态 `skipped`：`processing-state.ts` 的 `settleRead(skip, revive)` 把已读的当前输入从 `pending`/`failed` 落为 `skipped`，来源侧又变回未读时放回 `pending`；`processing-engine.ts` 导出 `settleReadStates()` 并在批层与单篇路径各设一道读态闸门；`processing-worker.ts` 在 `hydrateMaterials` **之前**调用，避免已读条目仍被白跑一遍详情与可读性抓取；工作台新增「已读跳过」计数与独立视图，`pending` 不再把已读算进去                                                                                          | 服务端新增 4 项测试；一致副本模拟：3699 条 → `skipped`，`revive` 0                                                                  |

### 已读条目退出处理队列（2026-09-25）

用户要求「已读的条目不用再处理，无论是否在队列里」。查实的数据（`VACUUM INTO` 一致副本，非只读连接——只读连接会忽略 WAL 中已提交的数据）：

| 事实                                    | 实测                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending` + `current` 的输入            | **3699 条，100% 是已读**（存储 `body.read` 与实时 `entries.read` 零不一致，3699/3699）                                                                  |
| 这 3699 条落在哪                        | `publishedAt` 区间 `2019-11-21T00:00:00.941Z` ~ `2026-09-11T15:59:30.362Z`，**全部早于计划 `historySince`（`2026-09-11T16:00:00.000Z`）**，即全在窗口外 |
| 窗口内已处理                            | 5103 条：已读 2809（**55%**）、未读 2294                                                                                                                |
| 未读且未处理                            | **0 条**                                                                                                                                                |
| `entries` 表整体读态                    | 8802 条中已读 8363（95%）                                                                                                                               |
| 一致副本上模拟一次 `settleReadStates()` | `skip` 候选 3699、`revive` 0；执行后 `pending` 3699 → 0，`skipped` 3699                                                                                 |

两点必须说清楚：

1. **这 3699 条本来就没在烧模型额度**——worker 的 `withinWindow(publishedAt, historySince, cutoffAt)` 闸门早已把它们挡在模型与材料抓取之外。它们只是被来源同步往回翻历史时采集入库，然后永久显示为「待处理」。所以「待处理 3699」既误导（快照陈旧）又不实（窗口外）。
2. **真正被浪费的是窗口内的已读比例**：已处理的 5103 条里 55% 是已读，这部分钱已经花掉；本轮改动让后续不再花。

**口径后果（必须知道）**：已读条目不再产生单篇决策，因此也**不会成为综述成员**——`runStoryAggregation` 的候选只来自 `processingState.published()`。如果期望「已读条目仍可被并入综述、只是不单独处理」，那需要让聚合接受无单篇决策的原始材料，属于另一套口径，本轮**没有**做。

**未做（留给决策）**：`capture()` 仍会记录已读条目（只在处理阶段跳过）。若要让队列本身不再增长、库体积不再变大，需要在采集侧过滤；但采集时读态可能过期（一条抓取时未读、五分钟后被读掉的条目会被错误丢弃），且会让已读条目彻底不出现在工作台。

### 质量门

`turbo run format:check lint typecheck test`（全仓，无 `--filter`）**35/35 任务通过**：

- `prettier --check` 全仓通过（0 warning）；`eslint` + `tsslint` 全仓 0 error；
- `typecheck` 全仓 0 `error TS`；
- 测试：全仓 11 个包全绿，其中 `information-core` 33 项、`store` 39 项、`information-service` 298 项、`web` 275 项。

### 部署与真机核对（2026-09-22 01:30）

- 产物：主站 `apps/desktop/out/web`、信息页 `apps/desktop/out/information-web`、服务 `apps/information-service/dist/index.js` 全部重建；已安装运行时 `~/Library/Application Support/FoloLocal/information-runtime/index.mjs` 与构建产物 **md5 一致**（`e29105f5…`），LaunchAgent `is.folo.local.information` `state = running`，`local.folo.is/` 与 `/information` 均 200。
- 数据库在部署前备份两份：`backups/before-v32-round3-20260922.sqlite`、`backups/before-v32-restore-fix-20260922.sqlite`（各 130M）。
- 业务库副本核对（`VACUUM INTO` 副本 + 源码 harness，不碰线上库、不调模型）：
  - `restore` → `restored`：真实条目 seq=4437（由规则隐藏）打 restore 后角色确为 `restored`。
  - 计划范围向后兼容：既有记录读出 `{mode:"fixed",sourceKeys:[22]}`，旧扁平记录等价 `fixed` 成立。
  - 角色基线分布：`{ hidden: 18 }`，**无 `story` / `merged` / `keeper`**。

### P0-1 第一步的口径与偏离（必须知道）

- **范围口径**：角色投影取全部 current input，不做计划范围过滤。理由：时间线覆盖全部订阅，若按计划 `sourceKeys + historySince` 投影，范围外条目的隐藏/并入会在时间线里失效（正是 §3.1 的范围口径问题）。因此角色层能看到比阅读快照更多的角色。
- **代表条目而非新条目类型**：本轮**没有**把 Story 做成时间线里新增的一种条目类型。做法是让 Story 成员里最新的一条代表整篇综述（`kind: "story"`，角标显示来源数），其余成员与同内容转载标为 `merged` 被过滤。这样内容不消失（代表条目仍显示自己的标题摘要，悬停卡列出被并入项），也与本地去重"保留 keeper、隐藏重复"同构。**综述正文改为在列表内就地打开**（`StoryDigestPanel`，走 `GET /processing/stories/:storyId/digest`），已满足场景二"不跳页"；代表条目本身仍是普通条目，不新增一种条目类型。
- **`restore` 覆盖不豁免"并入"** —— **已在第三轮修复**：服务端角色投影新增 `restored`，条目级 `restore` 现在同时豁免隐藏与并入（见《已完成》表），阅读快照成员与时间线角色共用同一份判定。
- **深链已补**：`smartReadingPath(path, storyId)` 会带上 `storyId`，`ProcessingReader` 挂载后按它 `openStory` 直接定位到那一篇综述。

### 真机验收（2026-09-22 01:30–01:40，真实 Chromium + 真实登录态）

用本机已登录工作台写下的 better-auth 会话驱动真实 Chromium 访问 `http://local.folo.is`，只读不写。
脚本与截图在 `/tmp/folo-v32-verify/`（`scenario1*.cjs`、`workbench.cjs`、`probe-roles.cjs`、`shots/`）。

**通过（有界面证据）**

| 判据                                          | 结果                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6 场景一配置侧：**无需选择执行位置即可编辑** | `/action` 渲染出统一规则列表入口与常驻说明「规则列表合并了官方云端、本机与处理服务三种执行位置；执行位置只作为规则标识，新建时按当前环境决定，不需要先选。」；页面上**不存在**执行位置选择器（`button:has-text("官方云端"/"本机")` 计数为 0，截图 `s3-a-action.png`） |
| D3 时间线就地切换控件存在                     | 时间线头部渲染出「AI 处理后 / 原始内容」两态切换与「智能阅读」入口，分类视图内同样存在（截图 `s1-blockchain-original.png`）                                                                                                                                           |
| 服务端 → 客户端角色管道连通                   | 页面捕获到 `GET /information/v1/processing/roles` → **200**，返回 18 条 `kind:"hidden"`（带 `reason` 与 `inputSeq`），即处理服务决策确实抵达渲染层                                                                                                                    |
| 无新增运行时错误                              | 全流程 `pageerror` 为空；仅有若干条目级 `Entry 404`（历史条目已被上游删除，与本次改动无关）                                                                                                                                                                           |

**未能判定（缺数据，不是缺实现）**

| 判据                      | 阻塞原因                                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 场景一「计数随之恢复」    | 这 18 条被隐藏的条目**都不在时间线可滚动到的窗口内**：在 `全部文章`、`Blockchain` 分类、以及两个含隐藏条目的来源视图里各向下滚动 14 屏，渲染出的条目 `data-processing-role` 全为 `(none)`，两态条目数都是 15，因此看不到差别。要看出差别需要能定位到那 18 条中任意一条所在的视图。 |
| 场景二（Blockchain 综述） | 库里 **story 数为 0**（`store.stories.list()` 为空），Blockchain 分类有 88 条条目但没有任何「综述 · N」角标，digest 面板无从打开。**连数据前提都没有**。                                                                                                                           |
| 场景三「保存并启用」      | `/action` 显示「尚无自动化规则」——账号下**一条规则都没有**，统一列表走的是空占位分支，规则徽标与「保存并启用」按钮都渲染不出来。                                                                                                                                                   |

**发现的界面口径不一致（不是本轮引入，但需知道）**

- 工作台「已隐藏」视图显示 **共 0 条**，而同一时刻 `/processing/roles` 返回 **18 条 hidden**。这正是 §9《P0-1 第一步的口径与偏离》里写的分歧：**角色投影取全部 current input，阅读快照只取计划的 `sourceKeys + historySince`**。两处数字不同是既有设计，但用户会看到「工作台说没有隐藏内容、时间线却压掉了 18 条」。**建议下一轮决策：是否让工作台的已隐藏计数改用角色投影口径。**

### 未完成（明确不计入完成）

1. **场景二卡在账号数据，不是实现**：库里 story 数为 0，没有任何 `story` / `merged` / `keeper` 角色。**根因已查实**：`rule_set_releases` v1/v2 与 `automation_draft` 的 `rules` 数组**都是空的**（只有 `global.markdown` 全局指令），同时 5137 条决策里 **5120 条 `policy.aggregation = "deny"`**（只有 17 条 allow）。没有聚合规则 ⇒ `runStoryAggregation` 永远拿不到候选 ⇒ 该配置下不可能产出综述。综述摘要（`GET /processing/stories/:storyId/digest`）与内联面板**只有 fixture 单测证据**。用户已授权代建一条 Blockchain 聚合规则并跑一轮，取得真实综述后再判场景二。**→ 已收口（2026-09-25）**：聚合规则已发布并跑通，roles 里出现 4 条真实 Story，digest 返回 `status:"ready"` 的真实综述正文，角标与深链均已真机核对，见 §10.8(c)。
2. **场景三的「保存并启用」未在界面核对**：账号下没有任何自动化规则，统一列表与详情都无从渲染。「一次动作后 AI 处理后可用」「有草稿时提示当前使用已生效版本 vN」仍只有代码与单测证据。与第 1 条同一根因，建规则时一并核对。**→ 已收口（2026-09-25）**：`hasAddRule=true`、`hasEmptyPlaceholder=false`、版本提示「当前使用已生效版本 v4」，见 §10.8(d)。
3. **场景一的「计数恢复」未在界面核对**：两态控件确实在，但先前用 `page.mouse.wheel` 深滚的仪器无效（该列表在内部 `overflow-y:auto` 容器里，`mouse.wheel` 滚的是 window），据此得出的「滚 14 屏没有带角色的条目」**不成立**。改用容器 `scrollTop` 后是否能看到计数变化，需在部署本轮构建后重新取证。**→ 已收口（2026-09-25），但判据本身要改写**：用容器 `scrollTop` 取证成功（处理后 hidden 0 / 原始内容 hidden 6，itemId 可枚举），但**时间线头部不显示总数**，所以「计数恢复」只能读作**条目集与角色分布恢复**。会话中一度记下的「两态总计数 2175 → 2198」经复查**不成立**（2175 是 `/action` 左侧边栏「全部」计数，`2198` 无任何落盘来源），已在 §10.8(b) 末尾明确纠正。
4. **工作台计数与角色投影的口径** —— **已更正为「同一口径下的时点差异」，不是待决策的口径分歧**：最新阅读快照 `createdAt = 2026-09-19T15:08:45.087Z`、`max_seq = 11352`，而角色投影取全部 current input（`seq` 已到 14261）。快照按 §5 红线**在创建时冻结成员与 hidden 标记**，之后发布的决定不会自动进入，只有显式 `refresh()` 才吸收——所以两个数字不同是设计结果。已在工作台计数区加常驻说明（三语 `processing.reader.status.counts_note`），写明「计划范围内、截至该快照」。
5. **既有计划记录会被读成「固定名单」**：库里的旧计划是 `{mode:"fixed",sourceKeys:[22]}`。旧记录无法区分「用户选的是全部订阅」还是「手挑的 22 个来源」，因此它现在显示为「固定名单，不会自动纳入新来源」。这是 D4 向后兼容的必然结果，但用户需要自己重选一次「全部订阅」才会开始自动纳入——**属于需要告知的行为变化，不是 bug**。附带事实：这 22 个来源与 `sources` 表里 `category = "Blockchain"` 的 22 个来源**完全一致**（`view = 0`），所以现有计划事实上就是「Blockchain 单分类」。
6. **`{mode:"category"}` 的「自动纳入新来源」未验证**：处理服务不知道 Folo 的 view/category 体系，靠客户端用共享解析器解析后把名单落库、重开页面时再解析并写回。这条「自动纳入」的实际效果尚未真机确认（见 §2 D4 的允许偏离）。
7. **`/tmp/folo-v32-verify/`** 下的验收脚本与截图是临时产物，未纳入仓库；若要长期留存证据需另找位置。
8. **已读条目无法再成为综述成员**：见《已读条目退出处理队列》的口径后果。若需要保留这条通道，须另行设计。

**一处不是缺陷的状态**：`processing_schedule_triggers` 61 条记录**全是 `deferred_budget` / `retry_wait`，没有一条 `succeeded`**。这不是故障——`processing-worker.ts` 里 `deferred_budget` 的判定条件包含「来源覆盖未完成」（`pending` / `budget` / `timestamp_boundary`），而来源同步**每轮每个来源最多只取一页**（`processing-source-sync.ts` 的注释与实现）。22 个来源、`historySince = 2026-09-11`、积压 3699 条窗口外条目，所以每轮必然落到这个状态。它表示「本轮做完了一批、还有剩余」，不表示失败。

---

## 10. v3.2 收口（2026-09-25）

### 10.1 本轮代码变更

**新增 2 个模块（各带单测）**

| 文件                                | 作用                                                                                                                         | 证据                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `modules/action/rule-selection.ts`  | 把「初始选中项」的解析从组件里抽出来，并引入虚拟选中项 `processing_service:__detail__`（零规则时也能进入处理服务详情）       | `rule-selection.test.ts` 9 项  |
| `modules/action/release-version.ts` | `resolveLiveReleaseVersion(releases, release)`：兼容 `save` / `release` 返回体都不含 `releases` 的现实，取两者版本号的最大值 | `release-version.test.ts` 4 项 |

**改动 4 个文件**

| 文件                                             | 改动                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `modules/action/action-setting.tsx`              | 删掉内联的 `parseRequestedScope`；零规则时也挂载处理服务详情；`ProcessingServiceDetail` 接 `onRulesChanged` |
| `modules/action/use-processing-service-rules.ts` | 新增 `refresh()`（`revision` 计数触发重取），暴露给调用方                                                   |
| `modules/action/processing-service-detail.tsx`   | 新增 `onRulesChanged`，`ProcessingSetting` 的 `onSaved` 接进来                                              |
| `modules/action/processing-setting.tsx`          | `save()` 成功路径回调 `onSaved`；`liveReleaseVersion` 改用 `resolveLiveReleaseVersion`                      |

### 10.2 本轮修掉的两个真实缺陷

**(a) 「保存并启用」后，界面提示的已生效版本滞后一版。**

`PUT /configuration`（保存草稿）返回 `{revision, config}`、`POST /rule-set-releases`（发布）返回 `{version, targetInputIds}`，**两者都不含 `releases`**。而 `liveReleaseVersion` 优先取 `Math.max(...editor.releases)`——编辑器里的 `releases` 是上一次读取的快照。实测：服务端已生效 v4，界面仍提示「当前使用已生效版本 **v3**」。修法：取「已读取到的版本列表」与「本次发布返回的版本」的最大值。

**(b) 处理服务规则集为空时，界面上没有任何路径能新建第一条规则（缺实现）。**

三条路径全都不通：`handleCreateRuleTop` 硬编码创建 **cloud** 规则（`action-setting.tsx:198-201`）；`handleCreateRule` 明确要求 `selected.scope` 是 `cloud | local`（`:190-196`）；`ActionButtonGroup`（带「新增规则」按钮）只在 cloud/local 详情分支挂载（`:216`）。于是 `?scope=processing_service` 深链因为「找不到 processing 行」而选不中，页面只剩空态占位，其 CTA 建的是 cloud 规则。修法：引入虚拟选中项，让处理服务详情在零规则时也能挂载。真机复验：`新增规则` 计数 **0 → 1**，`尚无自动化规则` 计数 **1 → 0**。

### 10.3 部署与沙箱结论（可复用）

| 结论                          | 实测                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launchd 作业注册必须离开沙箱  | `launchctl bootstrap` 在沙箱内返回 `EIO 5`；安装脚本里的 `shutil.rmtree(previous)` 还会触发批量删除守卫 → 先把 `information-runtime-previous` **改名让位**，再用无沙箱跑安装            |
| 批量删除守卫阈值              | 一次删除 ≥50 个文件被判危险；`rm -rf out/web`（454 个文件）会被拦 → 一律改名让位（`mv out/web out/web-pre-<tag>`）                                                                      |
| 本地端口健康检查必须绕代理    | 环境里 `HTTP_PROXY=127.0.0.1:56838` 会把连不上的本机端口伪造成 **`502/503`**；必须 `curl -s --noproxy '*'`，只有 **`000`** 才代表「没有进程监听」                                       |
| zsh glob 无匹配会中断整条命令 | `rm -f path/Singleton*` 在无匹配时报 `no matches found`，整条命令以 1 退出（但后续同伴命令仍会执行），极易误读为「脚本失败」。改用 `for f in a b c; do [ -e "$f" ] && rm -f "$f"; done` |
| 沙箱里不要用 bash 找内容      | 对某些调用会**静默返回空且退出码 0**，看起来像「没有匹配」→ 一律改用检索工具（`Grep` / `Glob`）                                                                                         |

部署结果：服务端产物 md5 `b79c12605449f851d491878ae52d1dc2`（构建产物 ↔ 已安装运行时一致），主站产物 `main-web/assets/index-N-7M7p8z.js` 内含新增的 `processing_service:__detail__`；`127.0.0.1:2240/information`、`local.folo.is/`、`local.folo.is/action?scope=processing_service`、`local.folo.is/information` **全部 200**。

### 10.4 方法学纠错（读这个库时最容易踩的六条）

**(a) `entry_decisions` 的真实表结构**是 `id / input_seq / generation / release_version / body / created_at`。决策自己的版本戳在**列** `release_version` 上；`body` 里没有 `input` / `release_version`，生成时间在 `json_extract(body,'$.generatedAt')`。

**(b) `processing_inputs.release_version` 会被 publish 重新盖章，不能用来给历史决策分组。** 发布时对每个命中输入执行 `UPDATE processing_inputs SET release_version=?, generation=generation+1, status='pending' WHERE seq=? AND current=1`（`automation-store.ts:331` 附近）。因此 `entry_decisions JOIN processing_inputs GROUP BY inputs.release_version` 会把**发布之前**产生的旧决策整体算到新版本头上。本次实测就撞到了：该写法把 v4 报成 327 条决策，而其中绝大多数是发布前生成、被重新盖章的旧决策。正确做法：用 `entry_decisions.release_version`，或改用 `generatedAt > 发布 created_at` 判断。

**(c) 时间字段别混。** `processing_inputs` **没有 `published_at` 列**，条目发布时间在 `json_extract(body,'$.publishedAt')`；表里的 `received_at` 是**采集入库时间**。

**(d) `recent` 发布范围用 `receivedAt`，处理窗口用 `publishedAt`。** `automation-store.ts:365` 的 `publicationPlan` 判 `Date.parse(input.receivedAt) >= Date.parse(scope.since)`；`processing-engine.ts` 的 `withinWindow` 判 `candidate.body.publishedAt`。两套口径不同，做数据核对时不要互相套用。

**(e) 一致副本只能用 `VACUUM INTO 'path'`（单引号）。** 只读连接会忽略 WAL 中已提交的数据，会读出「几十分钟前」的假状态；`VACUUM INTO "path"` 用双引号会被当标识符解析并报 `no such column`。

**(f) 其余易踩列**：`automation_draft` 无 `updated_at`（只有 `revision` / `body`）；`jobs` 只有 `id / body / status`（`kind` 在 `processing_schedule_triggers` 上）；`processing_material_state` 主键是 `(source_key, item_id)`（它的主键**不含** `generation`，别按 `input_seq` JOIN）；`rule_set_releases` 的规则数用 `json_array_length(json_extract(body,'$.rules'))`。

### 10.5 已读收敛的真机生效（2026-09-25 06:35Z → 06:53Z）

| 时点                     | pending | skipped | succeeded | `entry_decisions` |
| ------------------------ | ------- | ------- | --------- | ----------------- |
| 前（06:35Z `post`）      | 3704    | 0       | 5264      | 5301              |
| 后（06:53Z `state-mid`） | 483     | 3859    | 4936      | 5301              |

- 收敛由 `settleReadStates()` 完成，位置在 `hydrateMaterials` **之前**（`processing-worker.ts:85`），所以已读条目这一轮连「抓详情 + 可读性提取」都没跑。
- 收敛后的 `pending` 483 = **225 条本轮新采集的未读** + **258 条 v4 发布重新命中的未读**；`skipped` 3859 = 3664 条 `generation=1` + 69 条 `generation=3` + 其余为 `generation=0/2`。
- `succeeded` 少了 328：v4 发布把命中输入（其中包含已 `succeeded` 的）改回 `pending` 并 `generation+1`；这批里已读的在收敛中落为 `skipped`。

### 10.6 首轮积压的吞吐事实（必须知道，否则会误判成卡死）

未读待处理 483 条，而批层每批 `MAX_ENTRY_BATCH_ITEMS = 8`（`MAX_ENTRY_BATCH_CHARS = 50_000`，`MAX_ENTRY_CHARS = 60_000`），且**批层是串行的、在单篇主循环之前整体跑完**——`processing-engine.ts:105` 先 `prepareNormalEntryBatches` 走完所有批次，`:108` 才开始主循环落库。

本轮实测：**≈1 次模型调用/分钟**，单次 48s 均值，单次输入峰值 5.5 万 token。按 483 条推算需 ≈60 次调用、约 1 小时走完批层，之后主循环才开始写 `entry_decisions`。

**推论**：「已读条目退出处理队列」修好之后，第一次运行会撞上一个**真实存在的未读积压**，而它按 8 条/批串行消化。这个阶段 `processing_inputs` 的状态与 `entry_decisions` 行数**完全不动**（模型产物只进 `processing_model_cache`），看起来像卡死但并不是。观测应以 `runtime/codex-usage.jsonl` 的调用计数为准。

### 10.7 一处待决策

**`saveAndEnable` 的三步不是原子的。** 「保存并启用」= 保存草稿 → 发布生效 → 保存计划，三步各自独立提交。本次实测出现过「发布成功、计划未保存」（失败发生在检查点之前，日志里没有留痕），结果是留下一个**没有任何候选**的发布版本——`runStoryAggregation` 对旧版本仍会跑一轮，但候选为空。建议把三步包成一个事务，或至少让第二、三步的失败在界面上可见。

---

## 11. 本轮真机复验（2026-09-25 17:00–18:00）

### 11.1 修掉的两个真实回归（本轮新增，均已真机复核）

**(a) `/inputs` 响应里出现终态 `skipped`，整个详情面板报「规则或服务响应无效」。**

| 项       | 内容                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 症状     | `/action?scope=processing_service` 的处理服务详情整体显示「规则或服务响应无效，请检查填写内容。」（i18n key `processing.error.invalid`），拿不到任何输入                                                                                                                                                   |
| 根因     | `processing-client.ts:375` 的 `status` 是**闭合枚举** `pending \| running \| succeeded \| failed`，而 `processingInputWireSchema` 用 `.strict()`；`/information/v1/inputs` 的真实响应 9624 项里含 **4150 项 `status="skipped"`**（《已读条目退出处理队列》引入的终态）→ 整份响应解析失败被当成「响应无效」 |
| 修法     | 枚举补 `skipped`，并加回归守护测试（含反向断言：`"archived"` 仍须被拒，否则枚举会退化成任意字符串）                                                                                                                                                                                                        |
| 真机复核 | `inputsHttp = 200`、`inputsBytes = 2646389`、`inputsStatusCounts = {skipped: 4150, succeeded: 5474}`；`规则或服务响应无效` 与 `processing.error.invalid` 出现次数**均为 0**；产物 `about-CA4TYkvy.js` 内含 `["pending","running","succeeded","failed","skipped"]`                                          |

**(b) `/action` 上 4 处 i18n raw key（`PROCESSING.SCOPE` ×2、`actions.action_card.all` ×2）。**

这不是「键没写」，是**命名空间绑定**问题，两个成因叠加：

1. **`useTranslation([ns1, ns2])` 默认只用 `ns1` 绑定 `t`。** `node_modules/react-i18next/dist/commonjs/useTranslation.js:82`：
   ```js
   const calculatedT = i18n.getFixedT(
     currentLng,
     i18nOptions.nsMode === "fallback" ? namespaces : namespaces[0], // ← 默认只取第一个
     keyPrefix,
     { scopeNs: namespaces },
   )
   ```
   即必须显式声明 `nsMode: "fallback"`（类型见 `react-i18next/index.d.ts:200`、`:329`：`nsMode?: 'fallback' | 'default'`）才会把整个数组传下去。已用**运行时真实资源树**在 Node 里复现：`getFixedT('zh-CN','settings')` 下 `t("processing.scope")` 返回原键，`getFixedT('zh-CN','app')` 下返回「处理服务」。
2. **旧产物把摘要函数的 `t` 编译成了恒等函数。** 旧包里是 `w = d.useCallback(l => l, [t])`，所以 `conditionSummary` 原样输出 `actions.action_card.all`；新包为 `{t:w} = L(["settings","app"],{nsMode:"fallback"}), S = d.useCallback(l => w(l), [w])`。**这是「代码改对了但页面没变」的典型陷阱**：修完必须核对产物里这一段的真实形态，不能只看源码。

| 命名空间归属（本轮实测） | 键                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                    | `processing.scope`、`processing.conditions`、`processing.type.presentation`、`processing.error.invalid`、`automation.processing_unavailable_short`、`automation.execution_location_note` |
| `settings`               | `actions.action_card.all`、`actions.scope.cloud`、`actions.scope.local`、`actions.action_card.summary.no_actions`、`actions.action_card.summary.disabled`                                |
| **不存在**               | `settings.processing`（无此键）、`app.actions`（无此键）                                                                                                                                 |

- 修法：`unified-action-list.tsx`（列表项列同时用到两个命名空间）与 `action-setting.tsx`（摘要函数）两处显式写 `nsMode: "fallback"`；新增 `unified-action-list.i18n.test.tsx`，**不 mock react-i18next**，用真实 i18next 实例 + 真实语言包，并做**正反对照**（同一个 `Probe` 组件里 `nsMode:"fallback"` 与默认模式各读一次）。
- 真机复核：**`raw key 命中（键, 次数）= []`**；页面实际加载入口 `main-CkDHkpEa.js`，且 `swController = null`、`swRegistrations = 0`（排除旧包/Service Worker 缓存误导）；修复代码落在懒加载块 `index-DNVc9P21.js` 内，该块确实在页面的 `loadedJs` 列表里。

### 11.2 场景一：时间线两态过滤

范围 `/timeline/articles/231195353137392640/pending`（TechFlow）。两态控件存在（`AI 处理后` 为当前态 / `原始内容`），点击就地切换，URL 不变。

| 判据                       | 【AI 处理后】     | 【原始内容】                   |
| -------------------------- | ----------------- | ------------------------------ |
| 22 步容器滚轮累计唯一条目  | **221**           | **231**                        |
| 角色分布                   | `{"(none)": 221}` | `{"(none)": 225, "hidden": 6}` |
| 命中 `roles.hidden` 的条目 | **0**（期望 0）   | **6**                          |

「原始内容」相对「处理后」多出的 10 条 = **6 条处理服务隐藏 + 4 条本地语义去重**。后者能一起恢复是设计使然：两态切换跳过的正是同一个 `isEntryHiddenByProcessingRole(id, { localDedupe })` 调用，处理服务决策与本地去重共用一处过滤。

6 条被隐藏的 itemId：`1303536587476328460`、`1303416012460285962`、`1303295389478182922`、`1303174332620496901`、`1303174332620496908`、`1303066359541817346`。

**可追溯性**（把结论标出来，是 §6 场景一的核心诉求）：

| 项                               | 实测                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 能否定位到某条被隐藏条目         | ✅ 在「原始内容」态滚到 `scrollTop = 12889`（`scrollHeight = 16424`，渲染 23 行）定位到 `1303536587476328460`，`role = hidden` |
| 结论标识是否可追溯到             | ✅ `<span aria-label="AI 已隐藏">`，条目文本为 `TechFlow AI 已隐藏 · 1 天前 …`                                                 |
| 处理**理由**文本是否在时间线展示 | ⚠️ 未展示（`reasonFragment = false`）                                                                                          |
| 悬停卡是否有内容                 | ⚠️ `[data-radix-popper-content-wrapper]` 已挂载但 `innerText` 为空，`[role=tooltip]` 无节点                                    |
| 是否有就地恢复入口               | ⚠️ 无（`restoreEntry = false`）                                                                                                |

**必须纠正的一处记录。** 本轮会话中一度记下「两态总计数也不同（2175 → 2198，差 23）」。复查后**该说法不成立**：

- `2175` 是 `/action` 页**左侧边栏「全部」**的计数（落盘于 `page-text.txt`），它随远端未读状态在 **2151–2195** 之间波动（同目录另有 `2184`/`2186`/`2195`/`2151` 四个采样），与时间线两态无关；
- `2198` 在整个验证目录的**任何落盘产物里都找不到**；
- 时间线头部**根本不显示总数**——`EntryListHeader` 只渲染订阅标题与操作按钮，`entriesIds.length` 只被虚拟列表与日期分组计数 `groupedCounts` 使用。

因此 §6 场景一的「计数随之恢复」应读作**条目集与角色分布恢复**（上表的 221/0 vs 231/6），而不是某个可见总数变化。

### 11.3 场景二：Blockchain 同事件综述

聚合规则发布后跑通一轮，`GET /information/v1/processing/roles` 返回 78 个角色：`{hidden: 50, restored: 1, merged: 23, story: 4}`。

| 项          | 实测                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 条 Story  | `488d8c06`（并入 1）、`63e65fcd`（并入 12）、`81996ca9`（并入 9）、`684879d0`（并入 1）                                                                              |
| 角标        | 滚 24 屏命中代表条目 `1302816827394514945`，`badgeText = "综述2"`、`badgeAria = "另有 1 条内容已并入本条"`                                                           |
| digest 响应 | `200`，`{"status":"ready","storyId":"488d8c06-…","revision":1,"title":"习近平抵达华盛顿开启对美国事访问","sourceCount":2}`                                           |
| 就地面板    | 点角标后 **URL 不变**；面板渲染 5 个句段引用（`blockquotes = 5`），「来源 2 条 · 更新于 25 分钟前 · 第 1 版」                                                        |
| 深链        | `/information?returnTo=%2Ftimeline%2Farticles%2F231195353137392640%2Fpending&storyId=488d8c06-5093-442f-bfdf-801cc0828788#smart-reading`，落地后正确解析出 `storyId` |

### 11.4 场景三：读前准备（关闭浏览器后计划仍生效）

| 判据                 | 实测                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一列表与详情可渲染 | `hasAddRule = true`、`hasEmptyPlaceholder = false`、`versionHint = "当前使用已生效版本 v4"`                                                                                               |
| 切标签保状态         | `scrollTop 3441 → 3373`，视口内 23 条，选中条目仍在视口，URL 不变                                                                                                                         |
| 计划配置             | `{enabled: true, times: ["08:00","12:00","15:00","20:00","23:00"], tz: "Asia/Shanghai", scope: {mode:"fixed", sourceKeys: 22 个}, historySince: "2026-09-11T16:00:00.000Z", revision: 2}` |
| `kind × status` 分布 | `scheduled deferred_budget 48` / `scheduled retry_wait 6` / `scheduled running 1` / `manual 7` / `catchup 3`                                                                              |
| **时点命中率**       | 55 条 `scheduled` 记录的 `scheduled_for` **100% 命中 `times`**（含 `2026-09-20T20:00`、`2026-09-24T23:00` 等深夜时点）                                                                    |
| **触发延迟**         | 54 条 `created_at - scheduled_for` 差 **0–1 秒**；唯一例外是当前 `running` 那条（计划 08:23 才发布，晚 5014s）                                                                            |
| 触发由谁发起         | 服务端 worker——`processing-worker.ts:31` 调 `store.schedule.tick(new Date())`，**与浏览器是否打开无关**                                                                                   |
| 运行报告             | 最近 4 条有 `processing_trigger_reports`，各含 22 个来源、每个 `pages: 1`，`coverage` 为 `budget` / `history_boundary`                                                                    |

### 11.5 隐藏分布的权威口径（清理后快照）

在 `VACUUM INTO` 一致副本（`snapshot-after-cleanup.sqlite`）上按源码谓词统计：

- **生效决策 5543 条**（走 `processing_inputs.decision_id → entry_decisions.id`，不按 `release_version` 分组）；
- **(standalone, aggregation, rewrite, status) 全分布**：`auto/deny/allow/keep 3303`、`auto/deny/deny/keep 1591`、`auto/allow/allow/keep 384`、`auto/allow/deny/keep 149`、`always/deny/deny/needs_context 58`、`never/deny/deny/hide 45`、`auto/allow/deny/hide 13`；
- **`entryHidden`（依 `processing-reading-store.ts:855` 谓词，含覆盖）= 58**，其中 `standalone = 'always'` 的 **0 条**（红线成立）；
- **隐藏条目按来源**：`231195353137392640` 19 / `58374877360520192` 15 / `1124071324059041792` 8 / `1106497372717711360` 6 / `131152667982631936` 5 / `79332238621864960` 2 / 另 3 个来源各 1（合计 58）。

**`standalone = 'always'` 的 58 条全是 `status = "needs_context"`**，reason 清一色是「证据不足 / 需要上下文」类（例如「证据目录为空，无法提取有效事实。」「缺少必要的文本证据以进行忠实性分析。」「缺少足够的上下文来确定文章的具体内容。」）。也就是说，**这 58 条是「证据不够所以不隐藏」，不是「项目方公告所以不隐藏」**——§6 里「项目方公告类订阅仍单独可见」这条判据**没有数据前提可判**，只能记为「例外在数据上成立（`always` 58 条全部落在 `needs_context`，且隐藏集里 `always` 为 0）」。

### 11.6 收尾：验证遗留的覆盖行已清零

| 步骤     | 结果                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 清理前   | 覆盖表 4 行 = 测试前基线 2 行（`feed/1106497372717711360`）+ 本轮验证新增 2 行（`feed/58374877360520192`）                                                                                 |
| 落档     | 先 `VACUUM INTO` 出 `backups/before-v32-override-cleanup-20260925.sqlite`（175 MB），并确认**无活跃写者**（`processing_schedule_triggers` 无 `running`、`processing_inputs` 无 `running`） |
| 执行     | 按来源键删除 2 行（`DELETE changes = 2`）                                                                                                                                                  |
| 比对     | 剩余 2 行与 `before-v32-restore-fix-20260922.sqlite` **逐行一致** → 账号覆盖状态已还原                                                                                                     |
| 连带效果 | 测试期间有 1 条 `restore` 覆盖在豁免一条隐藏，删除后 `entryHidden` 由 57 回到 **58**                                                                                                       |

### 11.7 出口质量门

`npx pnpm exec turbo run format:check lint typecheck test --continue`（全仓，无 `--filter`）：**35/35 任务通过**。

- `prettier --check .`：`All matched files use Prettier code style!`
- `eslint` + `tsslint`：**0 error**（975 条 warning 全部是仓库既有的 `ts/no-explicit-any`、`react-naming-convention/*` 之类）
- `typecheck`：各包 `tsc --noEmit` 全过
- 测试：11 个包全绿，其中 `@follow/web` **76 个测试文件全通过**、`information-service` 39 个、`electron-main` 11 个、`store` 8 个、`utils` 5 个、`ota` 5 个、`folocli` 5 个、`information-core` 4 个、`landing` 3 个、`ssr` 2 个、`readability` 1 个

两处必须记下的门禁细节：

1. **必须加 `--continue`。** 不加时，任何一个任务失败都会让 turbo 直接中止其余任务——本轮就出现过「一个与本次改动无关的测试在重负载下超时」把 `lint` 与 `format:check` 一起杀掉、看不到它们真实结果的情况。加 `--continue` 才能拿到完整判断。
2. **`src/modules/integration/custom-integration-manager.test.ts` 在重负载下会抖动。** 该用例默认 5s 超时，并行跑全仓时实测 5180ms 超时失败，单独跑 617ms 通过；与本次改动无关。若要长期稳定，应给它单独的 timeout 或降低其真实耗时。

### 11.8 提交后复核：服务端产物曾比源码旧一处，已重装对齐

提交前只核对了「构建产物 ↔ 已安装运行时」的 md5（当时两者一致，都是 `b79c12605449f851d491878ae52d1dc2`），**没有核对「已安装运行时 ↔ 当前源码」**。提交后补做这一步时发现不一致：

| 项         | 结果                                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 差异是什么 | 只有 2 行，都在 `processing-state.ts` 的 `settleRead()`：已安装版本是 `changed += toSkipped.run(seq).changes`，当前源码构建出 `changed += Number(toSkipped.run(seq).changes)`                                                                                                          |
| 为什么会差 | `node:sqlite` 的 `run()` 返回 `changes: number \| bigint`，直接 `let changed: number; changed += ...` 过不了 `tsc`，所以事后补了 `Number()`。**运行时等价**（实测 `.changes` 是普通 number），但字节不同                                                                               |
| 证据       | md5 旧 `b79c12605449f851d491878ae52d1dc2`（2 383 685 B）/ 新 `6a3e97d0b95b5173e4fe01ecc0df0123`（2 383 701 B）；按行 diff 恰好 2 行不同                                                                                                                                                |
| 渲染层侧   | **一致**。`main-web` 构建于 17:42，其下唯一更新的渲染层文件是测试文件 `unified-action-list.i18n.test.tsx`（不进包），因此主站产物就是已提交源码的产物                                                                                                                                  |
| 处理       | 旧产物留档到 `backups/information-runtime-index-20260925T191206.mjs` → 覆盖 `information-runtime/index.mjs` → `launchctl kickstart -k`（重启前先确认库里**没有** `running` 的 job/trigger，本轮实测无）→ 新 pid 64620                                                                  |
| 重装后复核 | 运行时与构建产物 md5 一致（`6a3e97d0…`）；`/information`、`/health`、`/`、`/action?scope=processing_service`、`/information` **全部 200**；重跑 `/action` 探针结论**完全不变**（`{skipped: 4150, succeeded: 5474}`、错误文案 0、raw key 空、`pageErrors` 空、入口 `main-CkDHkpEa.js`） |

**教训（可直接复用）**：部署核对要做**两步**——「产品代码构建产物 ↔ 已安装运行时」和「当前源码 ↔ 构建产物」。只做前者会在「源码改过、但改的是类型层面」时给出假绿。判定第二步最省事的办法是**重建一次再比 md5**（本轮就是靠它发现的），比逐文件比 mtime 可靠（`lint-staged` 的 `prettier --write` 会刷新 mtime 而不改内容）。

## 12. 方法学纠错（第 7 条）与产物/运行时陷阱（读这个库与调这个前端时最容易踩的）

### 12.1 第 7 条（最重要）：**「隐藏」不是 `policy` 上的字段，而是 `body.status === "hide"`**

`policy` 的真实形状只有三个字段：

```jsonc
{ "standalone": "auto" | "always" | "never", // 是否独立展示
  "aggregation": "allow" | "deny",           // 是否可参与综合
  "rewrite": "allow" | "deny" }              // 是否可改写
```

**`policy` 里没有 `hidden`、也没有 `presentation`。** 判定在 `processing-reading-store.ts:855` 的 `entryHidden()`：

```ts
override?.mode === "hide" ||
  (override?.mode !== "restore" &&
    decision?.policy.standalone !== "always" &&
    (decision?.policy.standalone === "never" || decision?.status === "hide"))
```

三个必须记住的后果：

1. `policy.standalone === "never"` **或** `body.status === "hide"` 二者任一即隐藏——两个来源都要查；
2. `policy.standalone === "always"` 是**例外闸门**，优先级最高（即使 `status = "hide"` 也不隐藏）；
3. 条目级 `restore` 覆盖**同时豁免隐藏与并入**。

### 12.2 其余新增陷阱

**(a) `rule_set_releases` 的主键是 `version`，不是 `id`。**

**(b) `sources` 表只有 `key / body / active`**，订阅标题在 `json_extract(body,'$.title')`。

**(c) i18n 资源有两种形状，别混用。** 仓库源文件 `locales/<ns>/<lang>.json` 是**扁平点号键**（`"processing.scope": "处理服务"`）；构建产物 `/locales/<lang>.js` 是**嵌套对象**（顶层 = `ai, app, common, errors, external, lang, native, settings, shortcuts`）。判定「界面上到底有没有这个键」的权威来源是 `LocaleCache.shared.set(lang)` 序列化回 `localStorage["follow:locale-zh-CN"]` 的那份内存资源树（本轮实测 82810 字节）。

**(d) 跨命名空间的 `t` 必须写 `nsMode: "fallback"`**（见 §11.1(b)）。只写 `useTranslation(["a","b"])` 会静默只查 `a`。

**(e) 条目列是虚拟列表，且渲染容器必须从条目行向上找。** `[data-entry-id]` 向上找到的那个 `overflow-y:auto` 容器才是滚动目标；用「全文档最高的可滚动 div」会选中左侧订阅栏，滚动完全无效、条目数卡住不动。另外 **`page.evaluate(fn)` 只序列化函数体**，Node 侧作用域里的函数在页面里不可见（`FIND_SCROLLER is not defined`）——滚动逻辑必须内联进 `page.evaluate`。

**(f) `processing_schedule_triggers` 里只要有 `running`，安装器就会拒绝执行。** `apps/information-service/scripts/install-launch-agent.py:32-34` 的阻塞判据是「`processing_inputs.status='running'` 或 `processing_schedule_triggers.status='running'`」。**lease 已过期也照样阻塞**（本轮就撞到一条 `running` 且 lease 超时 5014s 的记录）→ 这种时候改用手工 `cp` 替换 `information-runtime` 下的产物目录。

**(g) `mv` 不能跨设备。** `/tmp` ↔ `/Volumes/SSD` 会报 `EXDEV: cross-device link not permitted`；一律**就地改名让位**（`mv out/web out/web-pre-<tag>`）。附带：批量删除守卫阈值 50，`rm -rf out/web`（454 个文件）会被拦下。

**(h) 页面内裸 `fetch("/information/v1/inputs")` 返回 403。** 该接口要一次性令牌，脚本发起的请求拿不到正文（26 B 的 403）。要看真实响应必须**在页面网络层截获应用自己那次请求的 `response.body()`**，不能自己重发。

**(i) 本地端口健康检查必须绕代理。** 环境里 `HTTP_PROXY=127.0.0.1:56838` 会把连不上的本机端口伪造成 `502/503`；必须 `curl -s --noproxy '*'`，且只有 **`000`** 才代表「没有进程监听」。

---

## 13. 增量：「编辑订阅」弹窗里的私人订阅标签（2026-09-25 21:00–22:35）

### 13.1 为什么要加

私人订阅标签原先只有两个入口：「设置 → 订阅源」的「我的标签」列（先勾选行、再批量加/减）和「Actions → 我的处理服务 → 私人订阅标签」（建/改名/删标签 + 批量选源绑定）。两者都是**批量视角**，而打标签最常见的时机其实是**刚订阅完、或回头整理某一个源**——那一刻用户面前只有「编辑订阅」弹窗，弹窗里却没有标签入口。本轮把入口补进 `FeedForm`。

### 13.2 实现（两版）

**初版（22:20）**：`FeedForm` 里一张 checkbox 列表，挂在 `</Form>` 之后、`<RootPortal>` 之前；只能勾选已有标签，**不能在弹窗里建标签**（当时的判断是：建/改名/删标签属全局操作，统一留在 Actions 面板）。真机已复核通过。

**终版（23:00，用户反馈后重写）**：用户提出两点 ——「编辑订阅时的标签放在分类下面」「应该可以在这里直接创建，类似 Notion 里的多选属性」。于是从 checkbox 列表改成**多选属性控件**，并把挂载点上移。

| 项     | 内容                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新组件 | `apps/desktop/layer/renderer/src/modules/action/feed-subscription-tags.tsx`                                                                                                                                                                                                                                                                                                                         |
| 挂载点 | `modules/discover/FeedForm.tsx` 的 **`category` 字段之后、`isPrivate` 字段之前**（`FeedForm.tsx:413` 附近），条件 `isSubscribed`（新建订阅时服务端还没这个 source，写标签必然失败）。选这里是因为「分类」和「标签」都是「给这个源补元数据」，放一起最顺手                                                                                                                                           |
| 数据   | 复用 `processingClient.load()` 取 `subscriptionTags`（含 `revision`）+ `sourceTags`；`bindTags([processingFeedSourceKey(feedId)], [tagId], "add"｜"remove", revision, signal)` 写入；`createTag(name, revision, signal)` 建新标签                                                                                                                                                                   |
| 并发   | 所有写操作都带**读到的 `revision`**；`createTag` 返回新快照，紧接着的 `bindTags` 用**创建后返回的 `revision`**（不是读到的那个），否则服务端判冲突                                                                                                                                                                                                                                                  |
| 门禁   | `isLocalFoloHost()`（hostname 严格等于 `local.folo.is`），与订阅源设置页的标签列同一条件                                                                                                                                                                                                                                                                                                            |
| 交互   | 已选标签渲染成 chip（chip 上的 × 解绑）＋输入框 ＋ 下拉候选；输入已有名称则过滤候选，输入新名称则出现「创建「xxx」」项（**同名不重复创建**）；`Enter` 提交（可创建时创建、唯一匹配时切换）；`Backspace` 在空输入时解绑最后一个 chip；`Escape`/外部点击关下拉                                                                                                                                        |
| 写路径 | 统一 `run(operation, rollback)`：`setBusy → await operation → await read`（重读服务端快照）；失败 `rollback()` 本地乐观更新并露出 `processing.error.*`。整个控件**即时写入、不参与表单的保存流程**。`createTag` 是例外——它返回的标签快照本身就是权威标签集，因此在它返回时就把 chip 画出来，不等「绑定 + 重读」那两次往返（理由与实测见 13.4）；回滚也相应精确化：只有「创建 / 绑定」自身失败才回滚 |
| 表单内 | 控件现在落在 `<form>` 内部，所以：`Enter` 必须 `preventDefault()`（否则触发整表单提交），三个 `<button>` 全部显式 `type="button"`（默认 `submit` 会提交表单）                                                                                                                                                                                                                                       |
| 文案   | 新增 `processing.tags_form_hint` / `tags_form_create` / `tags_form_no_match` / `tags_form_placeholder` / `tags_form_remove_chip`（en / ja / zh-CN 三份，`locales/app/*.json` 严格字母序；fr-FR / zh-TW 是部分翻译，按既有惯例不补）；初版的 `tags_form_empty` 已删                                                                                                                                  |
| 测试   | `modules/action/feed-subscription-tags.test.tsx` **9 项**：门禁不渲染、已绑定回显成 chip、空态 placeholder、展开下拉见全部候选、点未选写 add、点已选写 remove ＋ chip × 解绑、输入新名称出现创建项并以新 revision 绑定、同名不给创建、读取失败露可读错误、写入失败回滚 chip ＋ 提示冲突                                                                                                             |

**终版推翻初版的一个判断**：初版认为「弹窗不建标签」，终版改成**就地创建**。用户说得对——打标签最常见的时机就是整理某一个源，此刻被丢到别的页面去建标签，等于把一次操作拆成两次。

### 13.3 第一轮真机复验（2026-09-25 22:20–22:35，初版 checkbox 列表）

部署：重建 `out/web`（23 MB）与 `out/information-web`（2.9 MB）→ 装进 `information-runtime/{main-web,web}`（旧目录就地改名 `*-pre-20260925T221606`）→ `launchctl kickstart -k gui/<uid>/is.folo.local.information`。入口由 `main-CkDHkpEa.js` 换成 `main-DgRuxgYt.js`，`/`、`/assets/main-*.js`、`/information/` 全部 200。

探针（`probe-edit-feed-tags7.cjs`）走完整真机路径 —— 侧栏展开分类 → 右键订阅项 →「编辑」→ 弹窗里的标签区块：

```text
展开后侧栏 [data-feed-id] 数量 = 87
菜单项 = ["全部标记为已读 A","编辑 E","取消订阅","添加订阅源到列表","移动至分类","认证 C",
          "在新标签页打开订阅源 O","在新标签页打开网站 O","复制 ID C","更改为其他视图","为此范围设置 AI 规则"]
编辑订阅弹窗已打开 = true
  t=2s feed-form-processing-tags 数量 = 1
标签区块快照 = {
  "blockText": "私人订阅标签 勾选即给这个订阅源加上标签，取消勾选即移除。标签只用于本机处理服务，不改分类，也不写入公开 List。临时验证标签",
  "checkboxes": [{ "label": "临时验证标签", "checked": false }],
  "rawKeyLeak": false, "hasEmptyCopy": false, "targetPresent": true }
勾选后 = {"checked":true,"alert":null}
pageErrors = (none)
```

库内落盘核对：`source_tag_bindings` 出现 `{source_key: "feed/58374877360520192", tag_id: "75a23440-…"}`。

**验证后已清理**：用同一面板的「移除」删掉临时标签，`subscription_tags` 与 `source_tag_bindings` 双双回到 0 行，与验证前基线一致。写操作可回滚——临时标签本就是本轮探针创建的，删标签时服务端一并撤掉它的绑定。

### 13.4 第二轮真机复验（2026-09-25 23:05–23:20，终版多选属性）

部署：重建 `out/web` 与 `out/information-web` → 装进 `information-runtime/{main-web,web}`（旧目录就地改名 `*-pre-20260925T230441`）→ `launchctl kickstart -k`。入口由 `main-DgRuxgYt.js` 换成 `main-u6JTxZfh.js`；`/`、`/information/`、`/assets/main-u6JTxZfh.js` 全部 200；`launchctl print` 显示 `state = running`。

探针 `probe-edit-feed-tags8.cjs` 走完整真机路径（侧栏展开分类 → 右键订阅项 →「编辑」→ 弹窗内标签区块）：

```text
折叠中的分类 = 8
展开后侧栏 [data-feed-id] 数量 = 87
右键订阅项 = 58374877360520192
编辑订阅弹窗已打开
标签控件已就绪
表单几何 = {"category":514,"tagsBlock":609,"privateFollow":717,"hideFromTimeline":763,"view":810,"tagsInsideForm":true}
位置判定：分类(514) < 标签(609) < 私密订阅(717) = true
初始状态 = {"blockText":"私人订阅标签标签只用于本机处理服务，不改分类，也不写入公开 List。",
            "chips":[],"placeholder":"选择或创建标签"}
输入新名称后 = {"listOpen":true,"createText":"创建「验证标签2550」","optionCount":0}
已点「创建」
  t=7.5s chips=["验证标签2550"] alert=null
新标签已挂成 chip = true
最终状态 = {"rawKeyLeak":false,"blockText":"私人订阅标签标签只用于本机处理服务，不改分类，也不写入公开 List。验证标签2550验证标签2550"}
pageErrors = (none)
```

库内落盘核对：`subscription_tags` 1 行 `c0d868b1-8726-4748-a7f1-46bafcbdeb78 / 验证标签2550`；`source_tag_bindings` 1 行 `feed/58374877360520192 -> c0d868b1-…`；`subscription_tag_metadata.revision` 4 → 5（`createTag` 与 `bindTags` 各推进一次）。

清理：用 Actions → 私人订阅标签 里该行「移除」，`subscription_tags` 与 `source_tag_bindings` 双双回到 0 行。**注意 `revision` 不会跟着回退**（实测停在 6）——它是单调递增的并发写保护计数器，不是行数。

**第一次探针为什么全军覆没（必须知道）**：紧跟 `launchctl kickstart -k` 之后跑的那一轮，弹窗内所有 `/information/v1/*` 请求都失败（`error = "request"`，界面文案「读取或保存失败，请重试。尚未确认保存成功。」），15 s 轮询期间始终没恢复，也没有建出任何标签。隔几分钟、同样命令、同样凭据重跑即完全正常（同一路径返回 200）。**结论：探针与服务重启之间要留间隔**，否则会把启动窗口的失败误读成功能缺陷。

**实测耗时构成**（读的是页面 `performance.getEntriesByType("resource")`，不是估算）：

| 步骤                                                                | 耗时           |
| ------------------------------------------------------------------- | -------------- |
| 换一次性凭据 `api.folo.is/better-auth/one-time-token/generate`      | 840–976 ms     |
| `POST /information/v1/subscription-tags`（建标签）                  | 1438 ms        |
| 换一次性凭据                                                        | 976 ms         |
| `PUT /information/v1/source-tags`（绑定）                           | 1323 ms        |
| 换一次性凭据 + `POST /information/v1/configuration`（重读全量快照） | 840 + ~1500 ms |

原本「点创建 → 看到 chip」要约 7 s，其中 **每个请求都要单独换一次凭据，3 次共约 2.7 s**——这是既有架构的固有成本，`processing-client` 每个请求都调一次 `getOneTimeToken`，Actions 面板同样如此，不是本组件引入的。据此只改了一处：把 chip 的显示提前到 `createTag` 返回时（见 13.2 的「写路径」行）。

#### 13.4.1 改完再验一次（同一晚 23:31，入口 `main-Dr9-NRXd.js`）

上面那次部署的产物**不含**乐观显示那一改，所以改完又重建、重装、重跑了一遍（质量门重跑 35/35）。同一条探针，补了两处断言：chip 出现的耗时，以及**写入链落定后 chip 是否仍在**（落定后 chip 来自服务端快照，留得下来才算真的绑上）。

```text
位置判定：分类(514) < 标签(609) < 私密订阅(717) = true
初始状态 = {"blockText":"…","chips":["计时标签4061"],"placeholder":""}   ← 已有绑定回显（上一轮诊断留下的标签）
输入新名称后 = {"listOpen":true,"createText":"创建「验证标签7949」","optionCount":0}
已点「创建」
  t=2s chips=["计时标签4061","验证标签7949"] alert=null
新标签已挂成 chip = true
点「创建」→ chip 出现耗时 = 2203ms          ← 优化前同一路径实测约 7s
写入链落定后（重读服务端快照）= {"chips":["计时标签4061","验证标签7949"],"alert":null,"inputDisabled":false}
新标签收敛后仍在 chip 里 = true
控件已解除忙态 = true
pageErrors = (none)
```

库内落盘：`source_tag_bindings` 2 行（含 `feed/58374877360520192 -> d60b5112-…` 这条新建标签的绑定）。清理后 `subscription_tags` / `source_tag_bindings` 双双回到 0 行（`revision` 停在 14，不回退）。

**chip 出现耗时 2203 ms 与预测吻合**（`createTag` 返回 ≈ 换凭据 915 ms + `subscription-tags` 1438 ms）：省掉的正是「换凭据 + 绑定 + 换凭据 + 重读」这一串。

#### 13.4.2 一个把自己坑了的探针缺陷（必须记）

chip 一旦提前到 2.2 s 出现，探针就会在 ~3 s 就截图并 `context.close()`——而此刻 `bindTags` 还在飞，**关标签页把请求一起掐掉了**：界面显示两个 chip，库里却只有一条绑定。同一探针在优化前没有这个问题，因为 chip 要 7.5 s、探针收尾时写入早就完成了——**是这次提速暴露了探针的时序假设**。

修法：chip 出现后不能立即收尾，要 `waitForTimeout(15000)` 等写入链落定，再重读一次 chip。这条重读同时把「乐观显示」和「最终落库」两件事都验了：留得下来才算真的绑上。

### 13.5 本轮新增的探针陷阱

**(a) 侧栏的订阅默认折叠在分类里。** 不展开就一个 `[data-feed-id]` 都找不到，只看得到折叠头 `data-sub="feed-category-<name>"`。展开按钮：`button[data-type="collapse"][data-state="close"]`。

**(b) `[data-feed-id]` 上的 `aria-disabled="true"` 是常态，不是多选态。** 它来自 dnd-kit `useSortable()` 的 attributes。Playwright 的 auto-wait 据此判定 "not enabled"，`.click()` 会一直重试到超时；`force: true` 也不能用——force 只跳过 actionability，事件仍走真实 hit-testing，会落到覆盖层上。

**(c) 右键改用合成事件。** 在元素上 `dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window, button: 2, clientX, clientY }))`，绕开坐标与 hit-testing。

**(d) radix 的长菜单可能被弹到视口外。** 此时连 `click({ force: true })` 都报 `Element is outside of the viewport`。可靠做法是对目标菜单项逐一派发 `pointerdown / mousedown / pointerup / mouseup / click`。

**(e) 侧栏右键菜单是「编辑」，不是「编辑订阅」。** `useFeedActions` 的 label 取决于 `isEntryList`：订阅栏右键拿到的是 `sidebar.feed_actions.edit`（=「编辑」）。断言要写成 `/^编辑/`，不能等值比较。

**(f) 标签名渲染在 `input` 的 `value` 里，`value` 不进 `innerText`。** 用「页面文本里有没有这个标签名」判断标签是否创建成功会**误判为失败**（本轮第一版探针就这样错判，白跑一轮）。要么读 `input[aria-label="改名"]` 的 `value`，要么直接查库。

**(g) 探针失败时必须显式 `process.exit()`。** 只在 `.catch` 里设 `process.exitCode = 1` 不会关掉 chromium，进程会一直挂着（本轮两次各挂了 5–7 分钟）。

**(h) 服务重启后立刻跑探针会全量失败。** 见 13.4。判定「服务是否在跑」也不能只靠 HTTP 200——启动窗口里首页可能已经能返回，而 `/information/v1/*` 还在失败。

**(i) 读接口在线上是空体 `POST`，不是 `GET`。** `informationRequestInit()` 会把所有 GET 改成 POST 并加 `X-Folo-Read: 1`。抓包时按 GET 去找会一条都找不到。

**(j) 沙箱里用 Bash 跑 `grep` 会静默返回空。** 本轮 `launchctl list | grep is.folo.local.information` 明明有输出却拿到空、退出码 0，一度误判成服务没起来。判服务状态一律用 `launchctl print gui/$(id -u)/<label>`。

**(k) vitest v4 已移除 `--reporter=basic`。** 传了会直接报 `Failed to load custom Reporter from basic`（连测试都没开始跑）；去掉该参数用默认 reporter 即可。

**(l) 「写下 → 立刻收尾」的探针会掐掉自己在飞的写请求。** 界面上的乐观状态会骗过断言：看到的 chip 是本地画的，`context.close()` 却把 `bindTags` 掐断，库里少一条绑定。见 13.4.2。凡断言「写入成功」，都要**等到写入链落定后再从服务端重读一次**，并且**同时查库**——界面和库是两个独立判据，缺一个都可能假绿。

**(m) 用界面文本判断「删干净了没有」同样会骗人。** 删完一行后面板重读快照可能失败、列表显示为空，但库里还留着一行。本轮实测：面板显示 `[]` 时库里还有 2 个标签。删除类操作一律**以查库为准**。
