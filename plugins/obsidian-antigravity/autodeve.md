# Antigravity Obsidian Plugin — 开发蓝图

> 产品定位：**知识原子化智能体** — AI 驱动的原子化知识管家
> 核心主张：Vault 的价值 ≠ 文章数量，Vault 的价值 = 原子的质量 × 原子间的连接密度

---

## 〇、产品宪法 — 两个核心理念

### 理念 1：信息原子化

所有信息最终都会被原子化（卡片化），可以不断向下拆分。
- 文章是原子的组合 —— 通过 `![[嵌入]]` 或 `[[链接]]` 引用原子
- 同一个原子可以被多篇文章复用
- 目标不是管理文件，而是管理**知识单元**

### 理念 2：增量知识增长

所有信息操作的目标是增长和精炼原子层，而不是增加文章数量。
- 操作 = 新增原子 | 更新原子 | 淘汰过时原子
- 鼓励**更新已有原子**，而非重复创建相似内容
- 引擎的角色：不是搜索引擎，是**知识管家**

### 原子的定义

**原子 = 一个可以独立理解、独立复用的知识单元。**

> 衡量标准：把这个笔记 `![[嵌入]]` 到另一篇完全不同的文章里，
> 读者不需要额外背景就能理解它，并且它对他有用。

| 维度 | 定义 |
|------|------|
| **范围** | 一个概念/流程/决策/方法的**完整阐述** |
| **深度** | 足够让你**据此行动**，不只是知道名词 |
| **长度** | 通常 200-1000 字（不是硬性规则） |
| **标题** | 看标题就知道里面讲什么 |
| **自包含** | 嵌入到任何文章中都能独立成段 |
| **聚焦** | 如果你能用 "and" 描述它的主题，它可能应该拆 |

好例子 ✅：
- `[[ACN 认证申请流程]]` — 怎么申请, 步骤, 时间, 坑
- `[[MIMIT 补贴计算方法]]` — 补贴比例, 计算公式, 上限, 条件
- `[[Go-to-Market 渠道选择框架]]` — 评估维度, 决策流程

反例 ❌：
- `[[ACN]]` — 太短, 只是定义/词条
- `[[NIS2 完全手册]]` — 太大, 混了判定+合规+处罚+路径
- `[[2024年1月会议记录]]` — 不可复用的时效性内容

### 笔记角色三分类

| 角色 | 特征 | Vault 中的表现 |
|------|------|----------------|
| **原子 (Atom)** | 聚焦, 可复用 | 200-1000字, 被 ≥2 篇嵌入/引用 |
| **组合 (Composite)** | 由原子构成 | 多个 `![[嵌入]]`, 是原子的"视图" |
| **独立 (Standalone)** | 尚未原子化 | 中/大篇幅, 可能需要拆分 |

### 引擎的角色：知识管家 (Knowledge Steward)

```
知识管家
├── 感知层: 原子检测 + 角色分类 + 嵌入图谱
├── 守护层: 去重检测 + 缺口发现 + 健康度追踪
├── 回忆层: 多路召回 + 原子级关系 (已完成)
└── 行动层: 建议更新原子 / 建议创建原子 / 建议嵌入
```

原子化应该是**自然的，不是强迫的**：
- 引擎**建议**但不强制
- 拆分的动机是**复用价值**，不是格式规范
- 提示时机要对："这部分可以独立出来，在 3 个地方复用"

### 原子化触发策略

**核心：用户主动标识 + AI 辅助执行。不标识的笔记不被原子化。**

#### Frontmatter `type` 标识 (用户决策)

用户通过 Obsidian Properties (原生 UI) 设置笔记类型：

```yaml
---
type: atom        # 这是一个已完成的原子
---
```

```yaml
---
type: knowledge   # 知识类内容, 允许 AI 分析和建议原子化
---
```

| type 值 | 含义 | 引擎行为 |
|---------|------|---------|
| `atom` | 这是一个原子 | 追踪复用度, 参与原子网络, 不建议拆分 |
| `knowledge` | 知识类, 可原子化 | 自动触发 AI 分析, 给出拆分/合并/升级建议 |
| 无 / 其他 | 普通笔记 (standalone) | 只做 Related Notes 关系, 不触发原子化 |

适合标记为 `knowledge` 的内容: 知识沉淀、分析文档、竞品分析、流程文档
不需要标记的内容: 会议纪要、工作日志、灵感草稿、项目计划

#### 引擎逻辑

```
indexNote(file):
  noteType = frontmatter?.type || 'standalone'

  所有笔记: L0 本地分析 (Related Notes 关系, 无 API 开销)

  if noteType === 'atom':
    → 追踪 reuseCount, 参与原子健康度计算
    
  if noteType === 'knowledge'
     AND wordCount >= 800
     AND headingCount >= 3:
    → 等待沉淀 (5分钟无编辑 或 用户切换到其他笔记)
    → L1 AI 全流程分析 → 具体行动建议
    
  if noteType is 'standalone' or 条件不满足:
    → 仅 L0, 不触发 AI 分析, 不建议原子化
```

#### 规模门槛 (knowledge 类型的额外过滤)

| 条件 | 门槛 | 原因 |
|------|------|------|
| 单篇笔记字数 | ≥ 800 字 | 太短的已经是原子级别 |
| 笔记包含 Heading 数 | ≥ 3 个 H2 | 没有结构的笔记不好自动拆分 |

#### 沉淀时间 (避免打断编辑)

```
knowledge 笔记修改 → 等待沉淀期 (默认 5 分钟无编辑) → L1 AI 分析
  ↓
  用户还在编辑: 计时器重置 → 不打断
  用户停了 5 分钟: 后台运行 → 建议静默出现在侧边栏
  用户切到其他笔记: 立即触发 (用户已离开)
```

#### 用户控制

```
设置面板:
  ☑ 启用原子化建议 (默认开启)
  ☑ 启用拆分建议
  ☑ 启用合并/升级建议
  ☐ 启用维护提醒 (默认关闭)
  沉淀等待时间: [5] 分钟
```

#### 自动命名与分类

| 自动项 | 策略 |
|--------|------|
| **原子标题** | AI 基于内容生成, 格式: "主题 + 焦点" (如 "MIMIT 申请资格") |
| **文件夹位置** | 默认与原文同文件夹, AI 可建议更合适的分类位置 |
| **标签继承** | 从原文继承相关标签, AI 可建议调整 |
| **type 属性** | 拆分出的新笔记自动设置 `type: atom` |

