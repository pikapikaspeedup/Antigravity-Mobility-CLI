# Antigravity for Obsidian

## 从信息获取到知识沉淀，一个完整的闭环。

---

## 一个场景，看完整个产品

你正在研究 RAG (Retrieval-Augmented Generation) 架构，想为团队写一份技术选型报告。

### 第一步：收集信息 — Antigravity Gateway

打开 Antigravity Chat，问：**"RAG 的主流架构模式有哪些？各自的优劣？"**

这不是普通的 ChatGPT 对话。Antigravity Gateway 通过浏览器 Agent 帮你搜索 Google、抓取网页、阅读技术博客，把分散在互联网上的信息汇聚成结构化的回答——直接在你的 Obsidian 里。

你可以接着问：**"帮我对比 Naive RAG、Advanced RAG 和 Modular RAG 的 chunk 策略"**。Gateway 继续检索最新论文和博客，把对比结果呈现出来。

你把有价值的信息保存为笔记：`[[RAG架构概览]]`、`[[Chunk策略对比]]`、`[[Vector Database选型]]`。

### 第二步：整理编辑 — GitHub Copilot

现在你有了原始素材，开始写作。

打开 `[[RAG架构概览]]`，边写边用 Copilot：

- **Ghost Text 续写** — 你写到"Naive RAG 的核心局限在于"，Copilot 自动补全后半句，Tab 接受
- **选中一段英文论文摘录 → 浮动工具栏 → 翻译** → 10 种语言一键切换
- **选中粗糙的笔记段落 → 润色 → "专业化"模式** → 措辞变得精准规范
- **自定义 Prompt 模板** — 你定义了 `{{selection}}` + "帮我把这段改写成面向非技术人员的解释"，一键执行

几轮编辑后，你有了一篇 3000 字的 `[[RAG技术选型报告]]`。

### 第三步：知识升维 — 原子化引擎

这篇报告里混了好几个独立主题：chunk 策略、embedding 模型选型、向量数据库对比、retrieval 评估方法。

**自动触发方式**：在笔记头部添加 `type: knowledge` 标记：

```yaml
---
type: knowledge
---
```

标记后，当你写完离开这篇笔记（切换到其他文件），插件**自动触发 AI 分析**——分析结果出现在 Related Notes 侧边栏中，无需手动操作。

你也可以随时**手动触发**：`Ctrl/Cmd + P` → `AI Atom Split` → 回车。

AI 分析报告的 heading 结构和语义边界，弹出拆分预览对话框，建议拆成 4 个独立原子。你逐条审阅后点击确认：

```
[[RAG技术选型报告]]（3000字, standalone）
  ↓ AI Split
[[Chunk策略选型]]（atom, 600字）
[[Embedding模型对比]]（atom, 500字）
[[向量数据库评测]]（atom, 800字）
[[Retrieval评估方法]]（atom, 400字）

原文自动变为：
[[RAG技术选型报告]]（composite）
  ![[Chunk策略选型]]
  ![[Embedding模型对比]]
  ![[向量数据库评测]]
  ![[Retrieval评估方法]]
```

**原子可以被复用。** 下次写 `[[LLM应用架构]]` 时，直接 `![[Chunk策略选型]]` 嵌入，不用重写。

### 第四步：知识关联 — 7 路信号引擎

打开 `[[Chunk策略选型]]`，Related Notes 侧边栏自动亮起：

```
Related Notes:
  📄 RAG技术选型报告      ■■■■■■■■■■ 0.96  embed + link + entity
  🔹 Vector Database选型  ■■■■■■■■○○ 0.81  tag + entity + token
  📝 LangChain笔记       ■■■■■■○○○○ 0.62  entity + semantic
  📝 上周技术调研记录     ■■■○○○○○○○ 0.31  token
```

这不是简单的关键词匹配。引擎跨 7 个维度交叉验证：

