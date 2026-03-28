# Obsidian Antigravity — 知识原子化智能体

> AI 驱动的原子化知识管家，让你的 Vault 变成一个自组织的知识网络。

## 它解决什么问题？

笔记越多越难用——你知道某个概念写过，但不记得在哪；两篇笔记明明有关，但从来没链接过。传统搜索只能解决"我知道要找什么"，却无法告诉你"还有什么相关的你不知道"。

Antigravity 用两个引擎解决这个问题：
- **Antigravity Gateway**：从外部（搜索引擎、网页、AI 对话）把信息拉进你的 Vault
- **GitHub Copilot 集成**：在 Vault 内部做智能加工——理解笔记关系、辅助编辑、拆分合并为可复用的知识原子

两个引擎都是**可选的**。即使不连接任何 AI 服务，核心的关系发现和健康分析功能也能完全离线使用。

## 功能一览

插件功能分两个层级——**L0 完全离线可用**，L1 需要 GitHub Copilot 订阅（如有疑问参见 [用户指南](docs/user-guide.md#功能分层l0-和-l1)）：

| 功能 | 说明 | 层级 |
|------|------|------|
| **Related Notes** | 打开任意笔记，侧边栏自动展示最相关的 10 篇笔记。通过 7 个维度（链接、嵌入、标签、实体、词频、标题、语义）交叉计算相关度，比纯关键词搜索更准确 | L0 (本地) |
| **LinkSuggester** | 你在编辑时输入的文字如果匹配了 Vault 中某篇笔记的标题，会自动弹出建议浮窗——按 Tab 即可插入 `[[链接]]`，不打断写作节奏 | L0 |
| **Vault Health** | 一键生成知识库"体检报告"：健康分(0–100)、孤立笔记、重复内容、知识空白（你常提到但没有独立笔记的概念）、交互式网络可视化图 | L0 |
| **Broken Link Fixer** | 自动扫描所有指向不存在文件的 `[[链接]]`，通过模糊匹配和实体分析找到可能的正确目标，一键修复 | L0 |
| **AI Enrich** | 让 Copilot 批量阅读你的笔记，自动提取每篇笔记的关键实体、主题、关键词、摘要和向量嵌入——增强后 Related Notes 的准确度显著提升 | L1 (需 Copilot) |
| **Atom Split** | AI 分析一篇长笔记的多个主题边界，建议拆分为多个独立的"原子笔记"（每个原子只聚焦一个主题，可被多篇文章复用）。原文自动变为嵌入引用这些原子的"组合笔记" | L1 |
| **Atom Merge** | 当两篇笔记内容高度重叠时，AI 智能合并为一篇更完整的笔记，原文归档不删除 | L1 |
| **Atom Upgrade** | 当 Vault 中其他笔记包含与某个原子相关的新信息时，AI 自动提取并追加到原子末尾 | L1 |
| **Vault-aware Chat** | 在 Obsidian 内与 AI 对话。与普通聊天不同，AI 会自动搜索你的 Vault，找到相关笔记作为参考来回答——基于你自己的知识来回答你的问题 | L1 |
| **浮动工具栏** | 选中文字后弹出工具栏：一键翻译(10语种)、润色(7种模式)、摘要、续写、解释。支持自定义 Prompt 模板，用变量 `{{selection}}`/`{{input:提示}}` 打造个人工作流 | L1 |

## 安装

1. 将 `main.js`、`manifest.json`、`styles.css` 复制到 Vault 的 `.obsidian/plugins/obsidian-antigravity/` 目录
2. 重启 Obsidian → 设置 → 第三方插件 → 启用 "Google Antigravity Obsidian"
3. （可选）设置页面登录 GitHub Copilot 以启用 L1 AI 功能

### 从源码构建

```bash
cd plugins/obsidian-antigravity
npm install
npm run build          # → main.js (217kb)
npm test               # → 60 tests, <1s
```

## 快速上手

### 1. 查看相关笔记

打开任意笔记 → 点击侧边栏的 🔗 图标（或命令面板 `Open Related Notes Panel`）

引擎自动计算 7 路信号：链接、嵌入、标签、实体、Token、标题、语义，加权排序展示 top 10 相关笔记。每个维度有不同的权重——嵌入关系(权重4.0)最重要，因为你主动嵌入的笔记相关性最高；标题相似度(权重1.0)最低，因为标题匹配可能只是巧合。

> 💡 不需要 Copilot 也能使用——没有 AI 时使用 6 路信号（跳过语义），依然能有效发现笔记关系。

### 2. 启用 AI 增强

设置 → Antigravity → 登录 Copilot → 命令面板 `AI Enrich Notes (Copilot)`

批量为笔记提取 AI 实体/主题/关键词/摘要和向量嵌入（每次最多处理 20 篇，可反复运行直到全部完成）。增强后 Related Notes 的第 7 路语义信号会被激活，让关系发现更准确。

### 3. 原子化工作流

**什么是原子化？** 一个主题只存在一个地方，被多处引用——像积木一样复用。

1. 打开一篇包含多个主题的长笔记 → 命令面板 `AI Atom Split` → 查看 AI 建议的拆分方案 → 确认执行
2. 原文自动转为"组合笔记"（用 `![[原子名]]` 嵌入引用各原子），每个原子可以被其他文章独立引用
3. `Vault Health Report` 持续追踪：发现内容重叠可合并(Merge)、发现知识空白可补充、发现断链可修复

## 命令列表

| 命令 | 快捷说明 |
|------|---------|
| `Open Google Antigravity Chat` | 打开聊天面板 |
| `Open Related Notes Panel` | 打开相关笔记侧边栏 |
| `Rebuild Knowledge Index` | 全量重建索引 |
| `AI Enrich Notes (Copilot)` | 批量 AI 增强（max 20） |
| `Vault Health Report` | 打开健康报告面板 |
| `AI Atom Split (Current Note)` | AI 拆分当前笔记 |
| `AI Atom Upgrade (Current Note)` | AI 升级当前原子 |
| `Export Debug Logs` | 导出日志到剪贴板 |
| `Clear Debug Logs` | 清空日志 |
| `Manage Prompt Templates` | 管理 Prompt 模板 |

## 技术概览

- **引擎**: 7 路加权信号交叉验证笔记关系。权重从高到低：嵌入(4.0) > 链接(3.0) > 语义(2.5) > 标签=实体(2.0) > 词频(1.5) > 标题(1.0)。这意味着你主动创建的结构关系（链接、嵌入）比 AI 推断的语义关系更受信任
- **存储**: IndexedDB 优先（缓存连接，性能更好），不支持时自动回退到 JSON 文件存储
- **AI**: GitHub Copilot API — gpt-4o 用于分析（提取实体/主题/原子操作），text-embedding-3-small 用于向量嵌入（1536 维，计算语义相似度）
- **限流**: 所有 AI 请求间隔 ≥800ms，单篇笔记内容截断至 3000 字，避免 API 过载
- **测试**: vitest 60 tests，覆盖引擎核心(19)、API 解析(6)、断链修复(8)、原子操作(5)、完整生命周期集成(22)

## 许可

详见 [LICENSE](../../LICENSE)