### 成功标准

```
原子化成功 = 
  1. 信息冗余降低: 同一概念不在 3 个地方重复出现
  2. 检索效率提升: 通过 [[双链]] 和知识图谱快速找到需要的信息
  3. 知识复用率: 原子被 ≥2 篇笔记引用/嵌入

不追求:
  × 原子数量最大化 (碎片化不是目标)
  × 100% 覆盖率 (不是每篇笔记都需要原子化)
  × 强制所有笔记标注 type (写作类笔记无需标识)
```

### 成本控制原则：渐进式智能 (Progressive Intelligence)

**AI 必须主动评估和给出具体行动建议。** 原则是**质量优先、零浪费** — 预算可以多，但不做无意义的重复计算。

#### 核心原则

```
1. 凡修改 → 全流程分析 (不省这个钱)
   笔记保存且 contentHash 变化 → L0 + L1 都跑一遍

2. 凡没变 → 零调用 (不浪费)
   contentHash 相同 → 跳过, 复用缓存的建议

3. 凡有机会 → 生成具体建议 (不省质量)
   发现拆分/合并/升级机会 → 直接给具体方案, 用最好的模型 (gpt-4o)

4. 凡已建议 → 不重复 (不浪费)
   上次的建议还没处理 → 不再重新生成
   用户点了"忽略" → 不再提示此项 (直到内容变化)
```

#### 什么算浪费 vs 什么不是

| 浪费 ❌ 减掉 | 不是浪费 ✅ 保留 |
|------------|--------------|
| contentHash 没变 → 重复分析同样的内容 | 每次修改后 → 全流程分析 |
| 200 字以下的笔记 → 分析是否拆分 | 新保存的笔记 → 检查所有机会 |
| L0 零信号的笔记对 → 跑重叠检测 | 修改后 → 检查与现有原子的重叠 |
| 上次建议用户还没处理 → 再生成一遍 | 内容变化后 → 重新生成建议 |
| 已经是原子的笔记 → 反复检查拆分 | 拆分/合并后 → 重新分析受影响笔记 |

#### L0/L1 分层策略

```
L0 (纯本地计算, 无 API 开销, 每次保存自动运行):
  ├── 字数统计, Heading 结构分析
  ├── TF-IDF 余弦相似度 (与其他笔记)
  ├── 实体重合度检测
  ├── 嵌入/引用计数 → reuseCount, 角色分类
  └── 原子化机会打分 (0-100) → 决定建议的展示优先级

L1 (AI 调用, 仅 knowledge 类型 + contentHash 变化时触发):
  ├── 精确拆分边界 + 建议原子标题
  ├── 重叠内容分析 + 合并建议
  └── 升级建议 (从其他笔记提取补充信息)
```

#### AI 主动建议 (具体、可行动)

AI 主动在侧边栏呈现具体行动建议：

```
✂ 拆分建议 (自动出现)
  "这篇笔记有 3 个独立话题，建议拆分为:
   → [[ACN 认证流程]] (Lines 1-45)
   → [[ACN 费用结构]] (Lines 46-72)
   → [[ACN 常见问题]] (Lines 73-95)
   [执行拆分] [稍后]"

🔀 合并建议 (自动出现)
  "[[MIMIT补贴申请]] 和 [[MIMIT资格条件]] 重叠 75%
   建议合并为 [[MIMIT补贴申请指南]]
   [合并] [查看差异] [忽略]"

⬆ 升级建议 (自动出现)
  "[[NIS2合规要求]] 可补充:
   · 会议纪要0312 提到了新处罚标准
   [查看建议修改] [忽略]"

⚠ 维护提醒 (自动出现)
  "[[NIS2合规要求]] 被 8 篇引用, 90 天未更新
   [打开编辑] [标记仍有效]"
```

#### 日均调用估算 (40 篇 vault)

```
日均修改 ~3 篇 → contentHash 变化 3 次
  每次: L0 (免费) + L1 (1 次 gpt-4o 完整分析)
  日均: ~3 次 Copilot API 调用 ← 完全可承受
  
打开未修改的笔记: 缓存命中 → 0 次调用
用户感知: "每次修改后都有最新的、具体的建议"
```

---

## 一、产品愿景

### 差异化价值
不是"在 Obsidian 里嵌入一个 ChatGPT"，而是一个**AI 驱动的知识原子化管家**。

- 每篇笔记保存时，引擎自动分析内容、提取实体、计算关系
- 自动识别笔记角色（原子/组合/独立），追踪原子复用度
- 发现重复内容 → 建议更新已有原子而非重复创建
- 检测知识缺口 → 建议创建缺失的原子
- 相关笔记实时浮现在侧边栏，无需手动搜索
- 有 AI Provider 时，引擎升级为语义级别的知识理解
- 无 AI 时，仍是一个高效的本地知识引擎

### 核心体验
```
用户写完一篇笔记 → 保存
  ↓
侧边栏自动显示 5-10 篇相关笔记
  ├─ 🔷 "原子: ACN认证流程 — 共享实体"
  ├─ 📄 "组合: NIS2合规总览 — 嵌入了相同原子"
  ├─ ⚠️ "这段内容与 [[MIMIT补贴计算]] 85% 重叠 → 建议嵌入"
  └─ 💡 "发现未原子化的概念: 渠道激励政策 → 建议创建"
```

---

## 二、系统架构

### 2.1 总览

