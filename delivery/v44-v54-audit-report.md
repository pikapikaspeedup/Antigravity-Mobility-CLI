# V4.4 ~ V5.4 Phase 1 开发计划落地审计报告

> 审计日期：2026-03-28  
> 审计范围：V4.4 Typed Contracts → V5.4 Phase 1 (可复用子图 + 成本配额)  
> 审计方法：逐项对照开发计划文档，检查源码文件、类型定义、API 路由、MCP 工具注册、单元测试  
> 测试结果：18 个测试文件，288 个 test case，全部通过（本地 vitest run，914ms）

---

## 总体结论

| 版本 | 计划状态 | 落地状态 | 源码 | 测试 | API | MCP |
|:-----|:---------|:---------|:-----|:-----|:----|:----|
| V4.4 Typed Contracts | 设计完成 | ✅ 已落地 | ✅ | ✅ | ✅ | ✅ |
| V5.0 Unified DAG IR | 设计完成 | ✅ 已落地 | ✅ | ✅ | ✅ | — |
| V5.1 Graph Authoring | 设计完成 | ✅ 已落地 | ✅ | ✅ | ✅ | ✅ |
| V5.2 Controlled Dynamic Flow | 设计完成 | ✅ 已落地 | ✅ | ✅ | ✅ | ✅ |
| V5.3 AI-Assisted Design | 设计完成 | ✅ 已落地 | ✅ | ✅ | ✅ | ✅ |
| V5.4 Phase 1 | 设计完成 | ✅ 已落地 | ✅ | ✅ | ✅ | ✅ |

**全部版本的计划交付物均已落地，无遗漏项。**

---

## V4.4 — Typed Contracts

### 计划 vs 实际

| 计划交付物 | 文件 | 状态 |
|:-----------|:-----|:-----|
| `contract-types.ts` — StageContract / ArtifactExpectation / ArtifactPromise / FanOutContract / JoinMergeContract / JsonSchema / ContractValidationResult | `src/lib/agents/contract-types.ts` | ✅ |
| `contract-validator.ts` — `validateTemplateContracts()` + 5 条校验规则 | `src/lib/agents/contract-validator.ts` | ✅ |
| `pipeline-types.ts` 扩展 — PipelineStage 新增 `contract` / `fanOutContract` / `joinMergeContract` | `src/lib/agents/pipeline-types.ts` L28-33 | ✅ |
| `pipeline-graph.ts` 集成 — `validateTemplatePipeline()` 内调用 `validateTemplateContracts()` | `src/lib/agents/pipeline-graph.ts` L64-65 | ✅ |
| `asset-loader.ts` — 加载时自动校验 | 通过 `getOrCompileIR()` → `validateTemplatePipeline()` 调用链 | ✅ |
| `project-diagnostics.ts` — `StageDiagnostics.contractIssues` 诊断 | `src/lib/agents/project-diagnostics.ts` L46, L122-123 | ✅ |
| `POST /api/pipelines/lint` — Lint API | `src/app/api/pipelines/lint/route.ts` | ✅ |
| MCP `antigravity_lint_template` | `src/mcp/server.ts` L341-343 | ✅ |
| 单元测试 | `contract-validator.test.ts` | ✅ 通过 |

### 校验规则清单

| # | 规则 | 实现 |
|:--|:-----|:-----|
| 1 | Output→Input 兼容性（upstream outputContract 满足 downstream inputContract） | ✅ `checkOutputInputCompat()` |
| 2 | Fan-out 契约对齐（workPackageSchema ↔ branch inputContract） | ✅ `checkFanOutContracts()` |
| 3 | Join merge 契约对齐（branchOutputContract ↔ downstream inputContract） | ✅ `checkJoinMergeContracts()` |
| 4 | Artifact 路径冲突 + id 唯一性检测 | ✅ `checkArtifactConflicts()` |
| 5 | stageType ↔ contract 一致性（非 fan-out 有 fanOutContract → warning） | ✅ `checkStageTypeConsistency()` |

---

## V5.0 — Unified DAG IR

### 计划 vs 实际

