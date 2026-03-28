# 前端用户旅程差距分析 V2（V4.4 → V5.4）

> 日期：2025-01  
> 范围：仅统计**后端 API 路由已实现、但前端缺少 api.ts 客户端函数或 UI 组件**的业务场景  
> 前一版 P0/P1 增强项已全部完成，本报告列出仍然缺失的前端能力  
> **更新：本报告中所列 P0/P1/P2 项已全部实现，详见各场景下的"✅ 已完成"标记**

---

## 一、后端 Route → api.ts → 前端 UI 对照矩阵

### 1. ~~完全没有接入（Route ✅ → api.ts ❌ → UI ❌）~~ ✅ 已全部接入

| # | 后端路由 | 版本 | 功能 | 状态 |
|---|---------|------|------|------|
| 1 | `GET /api/projects/[id]/journal` | V5.2 | 查询 Execution Journal | ✅ `api.queryJournal()` + Ops Journal panel |
| 2 | `GET /api/projects/[id]/checkpoints` | V5.2 | 列出项目所有 checkpoint | ✅ `api.listCheckpoints()` + Ops Checkpoints panel |
| 3 | `POST /api/projects/[id]/checkpoints` | V5.2 | 手动创建 checkpoint | ✅ `api.createCheckpoint()` + Create Checkpoint 按钮 |
| 4 | `POST /api/projects/[id]/checkpoints/[cpId]/restore` | V5.2 | 从指定 checkpoint 恢复 | ✅ `api.restoreCheckpoint()` + Restore 按钮 |
| 5 | `POST /api/projects/[id]/replay` | V5.2 | 从 checkpoint replay | ✅ `api.replayProject()` + Replay 按钮 |

### 2. ~~有 api.ts 函数但无 UI 消费者~~ ✅ 已全部接入（#11 除外）

| # | api.ts 函数 | 版本 | 状态 |
|---|------------|------|------|
| 6 | `api.validateTemplate()` | V4.4 | ✅ 替换了 Dispatch 对话框中的 `lintTemplate()`，显示 format + contract 错误 |
| 7 | `api.convertTemplate()` | V5.1 | ✅ Dispatch 对话框增加 Convert 按钮，支持 pipeline↔graphPipeline 转换 |
| 8 | `api.getDraft()` | V5.3 | ✅ pipeline-generate-dialog 增加 Recover Draft 按钮 + localStorage 缓存 |
| 9 | `api.listPolicies()` | V5.4 | ✅ PolicyPanel 组件展示策略列表 |
| 10 | `api.createPolicy()` | V5.4 | ✅ PolicyPanel 组件支持创建策略 |
| 11 | `api.agentGroups()` | 基础 | ⏳ 暂未处理（无明确用户需求） |

---

## 二、按用户旅程场景描述缺失能力

### 场景 A：Execution Journal（执行日志审计）— 缺失 #1

**当前状态**：后端 `execution-journal.ts` 记录所有运行时控制流事件（gate 决策、loop 迭代、switch 选择），并通过 `GET /api/projects/[id]/journal` 暴露查询 API。前端完全没有 API 客户端函数，也没有任何可视化。

**用户影响**：用户无法查看项目运行过程中 gate 为什么被批准/拒绝、loop 跑了几轮、switch 选了哪条路径等决策细节。Pipeline stage card 只有最终状态，无法追溯过程。

**需要做的**：
1. api.ts 增加 `queryJournal(projectId, params)` 函数
2. project-workbench 的 Ops tab 或新增 Journal sub-tab，展示时间线视图，按事件类型（gate:decided / loop:iteration / switch:evaluated 等）分类显示

---

### 场景 B：Checkpoint 管理与回滚 — 缺失 #2-5

**当前状态**：后端 `checkpoint-manager.ts` 实现了 checkpoint 的创建、列表、恢复功能，以及 replay（从 checkpoint 重放）功能。四个路由全部可用。`ProjectPipelineStateFE` 类型中已有 `lastCheckpointId` 和 `loopCounters` 字段。前端没有 API 客户端函数，没有 UI。

