# API & 架构文档

本文档面向希望理解插件内部实现或进行二次开发的开发者。如果你只是使用插件，请参阅 [用户使用指南](user-guide.md)。

## 架构概览

插件采用三层架构：**L0 本地引擎**（核心，离线可用）→ **L1 AI 增强层**（可选，按需注入）→ **UI 层**（面板/工具栏展示）。L0 和 L1 通过 `KnowledgeProvider` 接口解耦，AI 层不影响核心引擎的独立运行。

```
┌─ Obsidian Plugin (main.ts) ──────────────────────────────────┐
│                                                               │
│  ┌─ L0: 本地知识引擎 ─────────────────────────────────────┐  │
│  │  KnowledgeEngine          — 多路召回 + 加权排序         │  │
│  │  ├── FileIndexStore       — JSON 文件持久化             │  │
│  │  └── IDBIndexStore        — IndexedDB 持久化 (优先)     │  │
│  │  KnowledgeSteward         — 健康分析 (重复/空白/拆分)   │  │
│  │  BrokenLinkFixer          — 断链扫描 + 修复             │  │
│  │  LinkSuggester            — 编辑时链接建议              │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ L1: AI 增强层 (可选) ──────────────────────────────────┐  │
│  │  CopilotKnowledgeProvider — KnowledgeProvider 实现      │  │
│  │  copilot-api.ts           — 共享 HTTP/throttle 工具     │  │
│  │  copilot-auth.ts          — Device Flow OAuth           │  │
│  │  AtomOperations           — Split / Merge / Upgrade     │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ UI 层 ─────────────────────────────────────────────────┐  │
│  │  ChatView                 — 聊天面板 (Vault-aware)      │  │
│  │  RelatedNotesView         — 相关笔记侧边栏              │  │
│  │  VaultHealthView          — 健康报告面板                 │  │
│  │  FloatingToolbar          — 选中文字浮动工具栏           │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## 数据流

当用户编辑笔记时，插件通过 Obsidian 的文件事件 API 感知变化，触发增量更新流水线。只有被修改的笔记及其直接关联笔记会被重新计算，避免全量重建的开销。

```
笔记编辑 → onFileModified()
  → indexNote() 重建 NoteProfile (tokens, entities, tags, links, embeds)
  → computeRelations() 对受影响笔记重新计算 7 路信号
  → debouncedSave() 2s 后持久化到 IndexedDB
  → emitUpdate() 通知 UI 刷新
  → enrichNoteAsync() (如有 Provider) 后台 AI 增强
```

---

## 核心接口

以下是插件的核心 TypeScript 接口。理解这些接口有助于：(1) 对接新的 AI 服务，(2) 替换存储后端，(3) 扩展关系信号维度。

### KnowledgeProvider

AI 能力的抽象接口。所有 AI 功能（实体提取、语义分析、向量嵌入等）都通过这个接口注入，引擎本身不直接依赖任何 AI 服务。如果你想接入除 Copilot 以外的 AI（如 Ollama、Claude），只需实现这 5 个方法。

```typescript
interface KnowledgeProvider {
  extractEntities(content: string): Promise<string[]>;
  extractTopics(content: string): Promise<string[]>;
  extractKeywords(content: string): Promise<string[]>;
  generateSummary(content: string): Promise<string>;
  getEmbedding?(content: string): Promise<number[]>;  // 可选
}
```

**已实现**: `CopilotKnowledgeProvider` (使用 GitHub Copilot API)

### IndexStore

索引数据的持久化抽象。引擎在每次修改笔记后需要保存更新的索引（笔记档案、关系图等），通过此接口可以切换不同的存储后端。启动时自动检测 `indexedDB` 是否可用——浏览器/Electron 环境优先使用 `IDBIndexStore`（性能更好，支持大数据量），不可用时回退到 `FileIndexStore`（JSON 文件，兼容性更广）。

```typescript
interface IndexStore {
  load(): Promise<KnowledgeIndex | null>;
  save(index: KnowledgeIndex): Promise<void>;
  clear(): Promise<void>;
}
```

**已实现**: `IDBIndexStore` (IndexedDB, 缓存连接), `FileIndexStore` (JSON 文件)

### NoteProfile

每篇笔记在索引中的完整档案。引擎为 Vault 中每篇笔记维护一份 NoteProfile，包含从内容中提取的各种特征（tokens、entities、tags 等）。这些特征是计算笔记间关系的基础数据。

```typescript
interface NoteProfile {
  path: string;
  contentHash: string;         // 内容 hash，用于变更检测
  tokens: string[];            // 纯文本 token (去停词)
  entities: string[];          // 实体 (wikilink/专有名词/hashtag)
  topics: string[];            // 主题 (heading + AI)
  tags: string[];              // #标签
  outLinks: string[];          // [[链接]] 目标路径
  outEmbeds: string[];         // ![[嵌入]] 目标路径
  role: 'atom' | 'composite' | 'standalone';
  reuseCount: number;          // 被嵌入次数
  noteType: string;            // frontmatter type 字段
  wordCount: number;
  lastModified: number;
  enrichedByAI: boolean;
  embedding?: number[];        // 向量嵌入 (L1)
}
```

### Relationship

笔记间的关系数据。每对相关笔记会产生一条 Relationship，其中 `score` 是加权归一化后的综合分数(0–1)，`signals` 包含 7 路独立信号的原始分数。UI 层使用 `score` 排序，使用 `signals` 展示哪些维度贡献了关系（亮起对应的信号标签）。

```typescript
interface Relationship {
  target: string;              // 目标笔记路径
  score: number;               // 综合加权分 (0–1)
  signals: RelationshipSignals;
  type: 'explicit' | 'inferred';
}

