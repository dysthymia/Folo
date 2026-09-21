# Folo AI 处理 · v3.2 开发输入

**用途**：把外部评审（`~/Downloads/区块链投资&交易 - 改造交易系统-round-2.md`）的方向性意见，与对源码的逐条核查结果合并，转成下一轮可直接施工的输入。不是新计划书，不扩功能。
**基准提交**：`codex/web-actions-ai-v3` @ `32c2c8c3c`（评审所依据的同一提交）。
**证据边界**：静态源码核对 + 只读健康探测（`local.folo.is`、`127.0.0.1:2240`、`127.0.0.1:2233`）。**未运行测试套件、未做真机交互验证**。凡涉及部署状态与语义质量的结论，只引用 `docs/information-v3.1-progress.md` 与 `docs/information-runtime-status.json`。

---

## 0. 结论

- 评审方向可用：**自动化负责配置，时间线负责阅读，后台负责执行**。五项收敛的优先级排序合理，本轮不应再加功能。
- 直接照它开工前必须补三件事：一条架构决策（§2 D1）、一张能力矩阵（§2 D2）、一套可判定验收标准（§6）。
- **§2 的 D1–D5 已全部决议**（D5 于 2026-09-21 早先决议，D2/D3/D4 于同日补齐）。本轮按 §7 施工到第三轮，出口是 §6 三场景验收；**未验收 ≠ 可删除**，台账 U01–U14 仍需单独确认。
- 评审有三处需要修正（§3），另有一处会改变施工方案的遗漏（§1.2）。
- **未验收 ≠ 可删除**。台账 U01–U14 全为"未验收"，这既不构成功能失效，也不构成重写许可。

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

- [ ] 配置侧：自动化主界面只有"条件／处理方式／启停"，无需选择执行位置即可保存启用。
- [ ] 阅读侧：在时间线该社交视图的"AI 处理后"中，短帖与娱乐内容为 0；切到"原始内容"同一范围计数恢复。
- [ ] 可追溯：被隐藏条目仍能在条目详情看到原文与处理理由（含命中规则）。
- 不通过：需要用户到计划里重复选一次来源；或隐藏只能靠"标记全部已读"且无法恢复未读。

**场景二 · Blockchain 同事件综述**

- [ ] 在 Blockchain 分类列表**内**直接看到整合条目，不跳页；条目显示来源数 ≥2、句段引用、更新时间。
- [ ] 项目方公告类订阅的条目仍单独可见（例外生效）。
- [ ] 正文保留分歧：可抽查 ≥2 个来源的相反表述，引用通过连续原文校验。
- [ ] 对该 Story 标记已读后，原文 read 状态不变（对应 §5.2）。
- 不通过：整合结果只能在信息工作台看到；或必须先理解 `ai_transform` 与 `ai_aggregate` 的差别才能建该规则。

**场景三 · 读前准备**

- [ ] 关闭浏览器后，计划时点仍产生 scheduled 记录（引用运行记录）。
- [ ] 重新打开同一分类，"AI 处理后"直接可用，无需先发布；有草稿时明确提示"当前使用已生效版本 vN"。
- [ ] 切换标签页再回来，页码／滚动位置／所选条目保持，不回到偏移 0。
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

1. **场景二连数据前提都没有**：库里 story 数为 0，18 条角色全是 `hidden`，没有任何 `story` / `merged` / `keeper`。综述摘要（`GET /processing/stories/:storyId/digest`）与内联面板**只有 fixture 单测证据**，没有一条真实综述端到端走通过。要判定场景二，必须先发布一条聚合规则并让某分类真跑出一篇综述。
2. **场景三的「保存并启用」未在界面核对**：账号下没有任何自动化规则，统一列表与详情都无从渲染。「一次动作后 AI 处理后可用」「有草稿时提示当前使用已生效版本 vN」仍只有代码与单测证据。
3. **场景一的「计数恢复」未在界面核对**：两态控件确实在，但没有一条被隐藏的条目落在可滚动窗口内（滚 14 屏无带角色的条目），因此看不到计数变化。
4. **工作台「已隐藏 0 条」与角色投影 18 条不一致**：口径分歧已存在（角色取全部 input、快照取计划范围），需决定是否统一。
5. **既有计划记录会被读成「固定名单」**：库里的旧计划是 `{mode:"fixed",sourceKeys:[22]}`。旧记录无法区分「用户选的是全部订阅」还是「手挑的 22 个来源」，因此它现在显示为「固定名单，不会自动纳入新来源」。这是 D4 向后兼容的必然结果，但用户需要自己重选一次「全部订阅」才会开始自动纳入——**属于需要告知的行为变化，不是 bug**。
6. **`{mode:"category"}` 的「自动纳入新来源」未验证**：处理服务不知道 Folo 的 view/category 体系，靠客户端用共享解析器解析后把名单落库、重开页面时再解析并写回。这条「自动纳入」的实际效果尚未真机确认（见 §2 D4 的允许偏离）。
7. **`/tmp/folo-v32-verify/`** 下的验收脚本与截图是临时产物，未纳入仓库；若要长期留存证据需另找位置。