```
┌── Vault 事件层 ──┐     ┌── 知识关系引擎 ──────────────────────────────┐     ┌── UI 层 ──────┐
│ file:create      │     │                                              │     │               │
│ file:modify      │────→│  Indexer (提取 + 索引更新)                   │────→│ 相关笔记侧边栏│
│ file:delete      │     │    ├─ ContentHasher  (变更检测, 跳过无变化)  │     │               │
│ file:rename      │     │    ├─ TokenExtractor (分词 + 去停词)         │     │ 链接建议气泡  │
│ metadata:change  │     │    ├─ EntityExtractor(实体/概念抽取)         │     │               │
└──────────────────┘     │    ├─ TopicExtractor (标题/Heading主题)      │     │ 状态栏提示    │
                         │    └─ IndexUpdater   (增量写入索引)          │     │               │
                         │                                              │     │ Dashboard视图 │
                         │  Retriever (多路召回)                        │     └───────────────┘
                         │    ├─ GraphRecall    (链接图 1-2 hop 邻居)   │
                         │    ├─ TagRecall      (标签共现)              │
                         │    ├─ TokenRecall    (倒排索引关键词匹配)    │
                         │    ├─ EntityRecall   (实体/概念共现)         │
                         │    ├─ TitleRecall    (标题实义词匹配)        │
                         │    └─ SemanticRecall (可选, Embedding向量)   │
                         │                                              │
                         │  Ranker (精排 + 去重 + 多样性)               │
                         │    ├─ WeightedScorer (加权评分模型)          │
                         │    ├─ DiversityFilter(分散同源, 防同质化)    │
                         │    ├─ RecencyBoost   (新修改笔记加成)        │
                         │    └─ ReciprocityBonus(互相关联加分)         │
                         │                                              │
                         │  Store (持久化存储)                          │
                         │    ├─ NoteProfiles   (每篇笔记的特征画像)    │
                         │    ├─ InvertedIndex  (词 → 笔记集合映射)     │
                         │    ├─ EntityIndex    (实体 → 笔记集合映射)   │
                         │    ├─ RelationCache  (预计算的 top-N 关系)   │
                         │    └─ EmbeddingStore (可选, 向量存储)        │
                         └──────────────────────────────────────────────┘
```

### 2.2 双层渐进设计

核心原则：**L0 永远可用（纯本地），L1 是可选 AI 增强**

| 层级 | 执行方式 | 依赖 | 延迟 | 功能 |
|------|---------|------|------|------|
| **L0 基础层** | 同步/立即 | Obsidian API + 纯 JS | ~5ms | 正则实体、TF-IDF、链接/标签分析 |
| **L1 增强层** | 异步/后台 | Copilot 或 Antigravity (可选) | ~300ms | 精准实体、语义主题、关键概念、摘要 |

```
笔记保存 → L0 立即执行 (正则 + TF-IDF → 更新索引 → 刷新侧边栏)
           ↓
         L1 异步执行 (AI 提取 → 合并结果 → 静默刷新侧边栏)
```

### 2.3 Provider 无关设计

```typescript
interface KnowledgeProvider {
  extractEntities(content: string): Promise<string[]>;
  extractTopics(content: string): Promise<string[]>;
  extractKeywords(content: string): Promise<string[]>;
  generateSummary(content: string): Promise<string>;
  // 可选: embedding
  getEmbedding?(content: string): Promise<number[]>;
}

// Copilot 实现
class CopilotKnowledgeProvider implements KnowledgeProvider { ... }
// Antigravity 实现
class AntigravityKnowledgeProvider implements KnowledgeProvider { ... }
// 无 AI 回退
class LocalKnowledgeProvider implements KnowledgeProvider {
  // 全部使用 regex + 统计方法实现
}
```

---

## 三、存储方案

### 3.1 索引持久化

索引与用户设置（`data.json`）完全分离。索引可随时删除重建，不影响配置。

```
.obsidian/plugins/obsidian-antigravity/
├── data.json                  ← 用户设置 (plugin.saveData)
├── knowledge-index.json       ← 知识索引 (vault.adapter.write)
├── main.js
├── manifest.json
└── styles.css
```

**存储抽象**:
```typescript
interface IndexStore {
  load(): Promise<KnowledgeIndex | null>;
  save(index: KnowledgeIndex): Promise<void>;  // debounced 2s
  clear(): Promise<void>;                       // 删除重建
}

// Phase 1: 单 JSON 文件 (vault.adapter.read/write)
class FileIndexStore implements IndexStore { ... }
// 未来可迁移: IndexedDB (大 vault) 或 多文件分片
```

**写入策略**:
- debounce 2s: 短时间内多次修改只写一次
- 差异检测: 只在索引实际变化时写入
- 容错: 写入失败不影响运行，下次启动时重建

---

## 四、核心数据模型

```typescript
/** 每篇笔记的结构化画像 */
interface NoteProfile {
  path: string;                  // 唯一标识 (文件路径)
  contentHash: string;           // 内容哈希 (变更检测, 跳过未修改笔记)
  tokens: string[];              // 关键词 (去停词后)
  entities: string[];            // 命名实体/概念 (L0: 正则, L1: AI增强)
  topics: string[];              // 主题 (L0: Heading文本, L1: AI语义)
  tags: string[];                // Obsidian 标签 (metadataCache)
  outLinks: string[];            // 出链 (metadataCache)
  wordCount: number;             // 文档长度 (用于TF-IDF归一化)
  lastModified: number;          // 最后修改时间
  enrichedByAI: boolean;         // 是否经过 AI 增强
}

/** 两篇笔记间的关系 */
interface Relationship {
  target: string;                // 相关笔记路径
  score: number;                 // 综合相关度 (0.0 ~ 1.0)
  signals: {
    linkDistance?: number;        // 链接距离: 1=直连, 2=2-hop, 0=无路径
    sharedTags?: number;         // 共享标签数量
    tokenSim?: number;           // TF-IDF 余弦相似度 (0-1)
    entityOverlap?: number;      // 共享实体/概念数量
    titleSim?: number;           // 标题 Jaccard 相似度 (0-1)
    semanticSim?: number;        // Embedding 余弦相似度 (可选, 0-1)
  };
  type: 'explicit' | 'inferred'; // 显式链接 vs 推断关系
}

/** 全局知识索引 */
interface KnowledgeIndex {
  version: number;                              // 索引版本, 用于迁移
  totalNotes: number;                           // 总笔记数
  profiles: Record<string, NoteProfile>;        // 路径 → 画像
  tokenIndex: Record<string, string[]>;         // 词 → 笔记路径集
  entityIndex: Record<string, string[]>;        // 实体 → 笔记路径集
  docFrequency: Record<string, number>;         // 词 → 包含该词的文档数 (IDF)
  relations: Record<string, Relationship[]>;    // 路径 → 排序后的 top-N 关系
  lastFullBuild: number;                        // 上次全量索引时间
}
```

---

## 五、算法设计

### 4.1 索引更新流水线