interface RelationshipSignals {
  linkDistance: number;         // 直接链接 → 1
  tokenSimilarity: number;     // TF-IDF 余弦
  entityOverlap: number;       // Jaccard
  tagOverlap: number;          // Jaccard
  titleSimilarity: number;     // Jaccard
  embedDistance: number;        // 嵌入关系 → 1
  semanticSimilarity: number;  // topic + embedding cosine
}
```

### KnowledgeIndex

完整索引的顶层数据结构，通过 IndexStore 持久化。包含所有笔记的 profiles、多个倒排索引（用于快速查找哪些笔记包含某个 token/entity）、以及预计算的关系图。`version` 字段用于迁移——当引擎升级导致索引结构变化时，会检测版本号并触发全量重建。

```typescript
interface KnowledgeIndex {
  version: number;             // INDEX_VERSION = 3
  totalNotes: number;
  profiles: Record<string, NoteProfile>;
  tokenIndex: Record<string, string[]>;    // 倒排索引: token → paths
  entityIndex: Record<string, string[]>;   // 倒排索引: entity → paths
  docFrequency: Record<string, number>;    // 文档频率: token → count
  relations: Record<string, Relationship[]>;
  lastFullBuild: number;
}
```

---

## KnowledgeEngine API

### 生命周期

```typescript
const engine = new KnowledgeEngine(app, store);
engine.setProvider(copilotProvider);            // 可选
engine.setOnRelationsUpdate(callback);
await engine.initialize(excludeFolders);       // 加载或全量构建
```

### 查询方法

| 方法 | 返回 | 说明 |
|------|------|------|
| `getRelations(path)` | `Relationship[]` | 某笔记的所有关系 (max 10, 按 score 降序) |
| `getProfile(path)` | `NoteProfile \| null` | 某笔记的档案 |
| `getAllPaths()` | `string[]` | 所有已索引笔记路径 |
| `getAllProfiles()` | `NoteProfile[]` | 所有笔记档案 |
| `getStats()` | `Stats` | 统计 (总笔记/关系/token/entity/AI增强数) |
| `queryByText(text, topN?, excludePaths?)` | `{path, score}[]` | 文本查询 — token + entity 双路召回 |

### 事件方法

| 方法 | 触发时机 |
|------|---------|
| `onFileModified(file)` | 文件修改 |
| `onFileCreated(file)` | 新建文件 |
| `onFileDeleted(path)` | 删除文件 |
| `onFileRenamed(oldPath, newPath)` | 重命名文件 |

### 批量操作

| 方法 | 说明 |
|------|------|
| `fullBuild()` | 全量重建索引 (Phase 1: profiles → Phase 2: relations) |
| `enrichBatch(maxNotes?, onProgress?)` | 批量 AI 增强 (每次 max 20) |

---

## Copilot API 工具

共享模块 `copilot-api.ts`，被 `CopilotKnowledgeProvider` 和 `AtomOperations` 使用。

```typescript
interface CopilotCallOptions {
  model?: string;            // 默认 'gpt-4o'
  maxTokens?: number;        // 默认 512
  temperature?: number;      // 默认 0.1
  maxContentChars?: number;  // 默认 3000
}

// 发送请求到 Copilot chat/completions API，内置限流 + token 刷新
function callCopilot(
  getCredentials: () => CopilotCredentials | null,
  onRefreshed: (c: CopilotCredentials) => void,
  systemPrompt: string,
  userContent: string,
  opts?: CopilotCallOptions,
): Promise<string>;

