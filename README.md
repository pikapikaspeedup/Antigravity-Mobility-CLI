# Antigravity Gateway

> **将 [Antigravity](https://antigravity.dev) 变为无头 API 服务器** — 解锁远程访问、子代理集成和自动化 AI 工作流，全部基于你现有的 Antigravity 订阅。

<p align="center">
  <img src="https://img.shields.io/badge/Antigravity-Gateway-6366f1?style=for-the-badge" alt="Antigravity Gateway" />
  <img src="https://img.shields.io/badge/TypeScript-Node.js-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Next.js_16-React_19-000?style=for-the-badge&logo=next.js" alt="Next.js" />
</p>

**[English Documentation →](README_EN.md)**

<p align="center">
  <img src="docs/assets/pc.png" width="65%" alt="Antigravity Gateway PC UI" />
  &nbsp;&nbsp;
  <img src="docs/assets/mobile.png" width="25%" alt="Antigravity Gateway Mobile UI" />
</p>

---

## 💡 三大目标

Antigravity 是 Google DeepMind 推出的强大 AI 编程代理 — 但它被锁在桌面 IDE 中。本项目有三个野心：

### 1. 🔓 自由使用 — 随时随地访问 Antigravity

打破桌面束缚。从任何设备 — 手机、平板、另一台笔记本、无头服务器 — 访问你的 AI 编程代理。全功能 Web UI 可在任何浏览器中运行。

### 2. 🤖 子代理模式 — 让其他工具调用 Antigravity

将 Antigravity 暴露为标准 REST + WebSocket API。任何工具、脚本或自动化平台（n8n、Make、Zapier、cron）都可以创建对话、发送提示、消费 AI 回复。

### 3. ⚡ Workflow 随处执行 — 按需触发自定义工作流

从命令行触发任何 Antigravity Skill 或 Workflow。在 IDE 中使用的 AI 流程 — 选题发现、内容生成、代码审查 — 都可以无头运行、定时运行、或从 CI/CD 触发。

```bash
# 示例：从终端触发 workflow
python3 scripts/call_workflow.py   # → 创建对话，执行 /ai-topic-discovery，打印结果
```

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 🌐 **远程 Web UI** | 完整聊天界面，支持 Markdown 渲染、工具卡片、模型选择器、停止/回退/审批 |
| 🤖 **REST API** | 17 个端点，覆盖对话、模型、技能、工作流、规则、分析 |
| ⚡ **实时 WebSocket** | 代理 StreamAgentStateUpdates 为 JSON — 订阅即可实时获取 AI 回复 |
| 🔍 **自动发现** | 零配置。通过 `ps`+`lsof` 自动发现所有运行中的 language_server 实例 |
| 🔀 **智能路由** | 将每个对话路由到正确的 workspace 匹配服务器（非随机） |
| 📱 **移动优先** | 基于 shadcn/ui + Tailwind CSS 4，从手机到桌面全面响应 |
| 🎯 **Skill/Workflow 支持** | 聊天输入框中 `@skill-name` 和 `/workflow-name` 自动补全 |

---

## 架构

```
┌───────────────────────────────────────────────────┐
│       浏览器 / cURL / Python / CI/CD               │
│         (手机、平板、笔记本、服务器)                   │
└──────────────┬────────────────────────────────────┘
               │ HTTP :3000 + WebSocket /ws
               ▼
┌──────────────────────────────────────────────────┐
│           Antigravity Gateway（单端口）             │
│  ┌─────────────────────────────────────────────┐ │
│  │         Next.js 16 + 自定义服务器              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │ │
│  │  │ React UI │  │ API 路由  │  │WebSocket │  │ │
│  │  │ (SSR)    │  │ (REST)   │  │(ws 代理)  │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  │ │
│  │              Bridge 层                       │ │
│  │  discovery.ts — 进程扫描 + 文件系统解码         │ │
│  │  statedb.ts   — SQLite 读取 (state.vscdb)    │ │
│  │  grpc.ts      — gRPC-Web 客户端 (HTTPS)      │ │
│  │  gateway.ts   — Owner 路由 + 连接管理          │ │
│  └──────────────────┬──────────────────────────┘ │
└─────────────────────┼────────────────────────────┘
                      │ gRPC-Web (HTTPS, 127.0.0.1)
                      ▼
┌──────────────────────────────────────────────────┐
│      Antigravity 语言服务器（多实例）                │
│   (每个 workspace 一个，通过 ps 自动发现)            │
│   共享 .pb 文件，隔离的内存状态                      │
└──────────────────────────────────────────────────┘
```

---

## 快速开始

### 前提条件

- **Antigravity** 桌面应用已安装并运行（至少打开一个 workspace）
- **Node.js** ≥ 20

### 安装 & 启动

```bash
git clone https://github.com/pikapikaspeedup/Antigravity-Mobility-CLI.git
cd Antigravity-Mobility-CLI

npm install
npm run dev
```

就这样！打开 `http://localhost:3000` 即可使用。

> 如需从局域网其他设备访问，使用 `http://<你的IP>:3000`。

### 验证

```bash
# 检查已发现的服务器
curl http://localhost:3000/api/servers

# 检查用户信息
curl http://localhost:3000/api/me

# 列出可用模型
curl http://localhost:3000/api/models | jq '.clientModelConfigs[] | {label, model: .modelOrAlias.model}'
```

---

## API 速览

完整文档：**[docs/GATEWAY_API.md](docs/GATEWAY_API.md)**

### 对话接口

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/conversations` | 列出所有对话（gRPC + SQLite + .pb 合并） |
| `POST` | `/api/conversations` | 新建对话。Body: `{"workspace": "file:///path"}` |
| `POST` | `/api/conversations/:id/send` | 发送消息。Body: `{"text": "...", "model": "MODEL_ID"}` |
| `GET` | `/api/conversations/:id/steps` | 获取所有步骤（checkpoint） |
| `POST` | `/api/conversations/:id/cancel` | 停止 AI 生成 |
| `POST` | `/api/conversations/:id/proceed` | 审批并继续 |
| `POST` | `/api/conversations/:id/revert` | 回退到第 N 步 |

### 环境接口

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/servers` | 运行中的 language_server 实例 |
| `GET` | `/api/workspaces` | 所有已知 workspace + playground |
| `GET` | `/api/me` | 用户信息 |
| `GET` | `/api/models` | 可用模型及配额 |
| `GET` | `/api/skills` | 所有技能（全局+工作空间） |
| `GET` | `/api/workflows` | 所有工作流 |
| `GET` | `/api/rules` | 自定义规则 |
| `GET` | `/api/analytics` | 使用分析 |
| `GET` | `/api/mcp` | MCP 服务器配置 |

### WebSocket

```bash
# 连接并订阅
wscat -c ws://localhost:3000/ws
> {"type": "subscribe", "cascadeId": "conversation-uuid"}
# ← {"type": "steps", "cascadeId": "...", "data": {"steps": [...], "status": "CASCADE_RUN_STATUS_RUNNING"}}
```

### 可用模型

| 内部 ID | 显示名称 |
|---------|----------|
| `MODEL_PLACEHOLDER_M37` | Gemini 3.1 Pro (High) |
| `MODEL_PLACEHOLDER_M36` | Gemini 3.1 Pro (Low) |
| `MODEL_PLACEHOLDER_M47` | Gemini 3 Flash |
| `MODEL_PLACEHOLDER_M35` | Claude Sonnet 4.6 (Thinking) |
| `MODEL_PLACEHOLDER_M26` | Claude Opus 4.6 (Thinking) |
| `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` | GPT-OSS 120B (Medium) |

---

## 快速示例

### 一行命令：提问

```bash
CID=$(curl -sX POST http://localhost:3000/api/conversations \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"file:///Users/you/project"}' | jq -r .cascadeId) && \
curl -sX POST "http://localhost:3000/api/conversations/$CID/send" \
  -H 'Content-Type: application/json' \
  -d '{"text":"解释这个项目的架构"}' && \
sleep 15 && \
curl -s "http://localhost:3000/api/conversations/$CID/steps" | \
  jq -r '[.steps[] | select(.plannerResponse)] | last | .plannerResponse.modifiedResponse'
```

### Python：完整对话

```python
import requests, time

BASE = "http://localhost:3000"

# 创建对话
cid = requests.post(f"{BASE}/api/conversations",
    json={"workspace": "file:///path/to/your/project"}).json()["cascadeId"]

# 发送消息
requests.post(f"{BASE}/api/conversations/{cid}/send",
    json={"text": "审查这个代码库", "model": "MODEL_PLACEHOLDER_M26"})

# 等待并获取结果
time.sleep(20)
steps = requests.get(f"{BASE}/api/conversations/{cid}/steps").json()["steps"]
ai_reply = [s for s in steps if s.get("plannerResponse")][-1]
print(ai_reply["plannerResponse"]["modifiedResponse"])
```

### 触发 Workflow

```bash
python3 scripts/call_workflow.py
# 创建对话 → 发送 /ai-topic-discovery → 监控进度 → 打印结果
```

---

## 项目结构

```
Antigravity-Mobility-CLI/
├── server.ts                     # 自定义服务器：Next.js + WebSocket 单端口
├── src/app/
│   ├── page.tsx                  # 主聊天页面
│   └── api/                      # 17 个 REST API 路由处理器
│       ├── conversations/        # CRUD + send/cancel/revert/proceed
│       ├── models/               # 模型列表及配额
│       ├── skills/               # 技能发现
│       └── ...
├── src/lib/bridge/               # 核心桥接层
│   ├── discovery.ts              # 自动发现 language_server (ps + lsof + fs 解码)
│   ├── grpc.ts                   # gRPC-Web 客户端
│   ├── statedb.ts                # 从 SQLite 读取 API key、workspace
│   └── gateway.ts                # Owner 路由、连接管理
├── scripts/
│   └── call_workflow.py          # 示例：无头 workflow 执行
├── docs/                         # 📚 技术文档
│   ├── GATEWAY_API.md            # 对外 API 参考（CLI/集成用）
│   ├── API_REFERENCE.md          # 内部 gRPC 协议参考
│   ├── STATE_DB_DATA_MAP.md      # SQLite state.vscdb 数据结构
│   ├── CDP_REVERSE_ENGINEERING.md # 如何逆向工程 Antigravity
│   └── GAP_ANALYSIS.md           # 功能覆盖 vs 原生 Agent Manager
├── PITFALLS.md                   # 🚧 13 个已记录的深坑及解决方案
└── package.json
```

---

## 技术文档

| 文档 | 说明 |
|------|------|
| **[docs/GATEWAY_API.md](docs/GATEWAY_API.md)** | 📘 **对外 API 文档** — 每个端点的请求/响应 Schema、模型表、步骤类型、集成示例（Python、Shell、Node.js） |
| **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)** | 🔧 **内部 gRPC 参考** — 所有逆向工程的 `LanguageServerService` RPC 方法、流式协议、步骤数据架构 |
| **[docs/STATE_DB_DATA_MAP.md](docs/STATE_DB_DATA_MAP.md)** | 🗄️ **SQLite 数据地图** — `state.vscdb` 存了什么、哪些 key 重要、哪些是过时的 |
| **[docs/CDP_REVERSE_ENGINEERING.md](docs/CDP_REVERSE_ENGINEERING.md)** | 🔍 **逆向工程指南** — 如何使用 Chrome DevTools Protocol 捕获和解码 Antigravity 内部 gRPC 流量 |
| **[docs/GAP_ANALYSIS.md](docs/GAP_ANALYSIS.md)** | 📊 **功能差距分析** — 15 种已实现步骤类型、8 种可跳过类型、缺失的交互能力 |
| **[PITFALLS.md](PITFALLS.md)** | 🚧 **踩坑记录** — 13 个血泪教训：多服务器路由、增量合并、workspace_id 解码、幽灵对话等 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **服务器** | Next.js 16（自定义服务器）、WebSocket (ws)、TypeScript |
| **前端** | React 19、shadcn/ui、Tailwind CSS 4、Lucide Icons、Marked |
| **桥接** | gRPC-Web over HTTPS、SQLite (better-sqlite3)、进程发现 (ps + lsof) |
| **协议** | 逆向工程 `exa.language_server_pb.LanguageServerService` |