```
笔记 A 被修改:

Step 1: 变更检测                              ≈ 0ms
  hash = simpleHash(content)
  if hash === profiles[A].contentHash → SKIP (无变化)

Step 2: L0 画像提取                            ≈ 5ms
  ├─ 分词: content.split(/\W+/) → 过滤停词 → 词干化(可选)
  ├─ 正则实体: [[wikilinks]] + /[A-Z][a-z]+(\s[A-Z][a-z]+)+/ + 引号内容
  ├─ 标题主题: heading 文本
  └─ 元数据: metadataCache → tags, links, wordCount

Step 3: 增量更新索引                           ≈ 2ms
  ├─ diff(旧tokens, 新tokens) → 增删 tokenIndex 条目
  ├─ diff(旧entities, 新entities) → 增删 entityIndex 条目
  └─ 更新 docFrequency 计数

Step 4: 多路召回 + 精排                        ≈ 10ms
  ├─ 6路召回 → 候选集 (~50-200 篇, 见 §4.2)
  ├─ 加权评分 → 排序 (见 §4.3)
  └─ 后处理 (多样性/去噪) → top-10
  → 写入 relations[A]

Step 5: 级联更新                               ≈ 5ms
  ├─ 对 A 的 top-10 中的每篇 B:
  │   检查 A 是否改变了 B 的 top-10 → 如有变动, 更新 relations[B]
  └─ 通知 UI 刷新

Step 6: L1 异步增强 (有 Provider 时)           ≈ 300ms, 后台
  ├─ AI 提取精准实体/主题/关键词 → 调 provider.extractEntities(content)
  ├─ 合并到 profile (enrichedByAI = true)
  ├─ 重新计算该笔记的关系
  └─ 静默刷新 UI

Step 7: 持久化 (debounced 2s)
  └─ plugin.saveData(index) 或 写入 IndexedDB
```

### 4.2 多路召回策略

**目标**：将搜索空间从全 vault (M 篇) 缩小到 ~50-200 个候选

```
路径①: 图谱召回          数据源: metadataCache.resolvedLinks     O(1)
  A 的出链 + 入链 → [B, C]
  B 的出链+入链 + C 的出链+入链 → [D, E, F, G]   (2-hop 邻居)

路径②: 标签召回          数据源: metadataCache.getFileCache().tags  O(1)
  A 有 #ai #programming
  #ai 下的所有笔记 → [H, I, J]

路径③: 关键词召回        数据源: tokenIndex (自建)                 O(K)
  A 的 top-10 TF-IDF 词 → 在倒排索引中查找
  → [K, L, M, N]

路径④: 标题匹配          数据源: vault.getMarkdownFiles()         O(M) 首次, 缓存后 O(1)
  A 标题的实义词 → 匹配其他笔记标题
  → [O, P]

路径⑤: 实体召回          数据源: entityIndex (自建)               O(E)
  A 的实体 [Transformer, GPT, attention] → 在实体索引中查找
  → [Q, R, S]

路径⑥: 语义召回 (可选)   数据源: embeddingStore (可选)            O(log M)
  A 的 embedding → HNSW/线性扫描 top-K
  → [T, U, V]

→ 合并候选集 = ①∪②∪③∪④∪⑤∪⑥ ≈ 50-200 篇 (有大量重叠)
```

### 4.3 精排评分模型

```
Score(A, B) = Σ(weight_i × signal_i) / Σ(weight_i)

信号           | 计算方式                                   | 权重  | 说明
---------------|-------------------------------------------|-------|----
linkDistance    | 1/distance, 0 if no path                  | 3.0   | 显式链接 = 最强信号
embedDistance   | 1 if ![[嵌入]], 0 otherwise (Phase 3A)    | 4.0   | 嵌入 > 链接 (内容是我的一部分)
sharedTags     | min(count / 3, 1.0)                       | 2.0   | 标签 = 用户意图
entityOverlap  | min(count / 5, 1.0)                       | 2.0   | 共享概念
tokenSim       | TF-IDF cosine(docVec_A, docVec_B)         | 1.5   | 内容词频重叠
titleSim       | jaccard(titleWords_A, titleWords_B)        | 1.0   | 标题相似
semanticSim    | cosine(embedding_A, embedding_B) [可选]    | 2.5   | 语义级关联

后处理规则:
├─ 多样性过滤: 同一 folder/tag 来源最多展示 3 篇 → 防止结果同质化
├─ 时效加成:   lastModified < 7天 → score × 1.1 → 优先展示近期活跃笔记
├─ 互惠加成:   A→B 且 B→A 都认为对方相关 → score × 1.15 → 双向共识更可信
└─ 噪声阈值:   score < 0.1 → 丢弃 → 避免弱关联干扰
```

---

## 六、性能指标 (预估)

| Vault 规模 | 全量索引 | 单篇增量更新 | 查询延迟 | 索引持久化大小 |
|-----------|---------|-------------|---------|--------------|
| 100 篇    | <200ms  | <5ms        | <1ms    | ~50KB        |
| 1,000 篇  | ~2s     | ~10ms       | <5ms    | ~500KB       |
| 10,000 篇 | ~20s    | ~15ms       | <10ms   | ~5MB         |
| 100,000 篇| ~3min   | ~20ms       | <15ms   | ~50MB        |

---

## 七、UI 设计

### 7.1 相关笔记侧边栏 (核心，含原子化增强)

```
┌── Related Notes ──────────────────────┐
│                                       │
│ ── 当前笔记 ─────────────────────      │
│ 📝 MIMIT完整指南.md                   │
│ type: knowledge | 3200字 | 3个话题    │
│                                       │
│ ── 相关笔记 (按 score 排序) ──────     │
│ 🔷 ACN认证流程       score:96 reuse:5│
│    atom · 3 shared entities           │
│ 📄 NIS2合规总览      score:85        │
│    composite · embeds same atoms      │
│ 📝 渠道策略分析      score:72        │
│    standalone · 5 keywords overlap    │
│                                       │
│ ── AI 建议 (仅 knowledge 类型) ───     │
│ ✂ 建议拆分为 3 个原子                 │
│   → ACN认证流程 (L1-45)              │
│   → ACN费用结构 (L46-72)             │
│   → ACN常见问题 (L73-95)             │
│   [执行拆分] [稍后] [忽略]            │
│                                       │
│ 🔀 与 [[MIMIT资格条件]] 重叠 72%     │
│   [查看] [忽略]                       │
└───────────────────────────────────────┘
```

三区域设计:
| 区域 | 内容 | 规则 |
|------|------|------|
| 当前笔记 | 名称 + type + 统计 | 所有笔记都显示 |
| 相关笔记 | 带角色标签 (🔷atom 📄composite 📝standalone) | 所有笔记都显示 |
| AI 建议 | 拆分/合并/升级/维护 | 仅 `type: knowledge` 时显示 |

> Phase 1 (已完成) 实现了基础的相关笔记列表 + score ring.
> Phase 3 将扩展为上述三区域布局, 增加角色标签和 AI 建议区.

