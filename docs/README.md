# 文档索引

## 使用指南 (`guide/`)

| 文档 | 说明 | 受众 |
|------|------|------|
| [antigravity-2.md](guide/antigravity-2.md) | Antigravity 2.0 使用指南：hub、Project 文件夹、账号风险 | 用户 |
| [agent-user-guide.md](guide/agent-user-guide.md) | Multi-Agent 系统完整用户手册：Group、Pipeline、Workflow、产物体系 | 用户 |
| [cli-guide.md](guide/cli-guide.md) | `ag` CLI 命令使用指南 | 用户 |
| [gateway-api.md](guide/gateway-api.md) | Gateway REST + WebSocket API 完整参考（对话、项目、Run、环境接口）| 开发者 |
| [cli-api-reference.md](guide/cli-api-reference.md) | Agent/Project 调度 REST 端点详细参考 | 开发者 |
| [grpc-reference.md](guide/grpc-reference.md) | Language Server gRPC 协议逆向工程参考 | 开发者 |
| [knowledge-api.md](guide/knowledge-api.md) | Knowledge Items API | 开发者 |
| [mcp-server.md](guide/mcp-server.md) | MCP Server 配置与 5 个 Tool 说明 | 集成者 |
| [remote-access.md](guide/remote-access.md) | Cloudflare Tunnel 远程访问设置 | 运维 |
| [wechat-setup.md](guide/wechat-setup.md) | 微信 × Claude Connect (cc-connect) 设置指南 | 用户 |
| [obsidian-setup.md](guide/obsidian-setup.md) | Obsidian 插件安装与配置指南 | 用户 |
| [logging-standards.md](guide/logging-standards.md) | Pino 结构化日志规范 | 开发者 |

## 内部参考 (`internals/`)

| 文档 | 说明 |
|------|------|
| [agent-internals.md](internals/agent-internals.md) | Agent 系统内部实现：gRPC 调用链、Owner 路由、结果提取 |
| [extensibility-architecture.md](internals/extensibility-architecture.md) | 可扩展性架构：Phase 1-5 演进路线、约束分析 |
| [data-architecture-migration.md](internals/data-architecture-migration.md) | 数据层解耦迁移方案 (Phase 1 ✅ 已完成) |
| [state-db-data-map.md](internals/state-db-data-map.md) | StateDB (SQLite state.vscdb) 数据映射与对话数据源对比 |
| [permission-system.md](internals/permission-system.md) | 权限系统逆向工程：三层模型、toolConfig、审批流程 |
| [cdp-reverse-engineering.md](internals/cdp-reverse-engineering.md) | Chrome DevTools Protocol 研究（决策：不采用）|
| [headless-language-server.md](internals/headless-language-server.md) | Headless Language Server 研究（决策：暂缓）|

## 其他

| 文档 | 说明 |
|------|------|
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | 产品整体架构（根目录）|
| [../README.md](../README.md) | 项目 README |