- 你嵌入了 `[[Chunk策略选型]]` → 嵌入信号 (权重 4.0)
- 你在 `[[Vector Database选型]]` 中链接了它 → 链接信号 (3.0)
- 两篇笔记共享 #RAG #embedding 标签 → 标签信号 (2.0)
- AI 提取到两篇都提到 "FAISS"、"cosine similarity" → 实体信号 (2.0)
- TF-IDF 词频分布相似 → 词频信号 (1.5)
- AI 语义分析两篇主题接近 → 语义信号 (2.5)

**结构信号 + 内容信号 + 语义信号，三层验证。** 比纯向量搜索更准，因为向量只是其中一路。

### 第五步：知识维护 — Vault Health

一个月后，你的 RAG 研究已经积累了 30 篇笔记。

**操作方式**：按 `Ctrl/Cmd + P` → 输入 `Vault Health Report` → 回车

打开 Vault Health 面板，从上到下展示：

- **健康分 82/100** — 整体连接密度不错
- **知识网络图** — 看到 RAG 相关笔记形成了紧密的星团，但 `[[LLM Fine-tuning 笔记]]` 孤立在角落
- **内容重叠** — `[[Chunk策略选型]]` 和上个月的 `[[文本分割方法]]` 有 70% 重叠 → 点击 **AI Merge** 合并为更完整的原子
- **知识空白** — "HyDE" 被 5 篇笔记提到但还没有独立笔记 → 提示你创建 `[[HyDE假设文档嵌入]]`
- **断链** — `[[LlamaIndex]]` 在 3 处被引用但文件不存在 → 模糊匹配发现 `[[LlamaIndex入门]]` → 一键 Fix

### 第六步：下次研究时

两个月后，你开始研究 Agentic RAG。在 Chat 中问新问题，Gateway 自动检索你 vault 中已有的 RAG 笔记作为上下文：

> "根据你 vault 中的 `[[Chunk策略选型]]` 和 `[[Retrieval评估方法]]`，Agentic RAG 相比传统 RAG 在 retrieval 环节有哪些改进？"

**之前积累的原子成为新研究的起点。知识不再从零开始。**

---

## 这就是完整的闭环

```
收集 ──→ 编辑 ──→ 原子化 ──→ 关联 ──→ 维护 ──→ 复用
  │         │         │          │        │        │
  ▼         ▼         ▼          ▼        ▼        ▼
Gateway   Copilot   AI Split   7路引擎  Health   下一轮
搜索+抓取  续写+翻译  拆分+合并   自动发现  修复+合并  研究
浏览器Agent 润色+模板  升级       关系     空白检测  上下文复用
```

**Antigravity Gateway** 负责把外部信息拉进来。
**GitHub Copilot** 负责在内部精加工。
**原子化引擎** 让知识活起来——被复用、被链接、被维护。

---

## 两大引擎

### Antigravity Gateway — 信息获取

Gateway 是一个可选的后端服务，负责连接外部世界。它可以像你的研究助理一样，主动在互联网上搜索和抓取信息，然后带回你的 Vault。

| 能力 | 说明 |
|------|------|
| **AI 多模型对话** | 在 Obsidian 内直接对话多种 AI 模型，无需切换到浏览器 |
| **浏览器 Agent** | 具备搜索 Google、抓取网页、阅读技术文档的能力。不只是给你链接——它实际阅读页面内容，提取关键信息带回 Vault |
| **Vault 感知上下文** | 聊天时自动搜索你的 Vault，找到相关笔记注入对话上下文。AI 不是凭空回答，而是**基于你已有的知识**来回答 |
| **工作流编排** | 多步骤任务自动化执行，结构化输出。例如"搜索 X → 对比 Y → 生成报告"可以一次完成 |
| **流式输出** | WebSocket 实时推送，打字机效果，不用等整段回复生成完毕 |

### GitHub Copilot — 知识加工

Copilot 集成用你已有的 GitHub Copilot 订阅（无需额外 API Key），在 Vault **内部**完成知识的理解、编辑和组织。