### 7.2 链接建议 (浮动提示, Phase 3C)

```
用户正在编辑:
  "我在研究 Transformer 架构的attention机制..."
                                    ↕
                   ┌──────────────────────────┐
                   │ 💡 Vault 中有相关笔记:    │
                   │  → [[注意力机制详解]]     │
                   │  → [[Self-Attention]]     │
                   │        [插入链接] [忽略]   │
                   └──────────────────────────┘
```

### 6.3 状态栏

```
底部状态栏:
[🔗 3 new connections found]   [📊 Index: 1,234 notes]
```

---

## 八、开发计划

### Phase 1: 基础引擎 (L0 — 纯本地, 无 AI 依赖) ✅ 已完成

- [x] **KnowledgeEngine 类** — 核心引擎, 挂载 vault 事件
- [x] **TokenExtractor** — 分词 + 去停词 (中英文, ~150 停词)
- [x] **EntityExtractor (L0)** — 正则: [[wikilinks]], 大写短语, 引号内容, #hashtags
- [x] **TopicExtractor (L0)** — Heading 1-3 级文本提取
- [x] **InvertedIndex** — 倒排索引 + 增量更新 (tokenIndex + entityIndex)
- [x] **MultiPathRetriever** — 5路召回 (①图谱 ②标签 ③关键词 ④标题 ⑤实体)
- [x] **WeightedRanker** — 精排 + 4项后处理 (多样性/时效/互惠/去噪)
- [x] **IndexPersistence** — FileIndexStore (knowledge-index.json, debounce 2s)
- [x] **RelatedNotesView** — 侧边栏 UI (score ring + 分色信号标签 + 可折叠 profile)

**实测数据 (40篇笔记, WorkStation vault)**:
- 全量索引: <1s, 788KB
- 4475 tokens, 919 entities
- 211 relationships (avg 5.3/note)
- 最高分 0.963 (Sabatini ↔ 超级折旧, 5 tags + 10 entities)
- 100% 代码文件正确排除

### Phase 2: AI 增强层 (L1 — 可选 Provider) ✅ 已完成

- [x] **KnowledgeProvider 接口** — provider-agnostic 抽象 (extractEntities/Topics/Keywords/Summary)
- [x] **CopilotKnowledgeProvider** — 调 Copilot chat/completions API, gpt-4o, JSON 结构化输出
- [x] **extractAll 批量接口** — 单次 API 调用返回 entities + topics + keywords + summary
- [x] **enrichNoteAsync** — 编辑时自动后台 AI 增强 (非阻塞)
- [x] **enrichBatch** — 批量增强命令 (max 20/次, 带进度回调)
- [x] **渐进式 UI 更新** — L0 先显示, L1 返回后 emitUpdate 触发刷新
- [x] **限流控制** — 800ms 最小间隔, 3000字截断, 512 max_tokens

**实测数据**: 40/40 笔记 AI 增强成功, 平均 30.9 entities/note, 15.9 topics/note

- [ ] **AntigravityKnowledgeProvider** — 调 Gateway API (待定)

### Phase 3: 原子化知识引擎 + 扩展功能

#### 3A. 原子感知层 (Atom Awareness) ✅ 已完成
- [x] **Embed Graph** — indexNote() 读取 cache.embeds, 区分 outLinks 和 outEmbeds
- [x] **Role Classification** — 自动推断笔记角色 (atom/composite/standalone), classifyRoles() 方法
- [x] **Reuse Tracking** — 计算每个笔记的 reuseCount (被嵌入次数), 反向 embed 索引 O(1) 查找
- [x] **Content Inheritance** — 组合笔记继承嵌入原子的 entities/tokens (effectiveTokens/effectiveEntities)
- [x] **Embed Weight** — W_EMBED=4.0 (高于 W_LINK=3.0), embedDistance signal + 6路召回含 embed path + back-embed
- [x] **UI Role Badges** — 🔹atom / 📄composite 标签, embed signal chip, profile 角色显示 + reuse 计数
- [x] **Performance** — debouncedClassifyRoles (3s), reverseEmbedIndex O(1) back-embed 查找

**实测数据**: INDEX_VERSION=2, 40 notes → 37 standalone + 3 composite, 181.5kb build

#### 3B. 知识守护层 (Knowledge Stewardship) ✅ 已完成
- [x] **Duplication Detection** — 实体+token 双重重叠检测, 阈值 40%, top 20 输出
- [x] **Knowledge Gap Discovery** — 高频实体(≥3笔记)无独立笔记 → gap, top 15
- [x] **Atom Health Report** — freshness/reuse/orphan/stale 追踪, 综合健康分 0-100
- [x] **Split Suggestion** — standalone + ≥800字 + ≥3 topics → 拆分建议, top 10
- [x] **Vault Health Dashboard** — 独立侧边栏视图, 健康分环, 统计卡片, 分类展示
- [x] **Command** — `vault-health` 命令注册, 自动触发分析

**文件**: knowledge-steward.ts (分析引擎) + vault-health-view.ts (UI) | 197.8kb build

#### 3C. 行动层 (Action Layer)
- [x] **Insert Link Button** — Related Notes 侧边栏一键插入 [[link]], hover 显示 Insert 按钮
- [x] **LinkSuggester** — 编辑时实时链接建议, 匹配笔记标题, Tab 插入 / Esc 关闭, debounced 800ms
- [x] **Vault-aware Chat** — 聊天自动注入相关笔记/原子上下文 (queryByText 多路召回 + handleSend 自动注入 @[filepath])
- [x] **Broken Link Fixer** — 检测断链, 基于 Levenshtein + token 相似度建议修复, 一键 Fix 按钮, 集成 Vault Health Dashboard
- [x] **Atom Split** — AI 辅助拆分, gpt-4o 分析 heading 边界, 命令 atom-split, 自动创建 atom 文件 + 原文转 composite
- [x] **Atom Merge** — AI 辅助合并, Vault Health Dashboard “AI Merge” 按钮, 生成合并内容 + 归档原文
- [x] **Atom Upgrade** — AI 辅助升级, 命令 atom-upgrade, 从相关笔记提取补充信息并追加

#### 3D. 基础设施
- [x] **SemanticRecall (L2)** — topic overlap + embedding cosine 双路语义召回, W_SEMANTIC=2.5, embedding 可选 (Copilot API /embeddings)
- [x] **VaultHealthDashboard** — SVG 力导向网络图 (30轮迭代), 角色颜色编码, 点击打开笔记, 图例
- [x] **IndexedDB 迁移** — IDBIndexStore 实现, 自动检测 indexedDB 可用性, FileIndexStore fallback