| 计划交付物 | 文件 | 状态 |
|:-----------|:-----|:-----|
| `dag-ir-types.ts` — DagNodeKind / DagNode / DagEdge / DagIR / DagNodeActivation | `src/lib/agents/dag-ir-types.ts` | ✅ |
| `dag-compiler.ts` — `compilePipelineToIR()` + `compileTemplateToIR()` + IR 缓存 | `src/lib/agents/dag-compiler.ts` | ✅ |
| `dag-runtime.ts` — `canActivateNode()` / `getDownstreamNodes()` / `getActivatableNodes()` / `filterSourcesByNode()` | `src/lib/agents/dag-runtime.ts` | ✅ |
| `pipeline-registry.ts` 改为 IR 转发 | `src/lib/agents/pipeline-registry.ts` L8-9, L37-58 | ✅ |
| `project-reconciler.ts` 基于 IR | `src/lib/agents/project-reconciler.ts` L3-4, 多处 `getOrCompileIR()` 调用 | ✅ |
| `project-diagnostics.ts` 基于 IR + `buildProjectGraph()` 从 IR 映射 | `src/lib/agents/project-diagnostics.ts` L5, L105, L179, L200, L237, L409 | ✅ |
| 格式自动检测（graphPipeline 优先） | `dag-compiler.ts` L31-36 | ✅ |
| IR 缓存 `getOrCompileIR` + `invalidateIRCache` | `dag-compiler.ts` L13-28 | ✅ |
| 单元测试 | `dag-compiler.test.ts`, `dag-runtime.test.ts` | ✅ 通过 |

### 架构约束验证

| 约束 | 遵守 |
|:-----|:-----|
| 只有一个内部运行时（DagIR） | ✅ |
| IR 是内部结构，不在 API 返回值中 | ✅ |
| pipeline[] 不废弃 | ✅ |
| IR 编译确定性（同一 template → 相同 IR） | ✅ |
| IR 不在运行时动态修改 | ✅ |

### Consumer 迁移检查

| Consumer | IR 迁移 |
|:---------|:--------|
| `pipeline-registry.ts` → `canActivateNode()` / `getDownstreamNodes()` / `filterSourcesByNode()` | ✅ |
| `project-reconciler.ts` → `getOrCompileIR()` + `canActivateNode()` | ✅ |
| `project-diagnostics.ts` → `getOrCompileIR()` 构建 graph | ✅ |
| `asset-loader.ts` → `getOrCompileIR()` 编译 + 缓存 | ✅ |

---

## V5.1 — Graph Authoring

### 计划 vs 实际

| 计划交付物 | 文件 | 状态 |
|:-----------|:-----|:-----|
| `graph-pipeline-types.ts` — GraphPipeline / GraphPipelineNode / GraphPipelineEdge | `src/lib/agents/graph-pipeline-types.ts` | ✅ |
| `graph-compiler.ts` — `compileGraphPipelineToIR()` + `validateGraphPipeline()` | `src/lib/agents/graph-compiler.ts` | ✅ |
| `graph-pipeline-converter.ts` — `pipelineToGraphPipeline()` / `graphPipelineToPipeline()` | `src/lib/agents/graph-pipeline-converter.ts` | ✅ |
| `pipeline-types.ts` 新增 `graphPipeline?: GraphPipeline` | `src/lib/agents/pipeline-types.ts` L56 | ✅ |
| `dag-compiler.ts` — `compileTemplateToIR()` 优先 graphPipeline | `src/lib/agents/dag-compiler.ts` L31 | ✅ |
| `asset-loader.ts` — 格式自动检测 + graphPipeline 校验 | `src/lib/agents/asset-loader.ts` L47-76 | ✅ |
| `POST /api/pipelines/validate` | `src/app/api/pipelines/validate/route.ts` | ✅ |
| `POST /api/pipelines/convert` | `src/app/api/pipelines/convert/route.ts` | ✅ |
| MCP `antigravity_validate_template` | `src/mcp/server.ts` L389-391 | ✅ |
| MCP `antigravity_convert_template` | `src/mcp/server.ts` L448-450 | ✅ |
| 单元测试（含 round-trip 转换验证） | `graph-compiler.test.ts`, `graph-pipeline-converter.test.ts` | ✅ 通过 |

