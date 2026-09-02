# Antigravity 2.0 使用指南

Gateway 当前只对接 **Antigravity 2.0 桌面应用** 的单个 hub Language Server，不再使用 1.x 的「每个 workspace 一个 language_server」。

2.0 的 Project **就是一组本地文件夹路径 + 读写权限**。官方新建 Project，本质上也是打开某个目录并登记到 `~/.gemini/config/projects/`。Gateway 可以直接用路径创建同样的 Project，不必再去官方 UI 点一遍。

---

## 前提

- macOS Apple Silicon
- **Antigravity 2.0**（`Antigravity.app`）已安装并保持运行
- Node.js ≥ 20

1.x 的 `Antigravity IDE.app` 不再作为后端。关掉 2.0 后，聊天和 Agent 都会不可用。

---

## 启动

```bash
cd Antigravity-Mobility-CLI
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。局域网用 `http://<你的IP>:3000`。

确认 hub 已被发现：

```bash
curl http://localhost:3000/api/servers
# [{"pid":...,"port":...,"csrf":"...","ideVersion":"2.11.0"}]
```

---

## 绑定文件夹（Project）

侧栏「开始对话」：

1. **已有 Project**：下拉选择。会看到该 Project 里的目录，以及可写 / 只读。
2. **新文件夹**：在路径框填绝对路径，例如 `/Users/you/code/my-app`，点 **用这个文件夹创建**。
   - 这个目录已经在某个 Project 里 → 直接复用
   - 没有 → 调用官方 `CreateProject`，在 2.0 里登记同一个 Project

然后点 **开始对话**。之后模型读写都落在该 Project 的文件夹上，并遵守 `allowWrite`。

命令行等价操作：

```bash
# 列出 2.0 Project
curl http://localhost:3000/api/hub-projects

# 用文件夹创建（或复用）Project
curl -X POST http://localhost:3000/api/hub-projects \
  -H 'Content-Type: application/json' \
  -d '{"folderPath":"/Users/you/code/my-app"}'

# 在该 Project 下新建对话
curl -X POST http://localhost:3000/api/conversations \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"<hub-project-id>"}'
```

Agent 派发同样要选 Project（字段名 `hubProjectId`），避免和 Gateway 自己的流水线 `projectId` 混在一起。

---

## 和官方的关系

| | 官方 2.0 | Gateway |
|--|---------|---------|
| 后端 | 本机 hub Language Server | 同一个 hub |
| Project | 文件夹路径 + `allowWrite` | 同一份 `~/.gemini/config/projects/*.json` |
| 新建 Project | 在 UI 里选目录 | 填路径，走同一个 `CreateProject` |
| 对话列表 | 官方侧栏 | Web UI 独立列表（官方未必能看到 Gateway 新建的对话） |

侧栏里的 **Projects** 标签仍是 Gateway 自己的 Multi-Agent 流水线，不是 2.0 的文件夹 Project。

---

## 账号风险（不确定会不会封）

**不知道会不会被封号。** 本项目是非官方客户端，通过逆向本地 gRPC 使用你的 Antigravity 订阅。

Google 官方 FAQ 写明：使用第三方软件、工具或服务访问 Antigravity **违反服务条款**，可能导致账号暂停或终止。2026 年 2 月曾有一批 OpenClaw / OpenCode 用户因此被停用 Antigravity / Gemini Code Assist。

Gateway 的流量仍经过官方 `language_server`，**不等于合规，也不等于安全**。用不用、怎么用，后果自负。不想承担条款风险，请只用官方应用，或改用 Vertex / AI Studio 的 API Key。