**建议开发顺序**: 3A (原子感知) → Insert Link → LinkSuggester → Vault-aware Chat → Split/Merge → 3B (守护层)

---

### 原子生命周期: 拆分 (Split) 与合并升级 (Merge/Upgrade)

#### 生命周期模型

> 前提: 只有用户标记了 `type: knowledge` 的笔记才进入此流程。
> 未标记的笔记只做 Related Notes 关系计算, 不触发任何原子化。

```
用户标记 type: knowledge 的笔记
       │
       ├── AI 自动分析 → 给出拆分建议 (沉淀后触发)
       │   或 用户主动发起 (右键 / 命令面板)
       ↓
  ┌─ 拆分面板 ──────────────────────────────┐
  │ 显示建议的拆分点 (按 heading + 语义边界) │
  │ 用户确认/调整边界                       │
  │ 选择原文处理:                            │
  │   ● 转为组合(![[嵌入]]) (默认推荐)       │
  │   ○ 保留原文不变                         │
  │   ○ 删除原文                             │
  └────────────┬───────────────────────────┘
               ↓
     Atom A + Atom B + Atom C (独立原子, 自动设 type: atom)
       │         │
       │    时间推移, 知识积累
       ↓         ↓
  ┌─ 合并/升级 检测 ──────────────────────┐
  │ 重叠检测: A 和 B 有 75% 内容重叠      │
  │ 升级发现: C 中有信息可补充到 A        │
  └────────────┬──────────────────────────┘
               ↓
  合并 → 生成更完整的原子 (AI 整合, 消除重复)
  升级 → 原子吸收新信息变得更丰富
```

#### 拆分操作 (Split)

**触发方式**:
| 方式 | 场景 | 交互 |
|------|------|------|
| AI 被动建议 | 引擎检测到 standalone 有 ≥2 个 topic cluster | 侧边栏/通知提示 |
| 用户主动发起 | 右键菜单 / 命令面板 → "Analyze for Atomization" | 弹出拆分面板 |

**拆分流程**:
```
Step 1: AI 分析内容 → 识别 topic 边界 (heading + 语义转折点)
Step 2: 显示拆分建议面板
  - 每个建议的原子: 标题、行范围、字数、提取的话题
  - 原文处理选项: ○删除  ○保留  ●转为组合(![[嵌入]]) (默认推荐)
Step 3: 用户确认 → 按用户选择执行
  1. 创建新原子笔记 (内容从原文提取, 自动设 type: atom)
  2. 原文按用户选择处理:
     - 转为组合 (默认): 内容替换为 ![[嵌入]], 原文仍存在
     - 保留: 原文不变, 新原子是副本
     - 删除: 原文移除
  3. 引用原文的其他笔记保持不变
  4. 引擎自动重新索引, 新原子获得独立关系
```

#### 合并操作 (Merge)

**触发**: AI 检测到两个原子内容重叠度 >70%
```
建议面板:
  ⚠ [[MIMIT补贴申请]] ←→ [[MIMIT资格条件]]
  重叠度: 72% | 共享实体: 4个
  
  操作选项:
  ● 合并为 [[MIMIT补贴申请指南]] (AI 智能整合, 消除重复)
  ○ 保持独立, 但在 A 中嵌入 ![[B]]
  ○ 忽略
```

#### 升级操作 (Upgrade)

**触发**: AI 发现其他笔记中有可补充到当前原子的新信息
```
建议面板:
  💡 原子 [[MIMIT补贴申请]] 可升级:
  发现 3 篇笔记中有未纳入的相关信息:
    · [[会议纪要0312]] 提到了新补贴上限 (50万€)
    · [[竞品A补贴方案]] 有对比数据
  
  AI 建议补充:
    + 更新补贴上限: 40万€ → 50万€ (2024年调整)
    + 添加竞品对比段落
```

#### 引擎新增能力

| 能力 | 说明 | 依赖 |
|------|------|------|
| `topicClustering(content)` | 分析笔记中有几个独立话题 | AI Provider |
| `overlapDetection(atomA, atomB)` | 计算两个原子的内容重叠度 | TF-IDF + Entity |
| `enrichmentDiscovery(atom)` | 发现可补充到原子的外部信息 | AI Provider |

#### 设计原则

1. **AI 分析, 用户决策** — 永远不自动拆分/合并
2. **原文保护** — 拆分时优先转为组合 (![[嵌入]]), 不删除原文
3. **链接自动维护** — 拆分/合并/删除后自动更新引用
4. **渐进式** — 不必一次原子化整个 vault, 一篇一篇来
5. **无 AI 不拆** — Copilot 不可用时不触发原子化建议 (L0 仅做基础关系)
6. **删除即删除** — 原子退役时直接删除, 引擎自动重建断链关系

---

### 实现细节补充

#### 1. AI 建议存储

AI 分析结果存储在独立文件 `atom-suggestions.json`：

```json
{
  "version": 1,
  "suggestions": {
    "path/to/note.md": {
      "contentHash": "abc123",
      "generatedAt": 1700000000,
      "dismissed": false,
      "type": "split",
      "detail": {
        "clusters": 3,
        "suggestedAtoms": [
          { "title": "ACN 认证流程", "startLine": 1, "endLine": 45 },
          { "title": "ACN 费用结构", "startLine": 46, "endLine": 72 },
          { "title": "ACN 常见问题", "startLine": 73, "endLine": 95 }
        ]
      }
    }
  }
}
```

- contentHash 变化 → 旧建议失效, 等待新分析
- dismissed: true → 不再展示 (直到内容变化)
- 独立于 knowledge-index.json, 不影响主索引性能

#### 2. Related Notes UI 承载原子信息

> 详细布局见 §7.1 "相关笔记侧边栏"。

- 只有 `type: knowledge` 的笔记才显示 AI 建议区域
- 角色标签: 🔷 atom, 📄 composite, 📝 standalone
- atom 额外显示 reuse 计数

#### 3. 首次使用引导 (Onboarding)

**触发条件**: 用户首次安装插件, 或首次打开 Related Notes 侧边栏

**引导流程** (渐进式, 不一次讲完):