### 格式共存策略验证

| 策略 | 实现 |
|:-----|:-----|
| `pipeline` 和 `graphPipeline` 互斥，后者优先 | ✅ `asset-loader.ts` L48-49 输出 warn |
| 编译到相同 DagIR，不引入第二套 runner | ✅ |
| 不强制迁移现有 template | ✅ |

---

## V5.2 — Controlled Dynamic Flow

### 子阶段落地

| 子阶段 | 内容 | 状态 |
|:-------|:-----|:-----|
| **V5.2a** | Execution Journal + Checkpoint Persistence | ✅ |
| **V5.2b** | Gate 节点实现 | ✅ |
| **V5.2c** | Switch 节点 + 确定性条件求值器 | ✅ |
| **V5.2d** | Loop 节点 + 上限强制 | ✅ |
| **V5.2e** | Replay / Resume + 审计集成 + API / MCP | ✅ |

### 详细交付物

| 计划交付物 | 文件 | 状态 |
|:-----------|:-----|:-----|
| `execution-journal.ts` — JournalEntry / appendJournalEntry / queryJournal | `src/lib/agents/execution-journal.ts` | ✅ |
| `checkpoint-manager.ts` — createCheckpoint / listCheckpoints / restoreFromCheckpoint | `src/lib/agents/checkpoint-manager.ts` | ✅ |
| `flow-condition.ts` — evaluateCondition()（always / field-exists / field-match / field-compare） | `src/lib/agents/flow-condition.ts` | ✅ |
| `dag-ir-types.ts` — DagNodeKind 扩展 `gate \| switch \| loop-start \| loop-end` | `src/lib/agents/dag-ir-types.ts` L14 | ✅ |
| `dag-ir-types.ts` — DagNode.gate / DagNode.switch / DagNode.loop 配置 | `src/lib/agents/dag-ir-types.ts` | ✅ |
| `dag-runtime.ts` — Gate 激活逻辑 (waiting-approval / rejected / auto-approve) | `src/lib/agents/dag-runtime.ts` L80-100 | ✅ |
| `dag-runtime.ts` — `evaluateSwitch()` + `SwitchEvalResult` | `src/lib/agents/dag-runtime.ts` | ✅ |
| `project-types.ts` — `GateApproval` 类型 + `PipelineStageProgress.gateApproval` | `src/lib/agents/project-types.ts` L28-31 | ✅ |
| `project-types.ts` — `ProjectPipelineState.loopCounters` / `lastCheckpointId` | `src/lib/agents/project-types.ts` L56-58 | ✅ |
| `ops-audit.ts` — 7 种新审计事件 (gate:approved/rejected, switch:evaluated, loop:iteration/terminated, checkpoint:created/restored) | `src/lib/agents/ops-audit.ts` L28-34 | ✅ |
| `POST /api/projects/:id/gate/:nodeId/approve` | `src/app/api/projects/[id]/gate/[nodeId]/approve/route.ts` | ✅ |
| `GET /api/projects/:id/checkpoints` | `src/app/api/projects/[id]/checkpoints/route.ts` | ✅ |
| `POST /api/projects/:id/checkpoints/:checkpointId/restore` | `src/app/api/projects/[id]/checkpoints/[checkpointId]/restore/route.ts` | ✅ |
| `GET /api/projects/:id/journal` | `src/app/api/projects/[id]/journal/route.ts` | ✅ |
| `POST /api/projects/:id/replay` | `src/app/api/projects/[id]/replay/route.ts` | ✅ |
| `POST /api/projects/:id/resume` | `src/app/api/projects/[id]/resume/route.ts` | ✅ |
| MCP `antigravity_gate_approve` | `src/mcp/server.ts` L491-493 | ✅ |
| MCP `antigravity_list_checkpoints` | `src/mcp/server.ts` L560-562 | ✅ |
| 单元测试 | `flow-condition.test.ts`, `checkpoint-manager.test.ts`, `execution-journal.test.ts` | ✅ 通过 |

### 安全约束验证