**用户影响**：当 pipeline 执行出错时，用户只能用 resume（重试当前 stage）。不能回滚到之前某个正常状态，也不能 replay（从检查点重新开始执行）。高级版本的容错能力完全没有暴露给用户。

**需要做的**：✅ 已完成
1. ✅ api.ts 增加 `listCheckpoints()` / `createCheckpoint()` / `restoreCheckpoint()` / `replayProject()` 四个函数
2. ✅ project-ops-panel 增加 "Checkpoints" section：列表、Create Checkpoint、Restore、Replay 按钮

---

### 场景 C：Template Validate（完整校验）vs Lint（轻量检查）— ~~缺失~~ ✅ 已完成 #6

**实现**：Dispatch 对话框 Validate 按钮改为调用 `validateTemplate()`，结果显示 DAG/contract 错误详情 + format 标签（pipeline/graphPipeline）。

---

### 场景 D：Template Format 转换 — ~~缺失~~ ✅ 已完成 #7

**实现**：Dispatch 对话框中 validate 通过后显示 "Convert to graphPipeline/pipeline" 按钮，调用 `convertTemplate()`。

---

### 场景 E：AI 草稿重新查看 — ~~缺失~~ ✅ 已完成 #8

**实现**：pipeline-generate-dialog 生成成功时将 draftId 存入 localStorage，confirm 后清除。打开对话框时若有缓存的 draftId，显示 "Recover Draft" 按钮调用 `getDraft()` 恢复预览。

---

### 场景 F：资源策略 CRUD — ~~缺失~~ ✅ 已完成 #9-10

**实现**：新增 `policy-panel.tsx` 组件，集成到侧边栏 Operations 区域。支持：
- 策略列表（按 scope 着色：workspace=purple, template=sky, project=amber）
- 展开查看 rules 详情
- 创建策略表单（name + scope + targetId + rules 编辑器）

---

## 三、已存在但可见性不足的数据字段

| 字段 | 位置 | 现状 | 建议 |
|------|------|------|------|
| `template.format` | TemplateSummaryFE | ✅ Validate 结果中已显示 | — |
| `pipelineState.lastCheckpointId` | ProjectPipelineStateFE | ✅ Checkpoints section 间接可见 | — |
| `pipelineState.loopCounters` | ProjectPipelineStateFE | 只在 stage card nodeKind=loop-start/loop-end 时显示 | 可考虑在 DAG 节点上叠加（P3） |

---

## 四、优先级与完成状态

| 优先级 | 场景 | 状态 |
|--------|------|------|
| **P0** | B – Checkpoint 管理与回滚 | ✅ 已完成 |
| **P0** | A – Execution Journal | ✅ 已完成 |
| **P1** | C – validateTemplate 替换 lint | ✅ 已完成 |
| **P1** | F – 资源策略 CRUD | ✅ 已完成 |
| **P2** | D – Template 格式转换 | ✅ 已完成 |
| **P2** | E – AI 草稿恢复 | ✅ 已完成 |
| **P3** | DAG 节点 loopCounter 叠加 | ⏳ 未处理 |
| **—** | `api.agentGroups()` 分组管理 | ⏳ 暂无需求 |

---

## 五、总结

~~上一轮修复了 3 个 P0 缺陷和 6 个增强项后，**剩余最大的前端差距集中在 V5.2 的 Execution Journal 和 Checkpoint 两个子系统**。~~

**全部 P0/P1/P2 差距已修复。** 涉及改动的文件：

- `src/lib/api.ts` — 增加 5 个 V5.2 函数（queryJournal, listCheckpoints, createCheckpoint, restoreCheckpoint, replayProject）
- `src/lib/types.ts` — 增加 JournalEntryFE、CheckpointFE 类型
- `src/components/project-ops-panel.tsx` — 增加 Execution Journal + Checkpoints 两个 section
- `src/components/projects-panel.tsx` — validateTemplate 替换 lintTemplate + Convert 按钮
- `src/components/policy-panel.tsx` — 新增策略管理面板
- `src/components/sidebar.tsx` — 集成 PolicyPanel
- `src/components/pipeline-generate-dialog.tsx` — Recover Draft 功能

剩余未处理项为 P3 级别的信息展示优化和无明确需求的 `agentGroups()` 分组管理。
