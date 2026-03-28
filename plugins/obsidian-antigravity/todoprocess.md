# Phase 3A: 开发过程记录

## 完成时间
Phase 3A 全部完成

## 任务进度

| 任务 | 状态 | 备注 |
|------|------|------|
| T1. NoteProfile 类型扩展 | ✅ | NoteRole type, outEmbeds, role, reuseCount, noteType fields |
| T2. W_EMBED 常量 | ✅ | W_EMBED=4.0, INDEX_VERSION bumped to 2 |
| T3. indexNote() 扩展 | ✅ | 读取 cache.embeds + frontmatter.type, resolve embed paths |
| T4. classifyRole() | ✅ | embedCounts计算, atom/composite/standalone 分类规则 |
| T5. computeRelations() embed 信号 | ✅ | embed candidates + back-embeds + embedDistance signal + W_EMBED scoring |
| T6. Content Inheritance | ✅ | composite notes 继承 embedded atoms 的 tokens/entities |
| T7. UI 角色标签 | ✅ | role badges + embed signal chip + profile role display + reuse count |
| T8. 构建 & 验证 | ✅ | 181.1kb build, INDEX_VERSION=2 verified, 37 standalone + 3 composite |

## 验证结果

- INDEX_VERSION: 2 (触发了完整重建)
- 40 notes indexed: 37 standalone, 3 composite, 0 atom (vault 中暂无 frontmatter type:atom)
- composite 笔记: 3 个含有 ≥2 个 ![[embed]] 的笔记 (图片 embeds)
- 新字段: outEmbeds, role, reuseCount, noteType 全部正确填充
- main.js 181.1kb 构建成功并部署

## 代码变更日志

### knowledge-engine.ts
- NoteRole type 定义 + NoteProfile 扩展 (outEmbeds, role, reuseCount, noteType)
- RelationshipSignals 扩展 (embedDistance)
- INDEX_VERSION=2, W_EMBED=4.0
- indexNote(): 读取 cache.embeds → getFirstLinkpathDest() → outEmbeds; frontmatter.type → noteType
- classifyRoles(): embed 计数 → reuseCount + 角色分类 (noteType优先, outEmbeds≥2→composite, reuseCount≥2+wordCount<1000→atom)
- computeRelations(): embed candidates + back-embeds + 2-hop through embeds + embedDistance signal + content inheritance for composites
- event handlers: onFileModified/Created 添加 classifyRoles() 调用

### related-notes-view.ts
- 角色标签: 🔹atom / 📄composite + reuseCount tooltip
- embed signal chip: 'embed' with file-symlink icon
- profile meta: 显示角色 + reuse 次数
- tooltip: 添加 embed distance 信息

### styles.css
- .ag-rel-signal-embed: 红色系 embed chip 样式
- .ag-rel-role-badge: 角色标签样式
- .ag-rel-reuse-count: reuse 计数高亮样式