## 💡 核心使用场景 (Use Cases)

Antigravity Gateway 不仅仅是一个 UI，它是将 AI 能力无缝嵌入你工作流的桥梁：

<p align="center">
  <img src="docs/assets/mobile_coding.png" width="45%" alt="Mobile Coding Concept" />
  &nbsp; &nbsp; &nbsp;
  <img src="docs/assets/api_automation.png" width="45%" alt="API Automation Concept" />
</p>

- 📱 **躺在床上写代码 (Mobile Coding)**：在手机或 iPad 的浏览器上打开 Web UI，通过局域网直连电脑上的 Antigravity，随时随地 Code Review 或解答架构疑惑。
- 🤖 **让 AI 拥有 AI (Subagent Mode)**：通过 REST API，让 n8n、Make 等自动化流，或者你自己的 Python 脚本直接调用 Antigravity 的能力。
- 🔄 **自动巡检与修复 (Cron Jobs)**：结合 CI/CD 或定时任务，每晚自动拉取代码，生成审查报告或更新文档。
- 🤝 **结对编程 (Pair Programming)**：将 `http://<局域网IP>:3000` 分享给办公室的同事，两人可以实时在各自的屏幕上看到 AI 的思考过程并共同协作。

---

## 📱 移动端连接教程 (Mobile Hands-on)

