# Antigravity Gateway

> **将 [Antigravity](https://antigravity.dev) 变为多 Agent 协作编程平台** — 远程访问、自治交付、微信/Obsidian/MCP 多端接入，全部基于你现有的 Antigravity 订阅。

<p align="center">
  <img src="https://img.shields.io/badge/Antigravity-Gateway_v0.3-6366f1?style=for-the-badge" alt="Antigravity Gateway" />
  <img src="https://img.shields.io/badge/TypeScript-Node.js-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Next.js_16-React_19-000?style=for-the-badge&logo=next.js" alt="Next.js" />
  <img src="https://img.shields.io/badge/MCP-Protocol-ff6600?style=for-the-badge" alt="MCP" />
  <img src="https://img.shields.io/badge/i18n-中文_|_EN-green?style=for-the-badge" alt="i18n" />
</p>

- 本项目首发 Linux.do **[linuxdo（linux.do）](https://linux.do/)** 共建更好社区

**[English Documentation →](README_EN.md)**

<p align="center">
  <img src="docs/assets/pc.png" width="65%" alt="Antigravity Gateway — PC 界面" />
  &nbsp;&nbsp;
  <img src="docs/assets/mobile.png" width="25%" alt="Antigravity Gateway — 移动端界面" />
</p>

---

## 💡 四大目标

Antigravity 是 Google DeepMind 推出的强大 AI 编程代理 — 但它被锁在桌面 IDE 中。本项目打破这个限制：

### 1. 🔓 自由使用 — 随时随地访问

打破桌面束缚。从手机、平板、另一台笔记本、无头服务器 — 通过 Web UI、微信、Obsidian 或 CLI 访问你的 AI 编程代理。全功能 Web UI，响应式设计，任何浏览器都能用。

### 2. 🤖 Multi-Agent 自治交付 — 不只是聊天

让多个 AI Agent 像项目团队一样协作：产品定义 → 架构设计 → 代码实现 → 审查交付。Work Package 驱动的结构化产物传递，而非对话式开发。

### 3. 🔌 万物互联 — 五种接入方式

Web UI、微信公众号、Obsidian 插件、CLI 命令行、MCP 协议 — 同一个 Gateway 后端，五种客户端同时接入、能力共享。

### 4. ⚡ 自动化 — 按需触发 AI 工作流

从命令行、CI/CD 或定时任务触发 Antigravity 能力。让其他 AI（Claude、GPT、Gemini）通过 MCP 协议将 Antigravity 当作子代理直接调用。

---

## 🔌 五大接入方式

| 客户端 | 接入方式 | 说明 |
|--------|----------|------|
| 🌐 **Web UI** | 浏览器 `http://localhost:3000` | 全功能聊天 + 项目管理 + Agent 仪表板，移动端响应式 |
| 📱 **微信** | cc-connect + ACP 适配器 | 在微信公众号中与 AI 对话，支持 `/models` `/workspace` `/status` `/new` 命令 |
| 📔 **Obsidian** | Obsidian 插件 | 在 Obsidian 右侧栏聊天，一边查文档一边让 AI 改代码 |
| ⚙️ **CLI** | `tsx scripts/ag.ts` | 命令行查询、派发 Agent Run、管理项目 |
| 🔌 **MCP** | stdio JSON-RPC | 让 Claude/GPT/Gemini 外部 AI 直接调用 Antigravity |

### 📱 微信接入

通过 [cc-connect](https://github.com/chenhg5/cc-connect)（Go 微信网关）+ 本项目的 ACP 适配器（`scripts/antigravity-acp.ts`），在微信中直接与 Antigravity AI 对话：

```
微信用户 → cc-connect → antigravity-acp.ts (ACP 适配器) → Gateway REST/WS → Language Server
```

支持命令：`/models`（查看模型）、`/model <name>`（切换模型）、`/workspace`（切换工作区）、`/status`（会话状态）、`/new`（新建会话）。

📖 **[微信设置完整指南 →](docs/guide/wechat-setup.md)**

### 📔 Obsidian 插件

内置 Obsidian 插件（`plugins/obsidian-antigravity/`），在 Obsidian 编辑器右侧栏提供 AI 聊天视图：
- `ChatView` — 聊天界面，直连 Gateway REST API + WebSocket 实时流
- 自动检测 Vault 路径关联工作区
- 可配置 Gateway 地址、工作区、模型偏好

📖 **[Obsidian 设置指南 →](docs/guide/obsidian-setup.md)**

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 🤖 **Multi-Agent 交付** | 4 个 Agent Group 协作：产品定义 → 架构设计 → 自治开发 → 审查交付 |
| 📊 **项目管理** | 创建项目、可视化流水线进度、阶段卡片、角色追踪仪表板 |
| 🌐 **远程 Web UI** | 聊天界面 + Markdown 渲染 + 工具卡片 + 模型选择 + 停止/回退/审批 |
| 📱 **微信接入** | 通过 cc-connect + ACP 适配器，微信中直接对话 AI |
| 📔 **Obsidian 插件** | Obsidian 右侧栏 AI 聊天，直连 Gateway |
| 🔌 **MCP Server** | 外部 AI 通过 MCP 协议调用 Antigravity 的项目/Run/派发/干预能力 |
| ⚡ **实时 WebSocket** | 代理 gRPC 流为 JSON，订阅即得 AI 实时回复 |
| 🌍 **国际化** | 中文 / English 双语（276 条消息），一键切换，localStorage 持久化 |
| 🔍 **自动发现** | 零配置，通过 `ps`+`lsof` 自动发现所有 language_server 实例 |
| 🔀 **智能路由** | 将对话路由到正确的 workspace 匹配服务器（非随机） |
| 📱 **移动优先** | shadcn/ui + Tailwind CSS 4，手机到桌面全响应 |
| 🎯 **Skill/Workflow** | 聊天输入框 `@skill` 和 `/workflow` 自动补全 |
| 🔐 **写入范围审计** | Scope Governor 检测代码变更是否超出方案允许范围 |
| 📋 **知识库管理** | 浏览、编辑、删除 Knowledge Items 及 Artifacts |
| 🌐 **隧道支持** | Cloudflare Tunnel 自动连接，外网可访问 |

---

## 🤖 Multi-Agent 自治交付系统

> **不只是聊天，而是让多个 AI Agent 像一个项目团队一样自主协作。**

```
用户提需求 → 📋 产品顾问团 → 🏗️ 架构顾问团 → ⚡ 自治开发团队 → ✅ 交付审阅
```

### Agent Group

| 阶段 | Group ID | 角色 | 做什么 |
|------|----------|------|--------|
| **快速开发** | `coding-basic` | — | 单任务直接派发 — 修 bug、做功能、重构 |
| **产品定义** | `product-spec` | PM Author + Lead Reviewer | 多轮审查 → 产出获批产品方案 |
| **架构设计** | `architecture-advisory` | Architect Author + Reviewer | 多轮审查 → 产出获批技术方案 |
| **自治交付** | `autonomous-dev-pilot` | Dev Pilot | 接收 Work Package → 研究 → 实现 → 测试 → 交付 |

### 核心设计

- 🔗 **产物链式传递** — 每个阶段输出自动成为下游输入，结构化 `result.json` 握手
- 📦 **Work Package 驱动** — 不是对话式开发，而是任务包 → 交付包的工程化流程
- 🔍 **写入范围审计** — Scope Governor 自动检测代码变更是否越权
- 🔄 **Review Loop** — Author → Reviewer 对抗审查，多轮迭代直至通过
- 👻 **Child 对话隐藏** — Agent Worker 在独立 conversation 中执行，主会话只看结果
- ⏱️ **Supervisor 看护** — 3 分钟无进度自动判定 Stale，支持超时、取消、恢复

### 快速体验

```bash
# 派发一个 coding 任务
curl -X POST http://localhost:3000/api/agent-runs \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"coding-basic","workspace":"file:///path/to/project","prompt":"修复登录 token 刷新问题"}'
```

或在 Web UI 左侧导航点 **Agents** → 选 Group → 输入任务 → Dispatch。

📖 **[完整 Agent 系统指南 →](docs/guide/agent-user-guide.md)**

---

## 架构

```
                        ┌─── 🌐 Web UI (React 19)
                        ├─── 📱 微信 (cc-connect ACP)
 客户端 ────────────────├─── 📔 Obsidian (插件)
                        ├─── ⚙️  CLI (ag.ts)
                        └─── 🔌 MCP Client (外部 AI)
                               │
          HTTP :3000 + WS /ws + stdio (MCP)
                               │
┌──────────────────────────────▼──────────────────────────────┐
│              Antigravity Gateway（单端口服务）                 │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Next.js  │ │ REST API │ │WebSocket │ │  MCP Server   │  │
│  │ React UI │ │ 38 端点   │ │ 实时流    │ │ stdio JSON-RPC│  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Agent Engine (Multi-Agent)               │   │
│  │  Group Runtime → Pipeline Registry → Review Engine    │   │
│  │  Run Registry  → Scope Governor   → Watch + Merger    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   Bridge Layer                        │   │
│  │  discovery.ts ── 进程发现 (ps + lsof)                  │   │
│  │  grpc.ts      ── gRPC-Web Connect 编解码               │   │
│  │  gateway.ts   ── Owner 路由 + 连接管理                  │   │
│  │  statedb.ts   ── SQLite 读取 (state.vscdb)             │   │
│  │  tunnel.ts    ── Cloudflare Tunnel                     │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────┘
                               │ gRPC-Web (HTTPS, 127.0.0.1)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│          Antigravity Language Server（IDE 内置，多实例）        │
│     每个 workspace 一个，共享 .pb 文件，隔离的内存状态            │
└──────────────────────────────────────────────────────────────┘
```

### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **Bridge** | `gateway.ts` / `grpc.ts` / `discovery.ts` | 服务发现 + 路由 + gRPC-Web 编解码 |
| **Agent Engine** | `group-runtime.ts` / `run-registry.ts` | 派发 → 监控 → 收割 → 持久化 |
| **Project Engine** | `project-registry.ts` / `pipeline-registry.ts` | 项目容器 + 流水线阶段管理 |
| **Review Engine** | `review-engine.ts` | Author-Reviewer 对抗审查循环 |
| **Scope Governor** | `scope-governor.ts` | 写入范围冲突检测 |
| **Watch** | `watch-conversation.ts` / `step-merger.ts` | 实时级联监控 + 增量步骤合并 |
| **MCP Server** | `src/mcp/server.ts` | 暴露项目/Run/派发给外部 AI |

📐 **[完整架构文档（含 Mermaid 图）→](ARCHITECTURE.md)**

---

## 全局数据目录

首次启动时，Gateway 会自动将仓库中的 Agent 模板、Workflow 等资产文件同步到全局目录 `~/.gemini/antigravity/gateway/`。运行时注册表（项目、Run、对话映射）也持久化在此目录下。

> ⚠️ **不要修改此路径**。IDE 内置的 Language Server 使用 `~/.gemini/` 目录，自定义路径可能导致 IDE 无法读取 Gateway 数据，引发对话和 Agent 功能异常。

| 全局路径 | 内容 |
|---------|------|
| `assets/templates/` | Agent Group 模板定义 (JSON) |
| `assets/workflows/` | 角色工作流指令 (Markdown) |
| `assets/standards/` | 设计标准文档 |
| `projects.json` | 项目注册表 |
| `agent_runs.json` | Agent Run 状态 |
| `local_conversations.json` | 本地对话映射 |

---

## 快速开始

### 前提条件

> ⚠️ **系统要求**：目前**仅支持 macOS Apple Silicon（M 系列芯片）**。

- **macOS** (Apple Silicon M1/M2/M3/M4)
- **Antigravity** 桌面应用已安装并运行（至少打开一个 workspace）
- **Node.js** ≥ 20

### 安装 & 启动

```bash
git clone https://github.com/pikapikaspeedup/Antigravity-Mobility-CLI.git
cd Antigravity-Mobility-CLI

npm install
npm run dev        # 启动 Web UI + REST API + WebSocket (port 3000)
```

打开 `http://localhost:3000` 即可使用。局域网设备用 `http://<你的IP>:3000`。

### 其他启动方式

```bash
npm run mcp        # 启动 MCP Server（供 Claude/GPT 等外部 AI 调用）
npm run ag         # CLI 工具（查询/派发/管理 Agent Run）
npm run build      # 生产构建
npm start          # 生产模式启动
```

### 验证

```bash
# 发现的 Language Server 实例
curl http://localhost:3000/api/servers

# 用户信息
curl http://localhost:3000/api/me

# 可用模型
curl http://localhost:3000/api/models | jq '.clientModelConfigs[] | {label}'

# Agent Group 列表
curl http://localhost:3000/api/agent-groups

# 项目列表
curl http://localhost:3000/api/projects
```

---

## API 速览 (38 个端点)

完整文档：**[docs/guide/gateway-api.md](docs/guide/gateway-api.md)**

### 对话接口

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/conversations` | 列出对话（支持 workspace 过滤） |
| `POST` | `/api/conversations` | 新建对话 |
| `POST` | `/api/conversations/:id/send` | 发送消息（支持 `@[file]` 附件、Agentic 模式） |
| `GET` | `/api/conversations/:id/steps` | 获取步骤（checkpoint） |
| `POST` | `/api/conversations/:id/cancel` | 停止生成 |
| `POST` | `/api/conversations/:id/proceed` | 审批继续 |
| `POST` | `/api/conversations/:id/revert` | 回退到第 N 步 |
| `GET` | `/api/conversations/:id/revert-preview` | 预览回退效果 |
| `GET` | `/api/conversations/:id/files` | 搜索工作区文件 |

### Multi-Agent 接口

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/agent-groups` | 列出 Agent Group 定义 |
| `GET` | `/api/agent-groups/:id` | Group 详情 |
| `POST` | `/api/agent-runs` | 派发 Run |
| `GET` | `/api/agent-runs` | 列出 Run（支持过滤） |
| `GET/DELETE` | `/api/agent-runs/:id` | Run 状态 / 取消 |
| `POST` | `/api/agent-runs/:id/intervene` | 干预（nudge/retry/restart/cancel/evaluate） |

### 项目接口

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/api/projects` | 创建项目 |
| `GET` | `/api/projects` | 列出项目 |
| `GET/PATCH/DELETE` | `/api/projects/:id` | 读取 / 更新 / 删除 |
| `POST` | `/api/projects/:id/resume` | 恢复（recover/nudge/cancel/skip） |
| `GET` | `/api/pipelines` | 流水线模板列表 |
| `POST` | `/api/scope-check` | 写入范围冲突检测 |

### 环境 / 知识库 / 其他

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/servers` | Language Server 实例 |
| `GET` | `/api/workspaces` | Workspace + Playground |
| `POST` | `/api/workspaces/launch\|close\|kill` | 启动 / 隐藏 / 终止工作区 |
| `GET` | `/api/me` | 用户信息 |
| `GET` | `/api/models` | 模型及配额 |
| `GET` | `/api/skills` | 技能列表 |
| `GET` | `/api/workflows` | 工作流列表 |
| `GET` | `/api/rules` | 自定义规则 |
| `GET` | `/api/analytics` | 使用分析 |
| `GET` | `/api/mcp` | MCP 配置 |
| `GET` | `/api/knowledge` | 知识库条目 |
| `GET/PUT/DELETE` | `/api/knowledge/:id` | 知识库 CRUD |
| `GET/PUT` | `/api/knowledge/:id/artifacts/*` | Artifact 文件 |
| `GET` | `/api/logs` | 应用日志 |
| `GET/POST` | `/api/tunnel/*` | Cloudflare Tunnel 管理 |

### WebSocket

```bash
wscat -c ws://localhost:3000/ws
> {"type": "subscribe", "cascadeId": "<conversation-uuid>"}
# ← {"type":"steps","cascadeId":"...","data":{"steps":[...],"status":"CASCADE_RUN_STATUS_RUNNING"}}
```

支持 `subscribe`、`multi-subscribe`、`unsubscribe` 三种消息类型。

---

## 快速示例

### 创建对话并提问

```bash
# 创建对话
CID=$(curl -sX POST http://localhost:3000/api/conversations \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"file:///path/to/project"}' | jq -r .cascadeId)

# 发送消息
curl -sX POST "http://localhost:3000/api/conversations/$CID/send" \
  -H 'Content-Type: application/json' \
  -d '{"text":"解释这个项目的架构"}'

# 等待并获取结果
sleep 15
curl -s "http://localhost:3000/api/conversations/$CID/steps" | \
  jq -r '[.steps[] | select(.plannerResponse)] | last | .plannerResponse.modifiedResponse'
```

### 派发 Agent Run

```bash
# 简单 coding 任务
curl -X POST http://localhost:3000/api/agent-runs \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"coding-basic","workspace":"file:///path/to/project","prompt":"添加用户注册功能"}'

# 查看 Run 状态
curl http://localhost:3000/api/agent-runs | jq '.[0] | {runId, status, groupId}'
```

### 创建项目（全流程自动交付）

```bash
# 创建项目
curl -X POST http://localhost:3000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"Task Manager","goal":"构建一个任务管理系统","workspace":"file:///path/to/project"}'

# 查看项目流水线进度
curl http://localhost:3000/api/projects | jq '.[0] | {projectId, name, currentStage}'
```

### Python 集成

```python
import requests, time

BASE = "http://localhost:3000"

# 派发 Agent Run
run = requests.post(f"{BASE}/api/agent-runs",
    json={"groupId": "coding-basic",
          "workspace": "file:///path/to/project",
          "prompt": "实现基本的 CRUD 功能"}).json()

# 轮询状态
while True:
    status = requests.get(f"{BASE}/api/agent-runs/{run['runId']}").json()
    print(f"Status: {status['status']}")
    if status['status'] in ('completed', 'failed', 'cancelled'):
        break
    time.sleep(10)
```

### 微信接入

```bash
# 1. 安装 cc-connect（Go 微信网关）
go install github.com/chenhg5/cc-connect@latest

# 2. 扫码绑定微信
cc-connect weixin setup --project antigravity

# 3. 复制配置模板并填入 Gateway 地址
cp cc-connect.config.toml ~/.cc-connect/config.toml

# 4. 同时启动 Gateway 和 cc-connect
npm run dev          # Terminal 1
cc-connect           # Terminal 2

# 5. 在微信中发消息给绑定的公众号即可
```

📖 **[微信设置完整指南 →](docs/guide/wechat-setup.md)**

### MCP 接入（让外部 AI 调用 Antigravity）

```bash
# 启动 MCP Server
npm run mcp
```

在 Claude Desktop 或其他 MCP 客户端的配置中添加：

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/path/to/Antigravity-Mobility-CLI"
    }
  }
}
```

📖 **[MCP Server 文档 →](docs/guide/mcp-server.md)**

---

## 项目结构

```
Antigravity-Mobility-CLI/
├── server.ts                     # 自定义服务器：Next.js + WebSocket + MCP 单端口
├── src/
│   ├── app/
│   │   ├── page.tsx              # 主页面（对话/项目/Agent/知识库 多面板）
│   │   ├── layout.tsx            # 根布局 + i18n Provider
│   │   └── api/                  # 38 个 REST API 路由
│   │       ├── conversations/    # 对话 CRUD + send/cancel/revert/proceed
│   │       ├── agent-groups/     # Agent Group 查询
│   │       ├── agent-runs/       # Run 派发/查询/取消/干预
│   │       ├── projects/         # 项目 CRUD + 流水线恢复
│   │       ├── pipelines/        # 模板列表
│   │       ├── scope-check/      # 写入范围冲突检测
│   │       ├── knowledge/        # 知识库 CRUD + Artifact
│   │       └── ...               # models/skills/workflows/tunnel/logs/...
│   ├── components/               # 20+ React 组件
│   │   ├── sidebar.tsx           # 4 区导航（对话/项目/Agent/知识库）
│   │   ├── chat.tsx              # 聊天 Timeline
│   │   ├── chat-input.tsx        # 输入框（@file / Agentic / 模型选择）
│   │   ├── projects-panel.tsx    # 项目管理面板
│   │   ├── project-workbench.tsx # 流水线编排仪表板
│   │   ├── agent-runs-panel.tsx  # Agent Run 队列
│   │   ├── agent-run-detail.tsx  # Run 详情 + Supervisor 日志
│   │   ├── pipeline-stage-card.tsx # 阶段卡片
│   │   ├── role-timeline.tsx     # 角色执行时间线
│   │   ├── knowledge-panel.tsx   # 知识库管理
│   │   ├── locale-provider.tsx   # i18n Context
│   │   └── ui/                   # shadcn/ui 基础组件
│   ├── lib/
│   │   ├── types.ts              # 全量类型（Project, AgentRun, Pipeline...）
│   │   ├── api.ts                # 前端 API + WebSocket
│   │   ├── i18n/                 # 中英双语 276 条消息
│   │   ├── agents/               # 🤖 Multi-Agent 引擎
│   │   │   ├── group-runtime.ts  # 核心调度（dispatch/watch/finalize）
│   │   │   ├── pipeline-registry.ts # 流水线模板管理
│   │   │   ├── project-registry.ts  # 项目容器 + 生命周期
│   │   │   ├── run-registry.ts   # Run 状态 + 冷启恢复
│   │   │   ├── review-engine.ts  # Supervisor 审阅
│   │   │   ├── scope-governor.ts # 写入范围审计
│   │   │   └── watch-conversation.ts # 实时监控 + Stale 检测
│   │   └── bridge/               # IDE 桥接层
│   │       ├── discovery.ts      # 进程发现 (ps + lsof)
│   │       ├── grpc.ts           # gRPC-Web Connect
│   │       ├── gateway.ts        # Owner 路由 + 连接管理
│   │       └── tunnel.ts         # Cloudflare Tunnel
│   └── mcp/server.ts             # MCP Server (stdio JSON-RPC)
├── plugins/obsidian-antigravity/  # 📔 Obsidian 插件
│   ├── main.ts                   # 插件入口
│   ├── chat-view.ts              # 聊天侧栏视图
│   ├── api-client.ts             # Gateway API 客户端
│   └── settings.ts               # 插件配置
├── scripts/
│   ├── ag.ts                     # CLI 工具
│   ├── antigravity-acp.ts        # 微信 ACP 适配器
│   ├── ag-wechat.ts              # 微信模型查询
│   └── call_workflow.py          # 示例：无头 workflow 执行
├── .agents/workflows/             # Agent 工作流模板
├── docs/
│   ├── guide/                    # 📘 用户指南
│   └── internals/                # 🔧 内部技术文档
├── ARCHITECTURE.md               # 📐 架构全景 (Mermaid)
└── PITFALLS.md                   # 🚧 踩坑记录
```

---

## 技术文档

| 文档 | 说明 |
|------|------|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | 📐 架构全景 — Mermaid 系统图、数据流、状态机、模块依赖 |
| **[docs/guide/agent-user-guide.md](docs/guide/agent-user-guide.md)** | 🤖 Agent 系统手册 — 4 个 Group、交付链路、产物结构、Resume 操作 |
| **[docs/guide/gateway-api.md](docs/guide/gateway-api.md)** | 📘 API 参考 — 38 个端点的 Schema、示例、模型表 |
| **[docs/guide/cli-guide.md](docs/guide/cli-guide.md)** | ⚙️ CLI 使用指南 — ag.ts 命令行完整用法 |
| **[docs/guide/wechat-setup.md](docs/guide/wechat-setup.md)** | 📱 微信设置指南 — cc-connect + ACP 适配器配置 |
| **[docs/guide/mcp-server.md](docs/guide/mcp-server.md)** | 🔌 MCP Server — 让外部 AI 调用 Antigravity |
| **[docs/guide/remote-access.md](docs/guide/remote-access.md)** | 🌐 远程访问 — Cloudflare Tunnel 配置 |
| **[docs/internals/cdp-reverse-engineering.md](docs/internals/cdp-reverse-engineering.md)** | 🔍 逆向工程 — 捕获和解码 gRPC 流量 |
| **[docs/internals/state-db-data-map.md](docs/internals/state-db-data-map.md)** | 🗄️ SQLite 数据地图 — state.vscdb 结构 |
| **[docs/internals/permission-system.md](docs/internals/permission-system.md)** | 🔐 权限系统 — 文件权限、Scope 管理 |
| **[PITFALLS.md](PITFALLS.md)** | 🚧 踩坑记录 — 多服务器路由、增量合并、幽灵对话等 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **服务器** | Next.js 16（自定义 HTTP + WS 服务器）、TypeScript |
| **前端** | React 19、shadcn/ui、Tailwind CSS 4、Lucide Icons、Marked |
| **桥接** | gRPC-Web over HTTPS、SQLite (better-sqlite3)、进程发现 (ps + lsof) |
| **Agent 引擎** | Group Runtime、Pipeline Registry、Review Engine、Scope Governor |
| **MCP** | @modelcontextprotocol/sdk（stdio JSON-RPC） |
| **微信** | cc-connect (Go) + antigravity-acp.ts (ACP 适配器) |
| **Obsidian** | Obsidian API 插件 + Gateway REST |
| **国际化** | React Context + localStorage + 276 条中英消息 |
| **日志** | pino 结构化日志 + Log Viewer 面板 |
| **协议** | 逆向工程 `exa.language_server_pb.LanguageServerService` |

---

## 💡 使用场景

<p align="center">
  <img src="docs/assets/mobile_coding.png" width="45%" alt="Mobile Coding" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/assets/api_automation.png" width="45%" alt="API Automation" />
</p>

- 📱 **躺在床上写代码** — 手机/iPad 通过 Web UI 直连 Antigravity
- 💬 **微信里写代码** — 碎片时间用 `/models` 切换模型、`/workspace` 切换项目
- 📔 **Obsidian 里写代码** — 一边查文档一边让 AI 改代码
- 🤖 **让 AI 拥有 AI** — REST API 对接 n8n/Make/Zapier，脚本直接调用
- 🏭 **全自动产品交付** — 一句话需求 → 产品 → 架构 → 实现 → 审查 → 交付
- 🔄 **自动巡检** — CI/CD 定时触发代码审查、文档更新
- 🔌 **MCP 子代理** — 让 Claude Desktop 通过 MCP 直接使用 Antigravity 写代码

---

## 📱 移动端连接

1. 手机和电脑**连同一 Wi-Fi**
2. 获取 IP：`ipconfig getifaddr en0`
3. 启动：`npm run dev`
4. 手机访问：`http://192.168.x.x:3000`