```
首次打开 Related Notes:
  ┌──────────────────────────────────────────┐
  │ 👋 Welcome to Knowledge Engine!          │
  │                                          │
  │ 我会自动分析你的笔记之间的关系。         │
  │ 切换到不同笔记试试看!                    │
  │                                 [Got it] │
  └──────────────────────────────────────────┘

使用 3 天后 (或手动打开设置):
  ┌──────────────────────────────────────────┐
  │ 💡 You have 40 notes. Ready for more?    │
  │                                          │
  │ 给笔记添加 type 属性可以解锁更多功能:    │
  │                                          │
  │ type: knowledge                          │
  │   → AI 会帮你分析是否需要拆分/合并       │
  │   → 适合: 知识沉淀、分析文档、竞品分析   │
  │                                          │
  │ type: atom                               │
  │   → 标记这是一个可复用的知识原子          │
  │   → 追踪它被多少笔记引用                 │
  │                                          │
  │              [Learn more] [Try it now]    │
  └──────────────────────────────────────────┘
```

- 不在第一天就推原子化概念 (先让用户体验 Related Notes 的价值)
- 3 天后或用户主动查看设置时才介绍 `type` 属性
- "Try it now" 按钮: 打开当前笔记的属性面板, 预填 `type: knowledge`

#### 4. 无 AI 降级方案

```
Copilot 不可用时:
  ✅ L0 全部功能正常 (Related Notes, 关系计算, 角色分类)
  ✅ type: atom 的复用度追踪正常
  ❌ type: knowledge 的 AI 建议不可用
  ❌ 拆分/合并/升级建议不生成

UI 提示:
  AI 建议区域显示:
  "⚠ Copilot 未连接, AI 建议不可用
   [连接 Copilot] [了解更多]"
```

不做 L0 级别的拆分建议(如 "这篇有 3 个 heading 可能需要拆分") — 因为这种粗略建议质量不高, 不如不给。

#### 5. 原子退役 (删除与链接重建)

```
用户删除原子 [[ACN认证费用2023]]:
  ↓
  引擎 onFileDeleted() 触发:
  1. 扫描所有笔记找到引用了 [[ACN认证费用2023]] 的笔记
  2. 在 AI 建议区域显示:
     "⚠ 已删除的原子被以下笔记引用:
       · [[NIS2合规总览]] (L12: ![[ACN认证费用2023]])
       · [[成本分析报告]] (L25: [[ACN认证费用2023]])
      
      建议操作:
       → 替换为 [[ACN认证费用2024]] ?  [替换] [手动处理]"
  3. 如果有同名或高相似度的新原子 → 自动建议替换
  4. 如果没有替代 → 提示用户手动处理断链
```

不做自动替换 (除非用户确认), 因为删除可能是有意的。

---

## 九、已完成修复 (v0.2.1)

### 2025-01-XX: Prompt Manager & 浮动工具栏修复

**问题**: "从功能到用户使用体验都非常非常差，连点击新建都不可以"

**修复内容**:

1. **[Critical] 新建 Prompt 不可见** — `renderList()` 过滤条件 `t.prompt &&` 导致空 prompt 被隐藏
   - 修复: 改为 `(t.prompt || t.id === editingId)`

2. **新建后不自动打开编辑器** — `editingId` 设置了但未触发 `openInlineEditor`
   - 修复: 渲染后检查 `editingId === tmpl.id` 自动打开

3. **取消新建残留空数据** — Cancel 按钮未调用 `saveSettings()`
   - 修复: Cancel 时清理 + 保存 + 重渲染

4. **浮动工具栏不响应键盘选择** — 只监听 `mouseup`
   - 修复: 添加 `keyup` 监听 Shift 键

5. **"..." 按钮打开弹窗 (反人类)** — 应该是自然的下拉菜单
   - 修复: 改为向下展开的 dropdown menu, 按类别分组显示所有 prompt

6. **翻译等 {{select:...}} 弹窗** — 选择语言不应该打开 Modal
   - 修复: inline dropdown, 直接在工具栏下方选择

7. **下拉菜单立即消失** — `checkAndShowToolbar()` 重建导致
   - 修复: 工具栏已存在时跳过重建

8. **结果面板与工具栏重叠** — 用了工具栏位置而非选中文字位置
   - 修复: 传递 `selectionRect` 而非 `toolbarRect`

---

## 九-B、代码审计 & 自动化测试 (v0.2.1)

### 代码审查总结

对 Phase 1–3D 全部新增模块进行了系统性代码审查，发现并修复 14 项问题：

#### P0 — 安全/正确性
| # | 问题 | 模块 | 修复 |
|---|------|------|------|
| 3 | AI 返回标题含 `\/:*?"<>\|` 导致 fs 错误 | atom-operations.ts | 新增 `sanitizeFilename()` — 过滤非法字符、折叠空格、限 100 字符 |
| 5 | LinkSuggester 通过 `(engine as any).index.profiles` 访问私有数据 | link-suggester.ts | 新增 `getAllPaths()` / `getAllProfiles()` 公开 API |

#### P1 — 性能/可维护性
| # | 问题 | 模块 | 修复 |
|---|------|------|------|
| 7 | Tag 召回 O(T×N) 全表扫描 | knowledge-engine.ts | 新增 `tagIndex: Map<string, Set<string>>` 倒排索引，O(T×M) |
| 9 | IDBIndexStore 每次 save/load 打开/关闭 DB | knowledge-engine.ts | 缓存 `IDBDatabase` 引用，`getDB()` 单例，`onclose` 自动重连 |
| 11 | callCopilot / parseJSON 在两个文件中完全重复 | copilot-*.ts, atom-*.ts | 提取 `copilot-api.ts` 共享模块 |

#### P2 — 健壮性/UX
| # | 问题 | 模块 | 修复 |
|---|------|------|------|
| 6 | 力导向图 500+ 节点卡顿 | vault-health-view.ts | `MAX_GRAPH_NODES=100`，按连接度排序截取 |
| 12 | 网络图每次渲染布局随机 | vault-health-view.ts | `seededRandom()` LCG 伪随机，种子 = noteCount * 2654435761 |
| bonus | `embeddingCosine()` 未检查向量长度 | knowledge-engine.ts | 长度不匹配或为空 → 返回 0 |

**构建**: 修复后 217.0kb (↑ 0.4kb vs 216.6kb)

### 自动化测试

**框架**: vitest 3.2.4 + 自定义 obsidian mock

**测试总览**: 5 文件, 60 测试, 312ms