Gateway 原生支持响应式设计（基于 shadcn/ui + Tailwind CSS）。要在手机或平板上使用 Antigravity：

1. **确保在同一局域网**：手机和运行 Gateway 的电脑连接到同一个 Wi-Fi。
2. **获取电脑 IP**：
   - Mac: 设置 -> 无线局域网 -> 你的 Wi-Fi 详情中查看 IP 地址（例如 `192.168.x.x`）
   - 或者跑命令：`ipconfig getifaddr en0`
3. **启动 Gateway**：在电脑上运行 `npm run dev` (确保绑定到 `0.0.0.0` 或不限制 Host，Next.js 默认允许局域网访问)。
4. **手机端访问**：在 Safari 或 Chrome 中输入 `http://192.168.x.x:3000`。
5. **开始聊天**：选择你电脑上已经用 Antigravity 打开的项目（如果没有，选 Playground），尽情享用手机端的全功能 AI 编程助手！

---

## 🐛 已知缺陷 (Known Limitations)

*“缺陷比特性多…” —— 这是目前版本的一些无伤大雅（且懒得修）的折衷：*

1. **🔒 Agent Manager 侧不可见 (One-way Visibility)**：在 Gateway Web 端新建的对话，在官方桌面的 Agent Manager 侧边栏是**看不到的**。但反过来，桌面端新建的对话在 Web 可见，且双方聊天记录双向同步。（深坑详见 [PITFALLS.md](PITFALLS.md) §16）。
2. **🏗️ Playground 新建限制**：Playground 无路径的寻址逻辑较繁琐，目前在 Web 端已隐蔽 / 禁止了直接在 Playground 中新建对话。
3. **⚠️ Action 解析与异常拦截不完整**：目前大量 Action 被默认当作了自动 Approval 处理，解析不完整（比如访问特定 URL 行不行未知）。有时到了最后一步会意外出现一个滞留的 `Proceed` 和 `reject` 按钮，AI 没改好，顺其自然吧。
4. **↩️ 撤回 (Revert) 功能缺陷**：目前的撤回好像只成功撤回了 AI 的回应，我们自己发出的 Prompt 居然还在屏幕上。
5. **⚙️ CLI 无头模式的自动审批**：并没有对 CLI 模式做 Plan 和 Fast 的区分。如果 CLI 中途遇到了需要人工审批的阻塞可能不知所措。建议尽量只运行能够一路畅通的成熟 Workflow 脚本。
6. **🔄 当它 hmm 得时候…**：如果多端同步或 Web 通信偶尔出现抽风异常，请用最原始的方法——强制刷新整个页面。