| 能力 | 说明 |
|------|------|
| **Inline 补全** | 编辑时在光标后方显示半透明续写建议（Ghost Text），按 Tab 接受。除 Copilot 外还支持 OpenAI 直连和本地 Ollama |
| **浮动工具栏** | 选中任意文字后弹出快捷操作栏——一键翻译(中英日法德等10语种)、润色(改进/纠错/精简/扩写/简化/专业化/口语化7种模式)、生成摘要、续写、概念解释 |
| **Prompt 模板** | 支持 10+ 变量（`{{selection}}`/`{{input:提示}}`/`{{select:选项}}`/`{{var:自定义}}`），你可以创建任意数量的模板，打造属于自己的 AI 写作工作流 |
| **7 路关系引擎** | 同时分析嵌入、链接、语义、标签、实体、词频、标题 7 个维度的信号，交叉验证后加权计算相关度。比纯向量搜索更准确，因为向量只是 7 路中的一路 |
| **AI 原子操作** | Split（把长文拆成可复用的知识积木）、Merge（把重叠内容合并成一篇更完整的笔记）、Upgrade（从其他笔记提取新信息补充原子）。**所有操作需要你确认，AI 分析你决策** |
| **Vault Health** | 知识库体检报告：健康分 + 交互式网络图 + 断链修复 + 重叠检测 + 知识空白发现。一个命令看到你所有笔记的关系全貌 |
| **LinkSuggester** | 编辑时自动检测你输入的文字是否匹配 Vault 中某篇笔记的标题——匹配到就弹出建议，Tab 插入 `[[link]]`。800ms 防抖，不打断写作节奏 |
| **AI 增强** | GPT-4o 提取实体/主题/关键词/摘要，text-embedding-3-small 生成 1536 维向量嵌入——这些数据让 Related Notes 的关系计算从 6 路升级到 7 路 |

---

## 无 AI 也能用

不是所有人都需要 AI，也不是所有场景都需要联网。插件的每一层都可以独立工作——从完全离线到全功能，根据你的需求和订阅状态自动适配：

| 层级 | 需要什么 | 获得什么 |
|------|---------|---------|
| **L0 本地** | 什么都不需要 | Related Notes（基于链接/标签/词频/标题 4 路信号发现关系）、LinkSuggester（编辑时链接建议）、Vault Health（健康分/网络图/断链修复/孤立笔记检测）、笔记角色自动分类 |
| **L1 Copilot** | GitHub Copilot 订阅 | 以上全部 + Inline Ghost Text 续写、浮动工具栏（翻译/润色/摘要等）、AI 实体/主题/向量提取（Related Notes 升级到 7 路信号）、原子 Split/Merge/Upgrade |
| **Full** | + Antigravity Gateway | 以上全部 + AI 多模型对话、浏览器 Agent 网页搜索与抓取、Vault 感知上下文聊天、工作流编排 |

---

## 开始使用

```bash
npm install && npm run build
cp main.js manifest.json styles.css <VaultPath>/.obsidian/plugins/obsidian-antigravity/
```

1. 启用插件 → 打开 Related Notes → 切换笔记查看关系
2. （可选）设置 → 登录 Copilot → `AI Enrich Notes` 批量增强 
3. `Vault Health Report` → 看到你的知识网络全貌

---

## v0.2.1 更新

- **更快** — 标签检索倒排索引，O(1) 查找
- **更稳** — IndexedDB 连接缓存，不再反复开关
- **更安全** — AI 文件名自动清洗非法字符
- **更一致** — 知识网络图确定性布局
- **60 个自动化测试** — 覆盖引擎全生命周期

---

## 未来路线

### 定期增量信息获取（Scheduled Knowledge Ingestion）

设定一组监控主题（如 "RAG 最新进展"、"LLM Agent 架构"），Antigravity 按你的节奏自动执行：

```
每周一 09:00
  → Gateway 搜索指定主题的最新博客、论文、讨论
  → AI 提取关键信息，与 vault 中已有原子做增量对比
  → 生成 [[Weekly RAG Update - W28]]（状态：待审）
  → 高亮新增内容 vs 已知内容
  → 你 Review → 确认 → 新知识自动原子化并链接到已有网络
```

**知识不再是你主动搜索才会更新的。它自己持续生长，你只需要审核。**

这是闭环的最后一环——从"你驱动知识"变成"知识驱动你"。