// 解析 AI 返回的 JSON（自动去除 markdown fence）
function parseJSON(raw: string): any;
```

---

## Atom Operations API

```typescript
// 拆分
analyzeSplit(app, filePath, getCredentials, onRefreshed): Promise<SplitPlan | null>
executeSplit(app, filePath, plan): Promise<string[]>

// 合并
analyzeMerge(app, pathA, pathB, getCredentials, onRefreshed): Promise<MergePlan | null>
executeMerge(app, plan): Promise<string | null>

// 升级
analyzeUpgrade(app, atomPath, sourcePath, getCredentials, onRefreshed): Promise<UpgradeSuggestion | null>
executeUpgrade(app, suggestion): Promise<boolean>

// 工具
sanitizeFilename(name: string): string  // 过滤 \/:*?"<>|，限 100 字符
```

### 数据结构

```typescript
interface SplitPlan {
  atoms: { title: string; startLine: number; endLine: number; tags: string[] }[];
  makeComposite: boolean;
}

interface MergePlan {
  title: string;
  mergedContent: string;
  sourceA: string;
  sourceB: string;
}

interface UpgradeSuggestion {
  targetPath: string;
  sourcePath: string;
  additions: string;
}
```

---

## Broken Link Fixer API

```typescript
// 扫描断链，返回按来源聚合的结果
scanBrokenLinks(app: App, engine: KnowledgeEngine): BrokenLink[]

// 批量替换断链文本，保留别名
applyFix(app: App, brokenLinkText: string, fixTargetName: string, sourcePaths: string[]): Promise<number>
```

```typescript
interface BrokenLink {
  linkText: string;
  sources: string[];
  suggestions: { targetPath: string; targetName: string; similarity: number; matchType: 'exact-case' | 'fuzzy' | 'entity' }[];
}
```

---

## LinkSuggester API

```typescript
class LinkSuggester {
  constructor(app: App, engine: KnowledgeEngine);
  enable(): void;
  disable(): void;
  onEditorChange(): void;           // 接入 plugin 的 editor-change 事件
  onKeyDown(e: KeyboardEvent): boolean;  // Tab/Enter/Escape/Arrow 处理
  destroy(): void;
}
```

---

## 常量参考

以下常量控制引擎的核心行为。修改这些值会影响关系计算的准确度和性能。

### 信号权重

权重决定了每路信号对最终相关度分数的贡献比例。数值越大，该信号越受信任。当前设计原则：**用户主动创建的结构关系（嵌入/链接）> AI 推断的语义关系 > 统计特征（标签/实体/词频）> 浅层匹配（标题）**。

| 常量 | 值 | 说明 |
|------|-----|------|
| `W_EMBED` | 4.0 | 嵌入 > 所有 |
| `W_LINK` | 3.0 | 显式链接 |
| `W_SEMANTIC` | 2.5 | Topic overlap + embedding cosine |
| `W_TAG` | 2.0 | 共享标签 |
| `W_ENTITY` | 2.0 | 共享实体 |
| `W_TOKEN` | 1.5 | TF-IDF 相似度 |
| `W_TITLE` | 1.0 | 标题相似度 |

### 引擎阈值

这些阈值平衡了准确度和性能。例如 `NOISE_THRESHOLD=0.1` 意味着相关度低于 10% 的"噪声关系"会被丢弃，避免 UI 展示无意义的弱关联。

| 常量 | 值 | 说明 |
|------|-----|------|
| `INDEX_VERSION` | 3 | 索引版本号 |
| `MAX_RELATIONS_PER_NOTE` | 10 | 每笔记最多保留关系数 |
| `NOISE_THRESHOLD` | 0.1 | 低于此分数的关系丢弃 |
| `DEBOUNCE_SAVE_MS` | 2000 | 持久化防抖间隔 |
| `MAX_TOKENS_PER_NOTE` | 200 | 每笔记最多 token 数 |

### AI 参数

控制与 GitHub Copilot API 的交互行为。`MIN_INTERVAL_MS` 防止请求过快触发 API 限流；`MAX_CONTENT_CHARS` 截断过长笔记以控制 token 成本和响应延迟。

| 常量 | 值 | 说明 |
|------|-----|------|
| `MIN_INTERVAL_MS` | 800 | API 调用最小间隔 |
| `MAX_CONTENT_CHARS` | 3000 | 发送内容截断阈值 |
| Atom Ops `maxTokens` | 1024 | 原子操作回复上限 |
| Atom Ops `temperature` | 0.2 | 原子操作温度 |
| Atom Ops `maxContentChars` | 4000 | 原子操作内容截断 |

---

## 扩展指南

插件的三个核心组件（AI 提供者、存储后端、关系信号）都通过接口解耦，可以独立替换或扩展。

### 添加新的 KnowledgeProvider

实现 `KnowledgeProvider` 接口并通过 `engine.setProvider()` 注入。例如，接入本地 Ollama 模型代替 Copilot：

```typescript
class MyProvider implements KnowledgeProvider {
  async extractEntities(content: string): Promise<string[]> { /* ... */ }
  async extractTopics(content: string): Promise<string[]> { /* ... */ }
  async extractKeywords(content: string): Promise<string[]> { /* ... */ }
  async generateSummary(content: string): Promise<string> { /* ... */ }
  async getEmbedding(content: string): Promise<number[]> { /* 可选 */ }
}