| 约束 | 遵守 |
|:-----|:-----|
| 条件求值器无 eval() / Function() / LLM 调用 | ✅ `flow-condition.ts` 仅字段提取 + 字面值比较 |
| Loop 必须有 maxIterations 上限 | ✅ `DagNode.loop.maxIterations` 为必填 |
| Gate 默认需人工审批（autoApprove 默认 false） | ✅ |
| 所有控制流决策写入 audit | ✅ 7 种事件类型 |
| Checkpoint 保留上限 10 个 / project | ✅ `MAX_CHECKPOINTS_PER_PROJECT = 10` |

---

## V5.3 — AI-Assisted Design

### 计划 vs 实际

| 计划交付物 | 文件 | 状态 |
|:-----------|:-----|:-----|
| `pipeline-generator.ts` — generatePipeline() / confirmDraft() / getDraft() / cleanExpiredDrafts() | `src/lib/agents/pipeline-generator.ts` | ✅ |
| `generation-context.ts` — buildGenerationContext() / GroupSummary / TemplateSummary | `src/lib/agents/generation-context.ts` | ✅ |
| `risk-assessor.ts` — assessGenerationRisks() / hasCriticalRisk() | `src/lib/agents/risk-assessor.ts` | ✅ |
| Draft store（内存 Map，30min TTL） | `pipeline-generator.ts` 内部 draftStore | ✅ |
| `POST /api/pipelines/generate` | `src/app/api/pipelines/generate/route.ts` | ✅ |
| `GET /api/pipelines/generate/:draftId` | `src/app/api/pipelines/generate/[draftId]/route.ts` | ✅ |
| `POST /api/pipelines/generate/:draftId/confirm` | `src/app/api/pipelines/generate/[draftId]/confirm/route.ts` | ✅ |
| MCP `antigravity_generate_pipeline` (readOnly) | `src/mcp/server.ts` L693-695 | ✅ |
| MCP `antigravity_confirm_pipeline_draft` (destructive) | `src/mcp/server.ts` L753-758 | ✅ |
| 单元测试 | `pipeline-generator.test.ts`, `generation-context.test.ts`, `risk-assessor.test.ts` | ✅ 通过 |

### 风险规则清单

| 检查项 | 严重级别 | 实现 |
|:-------|:---------|:-----|
| DAG 校验有错误 | critical | ✅ |
| stage 数量 > 20 | critical | ✅ |
| stage 数量 > 10 | warning | ✅ |
| 引用不存在的 groupId | critical | ✅ |
| fan-out 嵌套 | warning | ✅ |
| loop maxIterations > 3 | warning | ✅ |
| switch 没有 default | warning | ✅ |
| 无 contract 的 stage | info | ✅ |

### 人工确认机制验证

| 机制 | 实现 |
|:-----|:-----|
| 生成 → draft，不直接保存 | ✅ `status: 'draft'` |
| critical risk → 拒绝保存 | ✅ `hasCriticalRisk()` 检查 |
| 双重确认防止重复保存 | ✅ 测试 `prevents double confirmation` 通过 |
| Draft 30 分钟过期自动清理 | ✅ `DRAFT_TTL_MS = 30 * 60 * 1000` |
| MCP confirm 标记 destructive | ✅ |

---

## V5.4 Phase 1 — 可复用子图 + 成本配额

### 可复用子图

| 计划交付物 | 文件 | 状态 |
|:-----------|:-----|:-----|
| `subgraph-types.ts` — SubgraphDefinition / SubgraphPort / SubgraphRefConfig | `src/lib/agents/subgraph-types.ts` | ✅ |
| `DagNodeKind` 新增 `'subgraph-ref'` | `src/lib/agents/dag-ir-types.ts` L14 | ✅ |
| `DagNode.subgraphRef` 字段 | `src/lib/agents/dag-ir-types.ts` | ✅ |
| `graph-compiler.ts` — 子图编译时展开 (`expandSubgraphRefs`)、子图 resolver 接口 | `src/lib/agents/graph-compiler.ts` L203-247 | ✅ |
| `graph-pipeline-types.ts` — GraphPipelineNode 支持 subgraph-ref kind | `src/lib/agents/graph-pipeline-types.ts` L28 | ✅ |
| `asset-loader.ts` — 子图加载 + 校验 | `src/lib/agents/asset-loader.ts` L109-116 | ✅ |
| `GET /api/pipelines/subgraphs` | `src/app/api/pipelines/subgraphs/route.ts` | ✅ |
| 单元测试 | `subgraph.test.ts` | ✅ 通过 |