## 💬 交流与支持

为了方便大家交流使用心得、反馈 Bug、或分享自己写的自动化工作流，我们建立了一个交流群：

<p align="left">
  <img src="docs/assets/group.jpg" width="250" alt="WeChat Group QR Code" />
</p>

**🎉 欢迎加入：Antigravity CLI 交流使用群**

如果你有任何整合 Antigravity 到自己工具链的好点子，或者在无头调用时遇到了障碍，欢迎进群讨论！（你可以随时在群里 @ 开发者获取支持）。

## 🙏 致谢 (Acknowledgements)

本项目的灵感和部分实现参考了以下优秀的开源项目，在此致以诚挚的感谢：
- **[jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)**
- **[AvenalJ/AntigravityMobile](https://github.com/AvenalJ/AntigravityMobile)**

---

## 贡献

欢迎 PR！如果你发现新的 gRPC 端点或修复了路由问题，请更新相关文档：
- 新 API 方法 → `docs/API_REFERENCE.md`
- 新的坑 → `PITFALLS.md`
- 对外 API 变更 → `docs/GATEWAY_API.md`

## 免责声明 (Disclaimer)

本项目是一个出于学习和互操作性（Interoperability）目的构建的**非官方、社区驱动**的开源工具。
- 本项目**不提供**任何绕过付费墙、破解认证或滥用 API 的能力。
- 运行本项目**必须**依赖用户本机已安装并合法认证的官方 Antigravity 桌面应用。
- 所有的调用均消耗用户个人的正常配额。
- 本项目与 Google DeepMind **没有任何关联、授权或背书**。"Antigravity" 的商标权归其原权利人所有。
- 逆向工程的内部 gRPC 接口随时可能发生变化，导致本项目失效。**使用后果由用户自行承担**，开发者不对任何因使用本项目造成的账号风险或数据丢失负责。

## 许可证

MIT

---

<p align="center">
  <sub>以好奇心和逆向工程构建。与 Google DeepMind 无关。</sub>
</p>