engine.setProvider(new MyProvider());
```

### 添加新的 IndexStore

实现 `IndexStore` 接口即可替换存储后端。例如使用 Redis 实现跨设备索引同步：

```typescript
class RedisIndexStore implements IndexStore {
  async load(): Promise<KnowledgeIndex | null> { /* ... */ }
  async save(index: KnowledgeIndex): Promise<void> { /* ... */ }
  async clear(): Promise<void> { /* ... */ }
}

const engine = new KnowledgeEngine(app, new RedisIndexStore());
```

### 添加新的信号维度

如果你想增加一种新的关系判定方式（例如基于创建时间的时序相关性），需要修改以下 5 处：

1. 在 `RelationshipSignals` 接口中添加字段（如 `temporalSimilarity: number`）
2. 在 `computeRelations()` 的召回/计算阶段添加逻辑
3. 定义权重常量 `W_NEW_SIGNAL`
4. 在 `normalizeScore()` 的分母中添加权重
5. 递增 `INDEX_VERSION`

---

## 测试

```bash
npm test                    # 运行全部 60 个测试
npx vitest run --reporter=verbose  # 详细输出
npx vitest --watch          # 监听模式
```

### 测试结构

```
__tests__/
  mocks/
    obsidian.ts                          # Obsidian API mock
  knowledge-engine.test.ts               # 19 单元测试
  copilot-api.test.ts                    # 6 单元测试
  broken-link-fixer.test.ts              # 8 单元测试
  atom-operations.test.ts                # 5 单元测试
  knowledge-engine-integration.test.ts   # 22 集成测试
```

---

## 已知优化点（待后续迭代）

以下问题已识别但暂未修复，对现有功能无影响，作为后续迭代参考。

### P1 — 重要

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| 1 | main.ts L189/L217 | **double modify 监听** | `vault.on('modify')` 注册了两次——一次给 `knowledgeEngine.onFileModified`，一次给 `atomizationManager.onKnowledgeNoteModified`。应合并为一个监听器内分发 |
| 2 | main.ts L560-568 | **onunload 不完整** | `atomizationManager` 的 settle timer 和持久化 debounce timer 没有在 `onunload()` 中清理，插件卸载后可能残留定时器。`selectionDisplayInterval` 每 500ms 轮询浪费资源 |
| 3 | vault-health-view.ts L130 | **enrichBtn 无异步错误处理** | enrichBtn 的 click handler 调用 async 操作但没有 try/catch，异常会变为 unhandled rejection |
| 4 | knowledge-engine.ts `computeRelations` | **O(n²) 全量关系计算** | 每次笔记修改时对所有笔记对重新计算关系。Vault 超过 500 篇笔记时可能产生明显卡顿。优化方向：只重算受影响笔记及其直接关联笔记的关系 |

### P2 — 优化建议

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| 5 | main.ts L571-599 | **setupHotReload 使用 Node.js fs.watch** | 桌面端特有 API，移动端/Web 端会静默失败。已有 try/catch 兜底，但应该在进入前检测 `typeof require !== 'undefined'` |
| 6 | vault-health-view.ts 网络图 | **SVG 全量重绘无 loading 状态** | Health Report 打开时网络图全量构建 DOM，笔记多时有延迟但无 loading 提示，用户会以为卡死 |
| 7 | main.ts L627-635 | **selectionDisplayInterval 轮询** | 每 500ms 轮询选区状态来更新 StatusBar 文字，浪费 CPU。应改为监听 `editor-change` / `active-leaf-change` 事件驱动更新 |
| 8 | copilot-api.ts | **全局共享限流计数器** | 所有 API 调用共享一个 `lastCallTime`。用户同时触发 enrich 和 split 等操作时会互相阻塞等待。应按操作类型或队列隔离 |