---

## 🐛 已知缺陷

1. **单向可见** — Gateway 新建的对话在官方 Agent Manager 中不可见（反过来可见，聊天记录双向同步）。详见 [PITFALLS.md](PITFALLS.md) §16
2. **Playground 限制** — Web 端已禁止在 Playground 中新建对话
3. **Action 解析不完整** — 部分 Action 被默认自动审批，偶尔出现滞留的 Proceed 按钮
4. **撤回缺陷** — 只撤回 AI 回应，用户 Prompt 仍留在屏幕
5. **CLI 自动审批** — CLI 模式遇到需要人工审批的阻塞可能卡住
6. **偶尔抽风** — 多端同步异常时，强制刷新页面即可

---

## 🆕 更新日志

<details>
<summary><b>v0.3.0 — 多 Agent 协作平台</b></summary>

- 🤖 Multi-Agent 编程系统（Group 分组、流水线自动触发、Review Loop、Scope 审计、Supervisor 看护）
- 📊 项目管理面板（Projects Panel、Workbench、Pipeline Stage Card、Role Timeline）
- 🌍 完整国际化（中文/English 276 条消息，一键切换）
- 🔌 MCP Server（外部 AI 调用 Antigravity）
- 📱 微信接入（cc-connect + ACP 适配器）
- 📔 Obsidian 插件（右侧栏 AI 聊天）
- 🛠 5 个工作流模板（架构/产品/UX 审查）
- 🎨 UI 重构（Sidebar 8 标签、Role Timeline、Stage/Role Detail）
- 📚 新增 Agent Run Detail、Scope Governor、Pipeline Registry 等 10+ 模块
- 🔒 安全清理（移除硬编码路径和凭据）

