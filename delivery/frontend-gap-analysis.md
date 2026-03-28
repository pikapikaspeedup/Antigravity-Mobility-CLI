# Project 用户旅程前端差距分析报告

> 日期：2026-06-22  
> 范围：Project 创建 → 调度 → 执行监控 → 子项目导航 → 控制流操作 → 结果审计  
> 方法：逐文件精读 src/components/*、src/lib/types.ts、src/lib/api.ts 及后端 API 路由

---

## 一、整体评估

当前前端在 **Project 基本生命周期**（创建/编辑/删除/存档/调度/恢复）上实现完整，在 **V5.3 AI 管道生成** 上表现出色。但在以下三个维度存在系统性差距：

| 维度 | 严重程度 | 说明 |
|------|---------|------|
| 子项目可见性 | 🔴 严重 | 导航链路断裂，用户无法从父项目追踪到子项目 |
| 控制流节点交互 | 🔴 严重 | Gate 审批只能看不能操作，Checkpoint/Journal 完全无 UI |
| 平台化功能可见性 | 🟡 中等 | Subgraph、Resource Policy 已有 API 但零 UI |

---

## 二、现有能力盘点

在报告差距之前，先确认已经做到位的部分：

### 2.1 做得好的

| 组件 | 能力 | 评价 |
|------|------|------|
| `projects-panel.tsx` | 项目 CRUD、条件渲染 Workbench/进度条、AI 生成入口 | ✅ 完整 |
| `pipeline-stage-card.tsx` | 阶段状态、角色子节点、fan-out 分支子节点、V5.2 nodeKind 徽章（gate/loop/switch） | ✅ 良好 |
| `project-workbench.tsx` | 三标签页架构（Timeline / DAG / Ops）、阶段/角色选中与右面板联动 | ✅ 结构合理 |
| `stage-detail-panel.tsx` | 执行摘要、产出物、决策、阻塞器、干预按钮（nudge/restart/cancel/skip）、AI 诊断 | ✅ 丰富 |
| `project-ops-panel.tsx` | 项目健康度、阶段诊断、分支诊断、Reconcile dry-run/execute、审计日志 | ✅ 实用 |
| `pipeline-generate-dialog.tsx` | AI 生成完整流程：输入→生成→预览（风险+节点+验证）→确认 | ✅ 最完整的 V5 功能 |
| `project-dag-view.tsx` | Kahn 拓扑排序 → SVG 渲染、状态着色、fan-out 分支计数 | ✅ 基础可用 |

### 2.2 前端类型系统覆盖

`types.ts` 中已定义的 V5 类型：

- `PipelineStageProgressFE.nodeKind` — gate / switch / loop-start / loop-end ✅
- `PipelineStageProgressFE.gateApproval` — 审批状态结构 ✅
- `PipelineStageProgressFE.loopIteration` — 循环迭代计数 ✅
- `PipelineStageProgressFE.switchSelectedBranch` — 条件分支选中 ✅
- `ProjectPipelineStateFE.lastCheckpointId` — checkpoint 引用 ✅
- `SubgraphSummaryFE / ResourcePolicyFE / PolicyEvalResultFE` — V5.4 类型 ✅
- `GenerationResultFE / ConfirmResultFE / RiskAssessmentFE` — V5.3 类型 ✅

类型系统准备充分，但许多类型在 UI 层没有消费者。

---

## 三、差距详析

### 3.1 🔴 子项目可见性 — 导航链路断裂

**问题核心**：fan-out 节点会创建子项目（childProject），后端数据模型完整（`Project.childProjectIds`、`BranchProgressFE.subProjectId`、`parentProjectId`），但前端导航链路在最后一步断开。

**具体发现**：

1. **`pipeline-stage-card.tsx` 已实现分支导航按钮**：
   ```tsx
   // 第 339-346 行：当 branch.subProjectId 存在时显示 ExternalLink 图标按钮
   {branch.subProjectId && onNavigateToProject && (
     <button onClick={() => onNavigateToProject(branch.subProjectId)}>
       <ExternalLink />
     </button>
   )}
   ```
   该按钮仅在 hover 时出现，交互可发现性低。

2. **`project-workbench.tsx` 没有传递 `onNavigateToProject`**：
   ```tsx
   // 第 242-255 行：渲染 PipelineStageCard 时未传递该 prop
   <PipelineStageCard
     stage={stage}
     stageTitle={...}
     isSelected={...}
     isCurrentStage={...}
     roles={...}
     onClick={...}
     onSelectRole={...}
     // ❌ 缺少 onNavigateToProject={...}
   />
   ```
   这意味着即使 `pipeline-stage-card` 已经写好了导航逻辑，在实际渲染中按钮**永远不会出现**（因为 `onNavigateToProject` 为 `undefined`，条件判断 `onNavigateToProject &&` 为 false）。

3. **`projects-panel.tsx` 无父子关系可视化**：
   - `Project.childProjectIds?: string[]` 已定义但零引用
   - 项目列表是扁平的，没有树形结构或缩进
   - 没有 "parent project" 面包屑导航
   - 子项目没有标记（如 "↳ 派生自 xxx"）

4. **无 "返回父项目" 路径**：当用户通过某种方式（如 URL）进入子项目后，无法看到它与父项目的关系，也无法返回。

**影响**：用户使用 fan-out 模板时，看到"Branches 2/3"计数器，但无法点击进入任何子项目查看其执行详情。子项目在 UI 中完全不可见——它们只存在于后端。

**修复建议**：
- P0：`project-workbench.tsx` 将 `onNavigateToProject` 接通（从 `ProjectsPanel` 传入 `onSelectProject`）
- P0：`projects-panel.tsx` 子项目标记 + 父项目面包屑
- P1：项目列表支持缩进式树形展示（parent → children）

---

### 3.2 🔴 Gate 审批 — 只读状态无操作能力

**问题核心**：Gate 节点的审批状态已经能**展示**（`pipeline-stage-card.tsx` 第 200-213 行的 gate 徽章），但用户无法**操作**（approve/reject）。

**具体发现**：

1. **后端已就绪**：
   - 路由 `src/app/api/projects/[id]/gate/[nodeId]/approve/route.ts` 存在
   - 完整的 approve/reject 逻辑

2. **API 客户端缺失**：`src/lib/api.ts` 中**没有** `gateApprove()` 函数
   - 所有 V4.4-V5.4 的其他 API 都有对应的客户端函数
   - 这个是唯一的遗漏

3. **UI 无操作按钮**：
   - `pipeline-stage-card.tsx` 展示 "Awaiting approval" / "Approved" / "Rejected" 文字 ✅
   - `stage-detail-panel.tsx` 的干预按钮区域只有 nudge/restart/cancel/skip ❌
   - 没有 "Approve" / "Reject" 按钮

**影响**：当 pipeline 执行到 Gate 节点暂停等待人工审批时，用户在 UI 上看到 "Awaiting approval" 但无法采取行动。只能通过 CLI/MCP/直接 HTTP 调用来审批，这严重破坏了 GUI 用户的工作流。

**修复建议**：
- P0：`api.ts` 添加 `gateApprove(projectId, nodeId, { approved, reason })` 函数
- P0：`stage-detail-panel.tsx` 在 `stage.nodeKind === 'gate' && stage.gateApproval?.status === 'pending'` 时渲染 Approve / Reject 按钮

---

### 3.3 🔴 Checkpoint / Replay — 完全无 UI

**问题核心**：V5.2 引入了 checkpoint/replay 机制，后端完整实现，但前端零覆盖。

**具体发现**：

1. **后端已就绪**：
   - `src/app/api/projects/[id]/replay/route.ts` — POST 接口，支持 `checkpointId` 参数
   - `checkpoint-manager.ts` — `listCheckpoints()` / `restoreFromCheckpoint()` 完整实现

2. **类型已就绪**：
   - `ProjectPipelineStateFE.lastCheckpointId?: string` — 最近 checkpoint 引用已暴露

3. **API 客户端缺失**：`api.ts` 中没有 `listCheckpoints()` 和 `replay()` 函数

4. **UI 完全缺失**：
   - 没有 checkpoint 列表/时间线
   - 没有 "Replay from here" 按钮
   - 没有 checkpoint 状态指示器
   - `project-ops-panel.tsx` 的诊断区域没有展示 checkpoint 信息

**影响**：用户无法从 UI 查看 pipeline 的 checkpoint 历史，也无法触发 replay。这在复杂 pipeline 出错时尤为关键——用户需要回滚到某个已知好的状态。

**修复建议**：
- P1：`api.ts` 添加 `listCheckpoints(projectId)` 和 `replayFromCheckpoint(projectId, checkpointId?)` 函数
- P1：`project-ops-panel.tsx` 添加 "Checkpoints" 子面板：列表展示、时间线、点击 replay
- P2：`project-workbench.tsx` Timeline 视图中在每个完成的 stage 边上显示 checkpoint 标记

---

### 3.4 🔴 Execution Journal — 完全无 UI

**问题核心**：V5.2 的执行日志（Journal）记录了所有控制流决策——gate 判定、switch 条件评估、loop 迭代进入/退出、checkpoint 创建——但前端无法查看。

**具体发现**：

1. **后端已就绪**：
   - `src/app/api/projects/[id]/journal/route.ts` — GET 接口，支持 nodeId/kind/since/limit 过滤
   - `execution-journal.ts` — `queryJournal()` / `getNodeJournal()` 完整实现

2. **API 客户端缺失**：`api.ts` 中没有 `queryJournal()` 函数

3. **UI 完全缺失**：没有日志查看器

**影响**：用户无法理解 pipeline 的控制流决策历史——为什么 switch 选了这个分支？gate 是谁在什么时候批准的？loop 经过了几轮？这些关键调试信息只能通过 API/CLI 查看。

**修复建议**：
- P1：`api.ts` 添加 `queryJournal(projectId, filters?)` 函数
- P1：在 `project-ops-panel.tsx` 添加 "Journal" 子面板，支持按 nodeId/kind 过滤，时间线展示
- P2：`stage-detail-panel.tsx` 对控制流节点（gate/switch/loop）展示关联的 journal 条目

---

### 3.5 🟡 DAG 视图 — 节点类型无差异化渲染

**问题核心**：`project-dag-view.tsx` 对所有节点使用相同的矩形渲染，仅通过 `stageType` 文字区分。

**具体发现**：

1. **所有节点外观一致**：
   ```tsx
   // 第 211 行：只展示 stageType 文字
   <span className="uppercase tracking-wider">{node.stageType}</span>
   ```
   没有使用不同形状（菱形表示 gate、六边形表示 switch、圆角矩形表示 loop 等）

2. **GraphNode 类型无 `nodeKind`**：
   ```ts
   // api.ts 第 51-59 行
   export interface GraphNode {
     stageId: string;
     groupId: string;
     stageType: string; // "normal" | "fan-out" | "join" — 只有旧类型
     status: string;
     active: boolean;
     branchCompleted?: number;
     branchTotal?: number;
   }
   ```
   `GraphNode` 没有 `nodeKind` 字段（gate/switch/loop-start/loop-end），而 `PipelineStageProgressFE` 有。这导致 DAG 视图无法区分控制流节点。

3. **边无条件标注**：switch 的条件分支、gate 的通过/拒绝路径没有标签

4. **`showDagTab` 条件不完整**：
   ```tsx
   // project-workbench.tsx 第 83 行
   const showDagTab = useMemo(() => {
     if (!template?.pipeline) return false; // ❌ graphPipeline 模板直接返回 false
     return template.pipeline.some(s => s.stageType === 'fan-out' || s.stageType === 'join');
   }, [template]);
   ```
   使用 graphPipeline 格式的模板永远不会显示 DAG 标签页，因为 `TemplateSummaryFE` 没有 `graphPipeline` 字段。实际上，graphPipeline 本身就是图形结构，**更需要** DAG 可视化。

**影响**：DAG 视图目前只在使用旧 `pipeline[]` 格式且包含 fan-out/join 的模板中出现，且所有节点外观相同。这对理解复杂控制流图帮助有限。

**修复建议**：
- P1：`TemplateSummaryFE` 添加 `format: 'pipeline' | 'graphPipeline'` 字段
- P1：`showDagTab` 对 graphPipeline 格式的模板永远返回 true
- P1：`GraphNode` 添加 `nodeKind` 字段，DAG 视图使用不同形状/图标渲染不同节点类型
- P2：边添加条件标注（switch 的分支名、gate 的批准/拒绝路径）

---

### 3.6 🟡 V5.4 Subgraph — API 就绪但零 UI

**具体发现**：

- `api.listSubgraphs()` 存在 ✅
- `SubgraphSummaryFE` 类型定义完整（id/title/description/nodeCount/inputs/outputs）✅
- **没有任何 UI 组件消费这些数据** ❌

**修复建议**：
- P2：新建 Subgraph 浏览面板（可放在侧边栏或模板管理区）
- P2：DAG 视图中对 `subgraph-ref` 节点渲染为可折叠/展开的子图

---

### 3.7 🟡 V5.4 Resource Policy — API 就绪但零 UI

**具体发现**：

- `api.listPolicies()` / `api.createPolicy()` / `api.checkPolicy()` 存在 ✅
- `ResourcePolicyFE` / `PolicyRuleFE` / `PolicyViolationFE` / `PolicyEvalResultFE` 类型完整 ✅
- **没有任何 UI 组件消费这些数据** ❌
- 项目执行过程中触发的 policy violation 没有任何视觉提示

**修复建议**：
- P2：新建 Policy 管理页面（CRUD + scope 筛选）
- P1：`project-ops-panel.tsx` 或 Pipeline 进度条上展示活跃的 policy violation 警告
- P2：Pipeline 调度前检查 policy，在 dispatch dialog 中显示 violation 阻止

---

### 3.8 🟡 模板管理 — 零可视化

**具体发现**：

- `api.lintTemplate()` / `api.validateTemplate()` / `api.convertTemplate()` 存在 ✅
- 但前端没有模板编辑器/查看器
- 没有 lint 按钮、validate 按钮、格式转换操作
- `TemplateSummaryFE` 只有 `pipeline[]`，没有 `graphPipeline` 字段，丢失了模板的完整信息

**修复建议**：
- P2：Template 查看器（JSON/YAML 渲染 + DAG 预览）
- P2：Lint/Validate 一键操作
- P3：Pipeline ↔ GraphPipeline 格式转换 UI

---

## 四、API 客户端覆盖差距汇总

| 后端端点 | `api.ts` 函数 | UI 消费者 |
|----------|:------------:|:--------:|
| `POST /api/projects/:id/gate/:nodeId/approve` | ❌ 缺失 | ❌ 无 |
| `GET /api/projects/:id/journal` | ❌ 缺失 | ❌ 无 |
| `POST /api/projects/:id/replay` | ❌ 缺失 | ❌ 无 |
| `GET /api/pipelines/subgraphs` | ✅ `listSubgraphs` | ❌ 无 |
| `GET /api/pipelines/policies` | ✅ `listPolicies` | ❌ 无 |
| `POST /api/pipelines/policies` | ✅ `createPolicy` | ❌ 无 |
| `POST /api/pipelines/policies/check` | ✅ `checkPolicy` | ❌ 无 |
| `POST /api/pipelines/lint` | ✅ `lintTemplate` | ❌ 无 |
| `POST /api/pipelines/validate` | ✅ `validateTemplate` | ❌ 无 |
| `POST /api/pipelines/convert` | ✅ `convertTemplate` | ❌ 无 |

**3 个端点完全无前端覆盖（连 API 客户端函数都没有），7 个端点有 API 客户端但无 UI 消费者。**

---

## 五、优先级矩阵

### P0 — 阻断核心用户流程

| # | 修复项 | 工作量估算 | 影响 |
|---|--------|-----------|------|
| 1 | 接通 `onNavigateToProject` — workbench → stageCard → projectsPanel | S | 解锁子项目导航 |
| 2 | 添加 `api.gateApprove()` + Gate 审批按钮 | S | 解锁 Gate 人工审批流 |
| 3 | 项目列表展示 parent/child 关系标记 | M | 子项目可见性 |

### P1 — 显著提升可观测性

| # | 修复项 | 工作量估算 | 影响 |
|---|--------|-----------|------|
| 4 | Checkpoint 列表 + Replay 按钮（OpsPanel 扩展）| M | 容错/回滚能力 |
| 5 | Journal 查看器（OpsPanel 扩展）| M | 控制流审计 |
| 6 | DAG 节点类型差异化渲染（形状/图标/颜色）| M | 图可读性 |
| 7 | `showDagTab` 支持 graphPipeline 格式 | S | 确保新格式可用 |
| 8 | Policy violation 警告展示 | S | 风险提示 |

### P2 — 平台化完整性

| # | 修复项 | 工作量估算 | 影响 |
|---|--------|-----------|------|
| 9 | Subgraph 浏览面板 | M | V5.4 前端覆盖 |
| 10 | Policy 管理页面 | L | V5.4 前端覆盖 |
| 11 | Template 查看器 + lint/validate | L | 模板可管理性 |
| 12 | DAG 边条件标注 | S | 辅助理解 |

工作量：S = 1-2h, M = 3-5h, L = 1-2d

---

## 六、用户旅程缺口可视化

```
用户操作                    现有前端              差距
─────────────────────────────────────────────────────────
创建 Project            ✅ CreateDialog         —
选择 Template           ✅ Select 下拉框        🟡 无法看到模板是 pipeline 还是 graphPipeline
调度 Pipeline           ✅ DispatchDialog       🟡 不检查 Resource Policy
查看 Timeline           ✅ PipelineStageCard    —
查看 DAG                ⚠️ 仅 pipeline[] 格式   🔴 graphPipeline 格式不显示 DAG
到达 Gate 节点          ✅ 看到 "Awaiting"      🔴 无法点击 Approve/Reject
到达 Switch 节点        ✅ 看到 "→ branch-a"    🟡 无条件表达式展示
到达 Loop 节点          ✅ 看到 "Iteration 3"   🟡 无 max/当前进度
Fan-out 展开            ✅ 看到 Branches 2/3    🔴 无法点进子项目
查看子项目详情          ❌ 完全不可达            🔴 导航断裂
查看 Checkpoint 历史    ❌ 无 UI                 🔴 无法列出/选择/回滚
查看执行 Journal        ❌ 无 UI                 🔴 无法审计控制流决策
管理 Resource Policy    ❌ 无 UI                 🟡 只能通过 CLI
浏览 Subgraph 库        ❌ 无 UI                 🟡 只能通过 CLI
模板 Lint/Validate      ❌ 无 UI                 🟡 只能通过 CLI
```

---

## 七、结论

前端在 V4 级别的 Pipeline 执行监控上做得**扎实**——阶段卡片、角色展开、进度条、干预操作、AI 诊断都已到位。V5.3 的 AI 管道生成 Dialog 也是最完整的 V5 前端功能。

但 V5.0-V5.4 引入的**图形编排能力**（graphPipeline、gate/switch/loop、checkpoint/journal、subgraph、policy）在前端存在系统性落后。后端和 API 类型系统已经为这些功能准备了完整的数据通道，前端只需"接最后一公里"——最致命的 P0 差距（子项目导航断裂、Gate 审批无按钮）甚至只需要几行代码就能修复。

建议立即处理 3 个 P0 项（总计 ~4h），然后在下一迭代集中攻克 P1 的 Checkpoint/Journal/DAG 增强（~2d），最终在平台化阶段补齐 P2 的管理界面。
