# Phase 3A: 原子感知层 — 开发任务分解

## 改动范围

| 文件 | 改动类型 | 预计改动量 |
|------|---------|-----------|
| `knowledge-engine.ts` | 类型扩展 + 逻辑修改 | ~120 行新增/修改 |
| `related-notes-view.ts` | UI 增强 (角色标签) | ~30 行新增/修改 |
| `styles.css` | 角色标签样式 | ~20 行新增 |

## 任务清单

### T1. NoteProfile 类型扩展
- [ ] 新增字段: `outEmbeds: string[]`, `role: 'atom' | 'composite' | 'standalone'`, `reuseCount: number`, `noteType: string`
- [ ] RelationshipSignals 新增: `embedDistance?: number`
- [ ] INDEX_VERSION 从 1 → 2 (旧索引自动 rebuild)

### T2. 新增常量 W_EMBED
- [ ] `const W_EMBED = 4.0;` (高于 W_LINK 的 3.0)

### T3. indexNote() 扩展
- [ ] 读取 `cache?.embeds` 提取 `outEmbeds` (解析嵌入目标路径)
- [ ] 读取 `cache?.frontmatter?.type` 填充 `noteType`
- [ ] 新建 profile 时设置默认 `role: 'standalone'`, `reuseCount: 0`, `noteType: ''`

### T4. 新增 classifyRole() 方法
- [ ] 遍历所有 profiles 统计 reuseCount (被嵌入次数)
- [ ] 判定规则:
  - `noteType === 'atom'` → role = 'atom'
  - `noteType === 'knowledge'` → role = 'standalone' (知识类但还没拆分)
  - `outEmbeds.length >= 2` → role = 'composite'
  - `reuseCount >= 2 AND wordCount < 1000` → role = 'atom' (推断)
  - 其他 → role = 'standalone'
- [ ] 在 fullBuild() 和 indexNote() 后调用

### T5. computeRelations() 扩展 — Embed 信号
- [ ] 在 Graph recall (Path 1) 中增加 embed 路径
  - outEmbeds 的目标作为 directLinks (类似 outLinks)
  - 反向: 扫描哪些 profile 的 outEmbeds 包含当前笔记 (backEmbeds)
- [ ] 在 Score candidates 中新增 Signal: embedDistance
  - `if embed (outEmbeds/backEmbed) → signals.embedDistance = 1, score += W_EMBED * 1.0`
  - Embed 关系类型标记为 'explicit'

### T6. Content Inheritance (组合笔记继承原子的知识)
- [ ] 在 computeRelations() 前, 如果当前笔记 role === 'composite':
  - 合并 outEmbeds 中所有原子的 entities 到当前 profile (去重)
  - 合并 outEmbeds 中所有原子的 tokens 到当前 profile 的 TF-IDF (去重)
  - 标记为临时合并 (不写入持久化 profile, 仅用于关系计算)

### T7. Related Notes UI — 角色标签
- [ ] related-notes-view.ts 中, 每个 item 旁显示角色图标:
  - 🔷 atom (紫蓝渐变背景)
  - 📄 composite (灰色背景)
  - 📝 standalone (无特殊标记)
- [ ] atom 额外显示 `reuse: N`
- [ ] styles.css 新增角色标签样式

### T8. 构建 & 验证
- [ ] `npm run build` 通过
- [ ] 部署到 vault, 触发 rebuild (INDEX_VERSION 升级)
- [ ] 验证: Related Notes 显示角色标签
- [ ] 验证: 有 `![[embed]]` 的笔记正确识别为 composite 或 atom

## 依赖关系

```
T1 (类型) → T2 (常量) → T3 (indexNote) → T4 (classifyRole)
                                              ↓
                              T5 (scoring) ← T4
                              T6 (inheritance) ← T4
                              T7 (UI) ← T4
                                              ↓
                                          T8 (验证)
```