### 成本与配额策略

| 计划交付物 | 文件 | 状态 |
|:-----------|:-----|:-----|
| `resource-policy-types.ts` — ResourcePolicy / PolicyRule / ResourceUsage / PolicyViolation / PolicyEvalResult | `src/lib/agents/resource-policy-types.ts` | ✅ |
| `resource-policy-engine.ts` — evaluatePolicies() / findApplicablePolicies() | `src/lib/agents/resource-policy-engine.ts` | ✅ |
| `POST /api/pipelines/policies/check` — 配额检查 | `src/app/api/pipelines/policies/check/route.ts` | ✅ |
| `GET /api/pipelines/policies` — 策略列表 | `src/app/api/pipelines/policies/route.ts` | ✅ |
| MCP `antigravity_check_policy` | `src/mcp/server.ts` L853 | ✅ |
| 单元测试 | `resource-policy-engine.test.ts` | ✅ 通过 |

### 架构约束验证

| 约束（来自 V5.4+ 架构红线） | 遵守 |
|:----------------------------|:-----|
| 只有一个内部运行时（DagIR + dag-runtime） | ✅ |
| 不引入 Python 子服务 | ✅ |
| 不引入分布式调度（单进程 + 文件系统持久化） | ✅ |
| 不引入外部数据库 | ✅ |
| 人工确认优先——资源消耗的自动化需 opt-in | ✅ |
| pipeline[] 格式长期保留 | ✅ |
| 子图编译时展开（不是运行时嵌套执行） | ✅ |
| 配额检查在 dispatch 前执行（pre-check） | ✅ |
| 策略是声明式规则，无自定义代码执行 | ✅ |

---

## 测试覆盖总览

| 测试文件 | 版本 | 用例数 |
|:---------|:-----|:-------|
| `contract-validator.test.ts` | V4.4 | ✅ |
| `dag-compiler.test.ts` | V5.0 | ✅ |
| `dag-runtime.test.ts` | V5.0 | ✅ |
| `pipeline-graph.test.ts` | V4.4/V5.0 | ✅ |
| `project-reconciler.test.ts` | V5.0 | ✅ |
| `project-diagnostics.test.ts` | V5.0 | ✅ |
| `graph-compiler.test.ts` | V5.1 | ✅ |
| `graph-pipeline-converter.test.ts` | V5.1 | ✅ |
| `flow-condition.test.ts` | V5.2 | ✅ |
| `checkpoint-manager.test.ts` | V5.2 | ✅ |
| `execution-journal.test.ts` | V5.2 | ✅ |
| `pipeline-generator.test.ts` | V5.3 | ✅ |
| `generation-context.test.ts` | V5.3 | ✅ |
| `risk-assessor.test.ts` | V5.3 | ✅ |
| `subgraph.test.ts` | V5.4 | ✅ |
| `resource-policy-engine.test.ts` | V5.4 | ✅ |
| `scheduler.test.ts` | 基础设施 | ✅ |
| `ops-audit.test.ts` | V4.3/V5.2 | ✅ |

**总计：18 文件，288 用例，0 失败。**

---

## 新增文件清单