</details>

<details>
<summary><b>v0.2.0 — 知识库、日志和附件</b></summary>

- 📋 Knowledge Panel — 知识库管理面板
- 📎 文件附件 — 聊天 `@` 引用文件
- 🧠 Active Tasks 面板 — 实时任务进度
- 🔀 Agentic Mode 开关
- 📊 结构化日志 — pino + Log Viewer
- 🌐 隧道自启动 — Cloudflare Tunnel
- 🔧 模型选择优化

</details>

---

## 💬 交流与支持

<p align="left">
  <img src="docs/assets/group.jpg" width="250" alt="WeChat Group QR Code" />
</p>

**🎉 欢迎加入：Antigravity CLI 交流使用群**

有想法、Bug 反馈、或自动化工作流分享，欢迎进群讨论！

## 🙏 致谢

- **[jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)**
- **[AvenalJ/AntigravityMobile](https://github.com/AvenalJ/AntigravityMobile)**

---

## 贡献

欢迎 PR！更新相关文档：
- API 变更 → `docs/guide/gateway-api.md`
- 新的坑 → `PITFALLS.md`
- 内部协议 → `docs/internals/`

## 免责声明

本项目是出于学习和互操作性目的构建的**非官方、社区驱动**开源工具。
- **不提供**绕过付费墙、破解认证或滥用 API 的能力
- **必须**依赖用户本机已安装并合法认证的官方 Antigravity 桌面应用
- 所有调用消耗用户个人正常配额
- 与 Google DeepMind **没有关联、授权或背书**
- 逆向工程接口随时可能变化，**使用后果自行承担**

## 许可证

MIT

---

<p align="center">
  <sub>以好奇心和逆向工程构建。与 Google DeepMind 无关。</sub>
</p>