| 文件 | 类型 | 测试数 | 覆盖范围 |
|------|------|--------|----------|
| knowledge-engine.test.ts | 单元 | 19 | tokenize (停词/代码块/URL/wikilink/中文)、extractEntitiesRegex、extractTopicsFromMeta、simpleHash |
| copilot-api.test.ts | 单元 | 6 | parseJSON (plain/fence/no-lang/whitespace/invalid/nested) |
| broken-link-fixer.test.ts | 单元 | 8 | scanBrokenLinks (空/模糊匹配/精确/聚合/限制)、applyFix (替换/别名/正则特殊字符) |
| atom-operations.test.ts | 单元 | 5 | executeSplit (frontmatter/跳过已存在/composite 转换)、executeMerge (创建+归档/冲突) |
| knowledge-engine-integration.test.ts | 集成 | 22 | fullBuild、profiles、tokens、tags、角色分类、关系计算 (link/tag/score)、queryByText、getAllPaths/Profiles、持久化、reload、文件事件 (modify/delete/rename)、embed 距离、内容继承 |

**Mock 架构**: `__tests__/mocks/obsidian.ts` — TFile、Notice、App (vault + metadataCache)、ItemView、WorkspaceLeaf、MarkdownView、debounce、setIcon、requestUrl

**运行**: `npm test` 或 `npx vitest run`

---

## 十、已知的 10 大产品不足

> 方向: **知识原子化智能体** — AI 驱动的原子化知识管家

| # | 不足 | 影响 | 状态 |
|---|------|------|------|
| 1 | 缺失自适应智能上下文 | 🔴 高 | Phase 3C: Vault-aware Chat |
| 2 | 浮动工具栏与聊天断开 | 🔴 高 | ✅ 已修复基础 |
| 3 | 无知识图谱可视化 | 🟡 中 | ✅ Phase 1 侧边栏已完成 |
| 4 | 无多笔记联合综合 | 🔴 高 | Phase 3C |
| 5 | 写作辅助缺实时反馈 | 🟡 中 | Phase 3C: LinkSuggester |
| 6 | 无智能模板推荐 | 🟡 中 | Phase 3B: 原子复用建议替代 |
| 7 | 缺研究/阅读工作流 | 🟡 中 | Phase 3C |
| 8 | 对话隔离无跨对话记忆 | 🟡 中 | Phase 3C |
| 9 | 无AI驱动的vault组织 | 🟢 低 | ✅ Phase 1 基础检测完成 |
| 10 | 无持续实时协作AI | 🔴 高 | ✅ Phase 2 AI增强完成 |

---

## 十一、用户旅程分析 & 缺失功能

### 当前用户旅程

```
安装插件 → 打开 Chat → 对话 → 浮动工具栏翻译/润色 → Related Notes 查看关联
```

### 用户旅程阶段 & 缺失

| 阶段 | 当前能力 | 缺失的关键功能 | 优先级 |
|------|---------|---------------|-------|
| **1. 写作/编辑** | 浮动工具栏 (翻译/润色/自定义) | 实时链接建议 ("你可能要链接到 [[X]]") | 🔴 P0 |
| **2. 发现关联** | Related Notes 侧边栏 | 从 Related Notes 一键插入 [[link]] | 🔴 P0 |
| **3. 知识理解** | AI 提取实体/主题 | 聊天时自动注入相关笔记作为上下文 | 🔴 P0 |
| **4. Vault 维护** | 自动建索引 | 孤立笔记检测、弱连接提醒、重复内容发现 | 🟡 P1 |
| **5. 跨笔记分析** | 无 | "综合这 5 篇笔记写个摘要" — 多笔记上下文 | 🟡 P1 |
| **6. 学习/复习** | 无 | 间隔重复提醒、知识卡片生成 | 🟢 P2 |
| **7. 实时协作** | 无 | 写作时 AI 实时建议 (类似 Copilot ghost text) | 🟢 P2 |

### 最高价值的 4 个下一步

#### A. 链接建议器 (LinkSuggester) — 写作时的知识连接
**场景**: 用户在编辑笔记，提到 "NIS2 合规要求"，引擎检测到 vault 中有相关笔记
```
用户输入: "根据NIS2合规要求，我们需要..."
                          ↕
            ┌──────────────────────────────────┐
            │ 💡 Related notes found:          │
            │  → [[NIS2 Dashboard]]            │
            │  → [[详细客户审查要求]]           │
            │           [Insert link] [Dismiss] │
            └──────────────────────────────────┘
```
**实现复杂度**: 中 — 需要 debounced 编辑监听 + 实体匹配 + inline suggest UI

#### B. Related Notes → Insert Link — 一键链接
**场景**: 用户在 Related Notes 侧边栏看到相关笔记，想在当前笔记中插入链接
```
Related Notes 面板:
  ACN认证路径详解  score:96  [🔗 Insert Link]
                              ↓ 点击
  光标位置插入: [[ACN认证路径详解]]
```
**实现复杂度**: 低 — 只需在 item 上加个按钮 + 调用 editor API

#### C. Vault-aware Chat — 知识感知对话 ✅
**场景**: 用户在 Chat 中提问，引擎自动找到相关笔记并注入上下文
```
用户: "MIMIT 补贴的申请流程是什么?"
         ↓ KnowledgeEngine.queryByText() — token + entity 双路召回
         ↓ 取 top 3 相关笔记, 排除已有 @[ref] + 当前活动文件
         ↓ 以 @[vaultBase/path] 格式注入消息前缀
         ↓ Gateway 读取文件内容, 作为上下文传给 LLM
```
**实现**: knowledge-engine.ts `queryByText()` + chat-view.ts `handleSend()` 知识上下文注入块
**构建**: 198.8kb | 已部署

#### D. Vault Health Dashboard — 知识健康报告
**场景**: 用户查看 vault 的整体知识结构质量
```
┌── Vault Health ──────────────────────────┐
│ 📊 Knowledge Score: 78/100               │
│                                          │
│ ⚠ 3 orphan notes (no links/relations)   │
│   → 未命名.md, OKR详情.md, task.md       │
│                                          │
│ 💡 Suggested connections:                │
│   OKR详情.md ↔ Go to Market/Overview.md  │
│   (5 shared concepts found)             │
│                                          │
│ 📈 Cluster analysis:                    │
│   合规政策 (11 notes, dense)             │
│   NIS2研究 (7 notes, moderate)           │
│   Competitor (6 notes, sparse)           │
└──────────────────────────────────────────┘
```
**实现复杂度**: 低–中 — 引擎数据已有，主要是 UI