| 文件 | 版本 | 类型 |
|:-----|:-----|:-----|
| `src/lib/agents/contract-types.ts` | V4.4 | 类型定义 |
| `src/lib/agents/contract-validator.ts` | V4.4 | 业务逻辑 |
| `src/lib/agents/dag-ir-types.ts` | V5.0 | 类型定义 |
| `src/lib/agents/dag-compiler.ts` | V5.0 | 编译器 |
| `src/lib/agents/dag-runtime.ts` | V5.0 | 运行时引擎 |
| `src/lib/agents/graph-pipeline-types.ts` | V5.1 | 类型定义 |
| `src/lib/agents/graph-compiler.ts` | V5.1 | 编译器 |
| `src/lib/agents/graph-pipeline-converter.ts` | V5.1 | 格式转换 |
| `src/lib/agents/execution-journal.ts` | V5.2 | 日志系统 |
| `src/lib/agents/checkpoint-manager.ts` | V5.2 | 检查点管理 |
| `src/lib/agents/flow-condition.ts` | V5.2 | 条件求值器 |
| `src/lib/agents/pipeline-generator.ts` | V5.3 | AI 生成 |
| `src/lib/agents/generation-context.ts` | V5.3 | 上下文组装 |
| `src/lib/agents/risk-assessor.ts` | V5.3 | 风险评估 |
| `src/lib/agents/subgraph-types.ts` | V5.4 | 类型定义 |
| `src/lib/agents/resource-policy-types.ts` | V5.4 | 类型定义 |
| `src/lib/agents/resource-policy-engine.ts` | V5.4 | 策略引擎 |

## 改动文件清单

| 文件 | 涉及版本 | 改动内容 |
|:-----|:---------|:---------|
| `src/lib/agents/pipeline-types.ts` | V4.4, V5.1 | 新增 contract / fanOutContract / joinMergeContract / graphPipeline 字段 |
| `src/lib/agents/pipeline-graph.ts` | V4.4 | 集成 validateTemplateContracts() 调用 |
| `src/lib/agents/pipeline-registry.ts` | V5.0 | 改为 IR 转发（canActivateNode / getDownstreamNodes） |
| `src/lib/agents/project-reconciler.ts` | V5.0 | 基于 IR 补偿推进 |
| `src/lib/agents/project-diagnostics.ts` | V4.4, V5.0 | contractIssues 诊断 + 基于 IR 构建图 |
| `src/lib/agents/asset-loader.ts` | V5.0, V5.1, V5.4 | IR 编译 + graphPipeline 格式检测 + 子图加载 |
| `src/lib/agents/project-types.ts` | V5.2 | gateApproval / loopCounters / lastCheckpointId |
| `src/lib/agents/ops-audit.ts` | V5.2 | 7 种新审计事件类型 |
| `src/mcp/server.ts` | V4.4, V5.1, V5.2, V5.3, V5.4 | 8+ 个新 MCP 工具 |

## API 端点清单

| 端点 | 方法 | 版本 |
|:-----|:-----|:-----|
| `/api/pipelines/lint` | POST | V4.4 |
| `/api/pipelines/validate` | POST | V5.1 |
| `/api/pipelines/convert` | POST | V5.1 |
| `/api/projects/:id/gate/:nodeId/approve` | POST | V5.2 |
| `/api/projects/:id/checkpoints` | GET | V5.2 |
| `/api/projects/:id/checkpoints/:checkpointId/restore` | POST | V5.2 |
| `/api/projects/:id/journal` | GET | V5.2 |
| `/api/projects/:id/replay` | POST | V5.2 |
| `/api/projects/:id/resume` | POST | V5.2 |
| `/api/pipelines/generate` | POST | V5.3 |
| `/api/pipelines/generate/:draftId` | GET | V5.3 |
| `/api/pipelines/generate/:draftId/confirm` | POST | V5.3 |
| `/api/pipelines/subgraphs` | GET | V5.4 |
| `/api/pipelines/policies` | GET | V5.4 |
| `/api/pipelines/policies/check` | POST | V5.4 |

## MCP 工具清单

| 工具名 | 版本 | 类型 |
|:-------|:-----|:-----|
| `antigravity_lint_template` | V4.4 | readOnly |
| `antigravity_validate_template` | V5.1 | readOnly |
| `antigravity_convert_template` | V5.1 | readOnly |
| `antigravity_gate_approve` | V5.2 | destructive |
| `antigravity_list_checkpoints` | V5.2 | readOnly |
| `antigravity_generate_pipeline` | V5.3 | readOnly |
| `antigravity_confirm_pipeline_draft` | V5.3 | destructive |
| `antigravity_check_policy` | V5.4 | readOnly |
