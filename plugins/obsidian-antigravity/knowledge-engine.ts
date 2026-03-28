/**
 * Knowledge Relationship Engine — Core
 *
 * Builds and maintains an incremental index of note relationships
 * using multi-path recall (graph, tags, tokens, entities, titles)
 * and weighted scoring.
 *
 * L0: Pure local computation (Obsidian API + JS), no AI dependency.
 * L1: Optional AI enrichment via KnowledgeProvider interface.
 */

import { App, TFile, MetadataCache, CachedMetadata, debounce } from 'obsidian';

// ── Data Types ──

export type NoteRole = 'atom' | 'composite' | 'standalone';

export interface NoteProfile {
  path: string;
  contentHash: string;
  tokens: string[];
  entities: string[];
  topics: string[];
  tags: string[];
  outLinks: string[];
  outEmbeds: string[];
  role: NoteRole;
  reuseCount: number;
  noteType: string;
  wordCount: number;
  lastModified: number;
  enrichedByAI: boolean;
  embedding?: number[];
}

export interface RelationshipSignals {
  linkDistance?: number;
  embedDistance?: number;
  sharedTags?: number;
  tokenSim?: number;
  entityOverlap?: number;
  titleSim?: number;
  semanticSim?: number;
}

export interface Relationship {
  target: string;
  score: number;
  signals: RelationshipSignals;
  type: 'explicit' | 'inferred';
}

export interface KnowledgeIndex {
  version: number;
  totalNotes: number;
  profiles: Record<string, NoteProfile>;
  tokenIndex: Record<string, string[]>;
  entityIndex: Record<string, string[]>;
  docFrequency: Record<string, number>;
  relations: Record<string, Relationship[]>;
  lastFullBuild: number;
}

export interface KnowledgeProvider {
  extractEntities(content: string): Promise<string[]>;
  extractTopics(content: string): Promise<string[]>;
  extractKeywords(content: string): Promise<string[]>;
  generateSummary(content: string): Promise<string>;
  getEmbedding?(content: string): Promise<number[]>;
}

export interface IndexStore {
  load(): Promise<KnowledgeIndex | null>;
  save(index: KnowledgeIndex): Promise<void>;
  clear(): Promise<void>;
}

// ── Constants ──

const INDEX_VERSION = 3;
const MAX_RELATIONS_PER_NOTE = 10;
const NOISE_THRESHOLD = 0.1;
const DEBOUNCE_SAVE_MS = 2000;
const MAX_TOKENS_PER_NOTE = 200;

// Scoring weights
const W_LINK = 3.0;
const W_EMBED = 4.0;
const W_TAG = 2.0;
const W_ENTITY = 2.0;
const W_TOKEN = 1.5;
const W_TITLE = 1.0;
const W_SEMANTIC = 2.5;

// ── Stopwords (English + Chinese common) ──

const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'must', 'need',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into',
  'about', 'between', 'through', 'after', 'before', 'during', 'without', 'under',
  'and', 'or', 'but', 'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too',
  'very', 'just', 'also', 'more', 'most', 'only', 'own', 'same', 'other',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'some', 'any', 'many', 'much',
  'here', 'there', 'up', 'out', 'over', 'again', 'further', 'once',
  // Chinese common particles
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些',
  '什么', '怎么', '如何', '为什么', '可以', '能', '吗', '呢', '吧', '啊',
  '把', '被', '让', '给', '从', '向', '对', '但', '而', '或', '与', '及',
]);

// ── Token Extractor ──

export function tokenize(text: string): string[] {
  // Split by non-word characters (handles CJK via separate regex)
  const words = text.toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')        // remove code blocks
    .replace(/`[^`]+`/g, ' ')               // remove inline code
    .replace(/https?:\/\/\S+/g, ' ')        // remove URLs
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // extract wikilink text
    .replace(/[#*_~>\[\](){}|\\\/!@$%^&+=<>"';:,.\-\d]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));

  // Deduplicate but preserve order (first occurrence)
  const seen = new Set<string>();
  const result: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      result.push(w);
    }
  }
  return result.slice(0, MAX_TOKENS_PER_NOTE);
}

// ── Entity Extractor (L0 — Regex) ──

export function extractEntitiesRegex(text: string): string[] {
  const entities = new Set<string>();

  // 1. [[wikilinks]]
  const wikilinks = text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
  for (const m of wikilinks) {
    const name = m[1].trim();
    if (name.length >= 2) entities.add(name);
  }

  // 2. Capitalized multi-word phrases (English entities)
  //    e.g. "Machine Learning", "Neural Network Architecture"
  const caps = text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g);
  for (const m of caps) {
    const phrase = m[1].trim();
    if (phrase.length >= 3 && !STOPWORDS.has(phrase.toLowerCase())) {
      entities.add(phrase);
    }
  }

  // 3. Quoted terms (significant references)
  const quoted = text.matchAll(/"([^"]{2,50})"/g);
  for (const m of quoted) entities.add(m[1].trim());

  // 4. Hashtags as entities
  const hashtags = text.matchAll(/#([a-zA-Z\u4e00-\u9fa5][\w\u4e00-\u9fa5/-]*)/g);
  for (const m of hashtags) {
    if (m[1].length >= 2) entities.add(m[1]);
  }

  return [...entities].slice(0, 50);
}

// ── Topic Extractor (L0 — Heading based) ──

export function extractTopicsFromMeta(cache: CachedMetadata | null): string[] {
  if (!cache?.headings) return [];
  return cache.headings
    .filter(h => h.level <= 3)
    .map(h => h.heading.trim())
    .filter(h => h.length >= 2)
    .slice(0, 20);
}

// ── Content Hash ──

export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

// ── TF-IDF ──

function computeTFVector(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  const total = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / total);
  }
  return tf;
}

function cosineSimilarity(
  tfA: Map<string, number>,
  tfB: Map<string, number>,
  idf: Record<string, number>,
  totalDocs: number,
): number {
  let dot = 0, normA = 0, normB = 0;
  const allKeys = new Set([...tfA.keys(), ...tfB.keys()]);

  for (const key of allKeys) {
    const df = idf[key] || 1;
    const idfVal = Math.log((totalDocs + 1) / (df + 1));
    const a = (tfA.get(key) || 0) * idfVal;
    const b = (tfB.get(key) || 0) * idfVal;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Jaccard Similarity (for titles) ──

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function embeddingCosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── File Index Store ──

export class FileIndexStore implements IndexStore {
  private basePath: string;
  private app: App;

  constructor(app: App, pluginId: string) {
    this.app = app;
    this.basePath = `${app.vault.configDir}/plugins/${pluginId}/knowledge-index.json`;
  }

  async load(): Promise<KnowledgeIndex | null> {
    try {
      const exists = await this.app.vault.adapter.exists(this.basePath);
      if (!exists) return null;
      const raw = await this.app.vault.adapter.read(this.basePath);
      const data = JSON.parse(raw) as KnowledgeIndex;
      if (data.version !== INDEX_VERSION) return null; // version mismatch, rebuild
      return data;
    } catch {
      return null;
    }
  }

  async save(index: KnowledgeIndex): Promise<void> {
    try {
      const raw = JSON.stringify(index);
      await this.app.vault.adapter.write(this.basePath, raw);
    } catch (e) {
      console.warn('[Knowledge] Failed to persist index:', e);
    }
  }

  async clear(): Promise<void> {
    try {
      const exists = await this.app.vault.adapter.exists(this.basePath);
      if (exists) await this.app.vault.adapter.remove(this.basePath);
    } catch { /* ignore */ }
  }
}

// ── IndexedDB Store (for large vaults) ──

export class IDBIndexStore implements IndexStore {
  private dbName: string;
  private storeName = 'index';
  private cachedDB: IDBDatabase | null = null;

  constructor(vaultName: string) {
    this.dbName = `ag-knowledge-${vaultName}`;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.cachedDB) return this.cachedDB;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => {
        this.cachedDB = request.result;
        // Clear cache if connection closes unexpectedly
        this.cachedDB.onclose = () => { this.cachedDB = null; };
        resolve(this.cachedDB);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async load(): Promise<KnowledgeIndex | null> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.get('knowledgeIndex');
        request.onsuccess = () => {
          const data = request.result as KnowledgeIndex | undefined;
          if (!data || data.version !== INDEX_VERSION) resolve(null);
          else resolve(data);
        };
        request.onerror = () => reject(request.error);
      });
    } catch {
      this.cachedDB = null; // reset on error
      return null;
    }
  }

  async save(index: KnowledgeIndex): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put(index, 'knowledgeIndex');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      this.cachedDB = null;
      console.warn('[Knowledge] IDB save failed:', e);
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      this.cachedDB = null;
    }
  }
}

// ── Knowledge Engine ──

export type RelationsUpdateCallback = (path: string, relations: Relationship[]) => void;

export class KnowledgeEngine {
  private app: App;
  private store: IndexStore;
  private index: KnowledgeIndex;
  private provider: KnowledgeProvider | null = null;
  private onRelationsUpdate: RelationsUpdateCallback | null = null;
  private excludeFolders: Set<string> = new Set();
  private titleTokensCache = new Map<string, Set<string>>(); // path → title words
  private reverseEmbedIndex = new Map<string, Set<string>>(); // embeddedPath → Set<embedderPaths>
  private tagIndex = new Map<string, Set<string>>(); // tag → Set<paths> (runtime only)
  private debouncedSave: () => void;
  private debouncedClassifyRoles: () => void;

  constructor(app: App, store: IndexStore) {
    this.app = app;
    this.store = store;
    this.index = this.createEmptyIndex();
    this.debouncedSave = debounce(() => this.persistIndex(), DEBOUNCE_SAVE_MS, true);
    this.debouncedClassifyRoles = debounce(() => {
      this.classifyRoles();
      this.debouncedSave();
    }, 3000, true);
  }

  private createEmptyIndex(): KnowledgeIndex {
    return {
      version: INDEX_VERSION,
      totalNotes: 0,
      profiles: {},
      tokenIndex: {},
      entityIndex: {},
      docFrequency: {},
      relations: {},
      lastFullBuild: 0,
    };
  }

  // ── Lifecycle ──

  async initialize(excludeFolders?: string) {
    // Parse exclude folders
    if (excludeFolders) {
      for (const f of excludeFolders.split(',')) {
        const trimmed = f.trim().toLowerCase();
        if (trimmed) this.excludeFolders.add(trimmed);
      }
    }

    // Try loading existing index
    const loaded = await this.store.load();
    if (loaded) {
      this.index = loaded;
      // Rebuild title cache + reverse embed index + tag index
      for (const [path, profile] of Object.entries(this.index.profiles)) {
        this.titleTokensCache.set(path, this.extractTitleTokens(path));
        for (const target of profile.outEmbeds) {
          if (!this.reverseEmbedIndex.has(target)) {
            this.reverseEmbedIndex.set(target, new Set());
          }
          this.reverseEmbedIndex.get(target)!.add(path);
        }
        for (const tag of profile.tags) {
          if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
          this.tagIndex.get(tag)!.add(path);
        }
      }
    } else {
      // Full build
      await this.fullBuild();
    }
  }

  async fullBuild() {
    const startTime = Date.now();
    this.index = this.createEmptyIndex();
    this.titleTokensCache.clear();
    this.reverseEmbedIndex.clear();
    this.tagIndex.clear();

    const files = this.app.vault.getMarkdownFiles()
      .filter(f => !this.shouldExclude(f.path));

    // Phase 1: Extract profiles
    for (const file of files) {
      await this.indexNote(file, false);
    }

    // Phase 1.5: Classify roles (needs all profiles to compute reuseCount)
    this.classifyRoles();

    // Phase 2: Compute relations for all notes
    for (const path of Object.keys(this.index.profiles)) {
      this.computeRelations(path);
    }

    this.index.totalNotes = Object.keys(this.index.profiles).length;
    this.index.lastFullBuild = Date.now();

    await this.store.save(this.index);
    console.log(`[Knowledge] Full build: ${this.index.totalNotes} notes, roles classified, ${Date.now() - startTime}ms`);
  }

  /**
   * Classify all notes' roles and compute reuse counts.
   * Must be called after all profiles are built.
   */
  private classifyRoles() {
    // Step 1: Build reverse embed index + count how many times each note is embedded
    this.reverseEmbedIndex.clear();
    const embedCounts = new Map<string, number>();
    for (const profile of Object.values(this.index.profiles)) {
      for (const target of profile.outEmbeds) {
        embedCounts.set(target, (embedCounts.get(target) || 0) + 1);
        if (!this.reverseEmbedIndex.has(target)) {
          this.reverseEmbedIndex.set(target, new Set());
        }
        this.reverseEmbedIndex.get(target)!.add(profile.path);
      }
    }

    // Step 2: Assign reuseCount and classify role
    for (const profile of Object.values(this.index.profiles)) {
      profile.reuseCount = embedCounts.get(profile.path) || 0;

      // Explicit user designation takes priority
      if (profile.noteType === 'atom') {
        profile.role = 'atom';
      } else if (profile.outEmbeds.length >= 2) {
        profile.role = 'composite';
      } else if (profile.reuseCount >= 2 && profile.wordCount < 1000) {
        // Inferred atom: short, multiply embedded
        profile.role = 'atom';
      } else {
        profile.role = 'standalone';
      }
    }
  }

  setProvider(provider: KnowledgeProvider | null) {
    this.provider = provider;
  }

  setOnRelationsUpdate(cb: RelationsUpdateCallback) {
    this.onRelationsUpdate = cb;
  }

  // ── Event Handlers ──

  async onFileModified(file: TFile) {
    if (file.extension !== 'md' || this.shouldExclude(file.path)) return;
    try {
      await this.indexNote(file, true);
      this.debouncedClassifyRoles();
      this.computeRelations(file.path);
      this.cascadeUpdate(file.path);
      this.debouncedSave();
      this.emitUpdate(file.path);
    } catch (e) {
      console.warn('[Knowledge] Error indexing modified file:', file.path, e);
    }
  }

  async onFileCreated(file: TFile) {
    if (file.extension !== 'md' || this.shouldExclude(file.path)) return;
    try {
      await this.indexNote(file, true);
      this.index.totalNotes = Object.keys(this.index.profiles).length;
      this.debouncedClassifyRoles();
      this.computeRelations(file.path);
      this.cascadeUpdate(file.path);
      this.debouncedSave();
      this.emitUpdate(file.path);
    } catch (e) {
      console.warn('[Knowledge] Error indexing created file:', file.path, e);
    }
  }

  onFileDeleted(path: string) {
    if (!this.index.profiles[path]) return;
    this.removeFromIndex(path);
    this.index.totalNotes = Object.keys(this.index.profiles).length;
    this.debouncedSave();
  }

  onFileRenamed(oldPath: string, newPath: string) {
    const profile = this.index.profiles[oldPath];
    if (!profile) return;

    // Move profile
    profile.path = newPath;
    this.index.profiles[newPath] = profile;
    delete this.index.profiles[oldPath];

    // Move relations
    if (this.index.relations[oldPath]) {
      this.index.relations[newPath] = this.index.relations[oldPath];
      delete this.index.relations[oldPath];
    }

    // Update references in other notes' relations
    for (const [, rels] of Object.entries(this.index.relations)) {
      for (const rel of rels) {
        if (rel.target === oldPath) rel.target = newPath;
      }
    }

    // Update index entries
    this.updateIndexReferences(oldPath, newPath, this.index.tokenIndex);
    this.updateIndexReferences(oldPath, newPath, this.index.entityIndex);

    // Update title cache
    this.titleTokensCache.delete(oldPath);
    this.titleTokensCache.set(newPath, this.extractTitleTokens(newPath));

    this.debouncedSave();
  }

  // ── Queries ──

  getRelations(path: string): Relationship[] {
    return this.index.relations[path] || [];
  }

  getProfile(path: string): NoteProfile | null {
    return this.index.profiles[path] || null;
  }

  /** Return all indexed note paths. Safe for external iteration. */
  getAllPaths(): string[] {
    return Object.keys(this.index.profiles);
  }

  /** Return all indexed profiles. Safe for external iteration. */
  getAllProfiles(): NoteProfile[] {
    return Object.values(this.index.profiles);
  }

  getStats() {
    const profiles = Object.values(this.index.profiles);
    return {
      totalNotes: this.index.totalNotes,
      totalRelations: Object.values(this.index.relations).reduce((s, r) => s + r.length, 0),
      indexTokens: Object.keys(this.index.tokenIndex).length,
      indexEntities: Object.keys(this.index.entityIndex).length,
      enrichedNotes: profiles.filter(p => p.enrichedByAI).length,
    };
  }

  /**
   * Query the knowledge index with raw text (e.g. a chat message).
   * Returns top-N note paths ranked by token + entity overlap with the query text.
   * @param text The query text (user message)
   * @param topN Max results to return (default 5)
   * @param excludePaths Paths to exclude from results
   */
  queryByText(text: string, topN = 5, excludePaths?: Set<string>): { path: string; score: number }[] {
    const queryTokens = tokenize(text);
    const queryEntities = extractEntitiesRegex(text);
    if (queryTokens.length === 0 && queryEntities.length === 0) return [];

    const scores = new Map<string, number>();

    // Token recall: find notes sharing tokens with the query
    for (const token of queryTokens) {
      const paths = this.index.tokenIndex[token];
      if (!paths) continue;
      for (const p of paths) {
        if (excludePaths?.has(p)) continue;
        scores.set(p, (scores.get(p) || 0) + 1);
      }
    }

    // Entity recall: stronger signal, weighted 2x
    for (const entity of queryEntities) {
      const key = entity.toLowerCase();
      const paths = this.index.entityIndex[key];
      if (!paths) continue;
      for (const p of paths) {
        if (excludePaths?.has(p)) continue;
        scores.set(p, (scores.get(p) || 0) + 2);
      }
    }

    // Normalize by query size to get 0-1 range (roughly)
    const maxPossible = queryTokens.length + queryEntities.length * 2;
    const results = Array.from(scores.entries())
      .map(([path, raw]) => ({ path, score: raw / maxPossible }))
      .filter(r => r.score > 0.05) // noise threshold
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);

    return results;
  }

  /**
   * Batch-enrich unenriched notes with AI provider.
   * Processes notes one by one with throttling. Safe to call multiple times.
   * @param maxNotes Max notes to enrich in this batch (default 20)
   * @param onProgress Called after each note is processed
   */
  async enrichBatch(
    maxNotes = 20,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    if (!this.provider) return 0;

    const unenriched = Object.entries(this.index.profiles)
      .filter(([, p]) => !p.enrichedByAI)
      .map(([path]) => path)
      .slice(0, maxNotes);

    if (unenriched.length === 0) return 0;

    let done = 0;
    for (const path of unenriched) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const content = await this.app.vault.cachedRead(file);
        await this.enrichNoteAsync(path, content);
        done++;
        onProgress?.(done, unenriched.length);
      }
    }
    return done;
  }

  // ── Internal: Indexing ──

  private async indexNote(file: TFile, checkHash: boolean) {
    const content = await this.app.vault.cachedRead(file);
    const hash = simpleHash(content);

    // Skip if content hasn't changed
    if (checkHash && this.index.profiles[file.path]?.contentHash === hash) {
      return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const tokens = tokenize(content);
    const entities = extractEntitiesRegex(content);
    const topics = extractTopicsFromMeta(cache);
    const tags = (cache?.tags || []).map(t => t.tag.replace(/^#/, ''));
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const outLinks = resolvedLinks ? Object.keys(resolvedLinks[file.path] || {}) : [];

    // Extract embed targets from ![[embed]] syntax
    const outEmbeds: string[] = [];
    if (cache?.embeds) {
      for (const embed of cache.embeds) {
        const resolved = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
        if (resolved) outEmbeds.push(resolved.path);
      }
    }

    // Read frontmatter type
    const noteType = (cache?.frontmatter?.type as string) || '';

    // Remove old index entries
    const oldProfile = this.index.profiles[file.path];
    if (oldProfile) {
      this.removeTokensFromIndex(file.path, oldProfile.tokens, this.index.tokenIndex, this.index.docFrequency);
      this.removeTokensFromIndex(file.path, oldProfile.entities, this.index.entityIndex, null);
      // Remove old tags from tagIndex
      for (const tag of oldProfile.tags) {
        this.tagIndex.get(tag)?.delete(file.path);
        if (this.tagIndex.get(tag)?.size === 0) this.tagIndex.delete(tag);
      }
    }

    // Create new profile
    const profile: NoteProfile = {
      path: file.path,
      contentHash: hash,
      tokens,
      entities,
      topics,
      tags,
      outLinks,
      outEmbeds,
      role: 'standalone',
      reuseCount: 0,
      noteType,
      wordCount: content.split(/\s+/).length,
      lastModified: file.stat.mtime,
      enrichedByAI: false,
    };
    this.index.profiles[file.path] = profile;

    // Add new index entries
    this.addTokensToIndex(file.path, tokens, this.index.tokenIndex, this.index.docFrequency);
    this.addTokensToIndex(file.path, entities, this.index.entityIndex, null);

    // Update tag index
    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
      this.tagIndex.get(tag)!.add(file.path);
    }

    // Update title cache
    this.titleTokensCache.set(file.path, this.extractTitleTokens(file.path));

    // AI enrichment (async, non-blocking)
    if (this.provider && !profile.enrichedByAI) {
      this.enrichNoteAsync(file.path, content);
    }
  }

  /**
   * Enrich a note profile with AI-extracted entities/topics.
   * Runs in background; merges results into existing profile.
   */
  private async enrichNoteAsync(path: string, content: string) {
    if (!this.provider) return;
    const profile = this.index.profiles[path];
    if (!profile || profile.enrichedByAI) return;

    try {
      // Use batch extraction if available (single API call)
      const provider = this.provider as any;
      let aiEntities: string[] = [];
      let aiTopics: string[] = [];

      if (typeof provider.extractAll === 'function') {
        const result = await provider.extractAll(content);
        aiEntities = result.entities || [];
        aiTopics = result.topics || [];
      } else {
        [aiEntities, aiTopics] = await Promise.all([
          this.provider.extractEntities(content),
          this.provider.extractTopics(content),
        ]);
      }

      // Re-fetch profile (may have changed during async call)
      const current = this.index.profiles[path];
      if (!current) return;

      // Merge: add AI entities/topics that aren't already present
      const entitySet = new Set(current.entities.map(e => e.toLowerCase()));
      for (const e of aiEntities) {
        if (!entitySet.has(e.toLowerCase())) {
          current.entities.push(e);
          // Add to entity index
          if (!this.index.entityIndex[e]) this.index.entityIndex[e] = [];
          if (!this.index.entityIndex[e].includes(path)) {
            this.index.entityIndex[e].push(path);
          }
        }
      }

      const topicSet = new Set(current.topics.map(t => t.toLowerCase()));
      for (const t of aiTopics) {
        if (!topicSet.has(t.toLowerCase())) {
          current.topics.push(t);
        }
      }

      current.enrichedByAI = true;

      // Fetch embedding if provider supports it
      if (typeof this.provider.getEmbedding === 'function') {
        try {
          const embedding = await this.provider.getEmbedding(content);
          if (embedding.length > 0) {
            const latest = this.index.profiles[path];
            if (latest) latest.embedding = embedding;
          }
        } catch { /* embedding is optional */ }
      }

      // Recompute relations with enriched data
      this.computeRelations(path);
      this.debouncedSave();
      this.emitUpdate(path);
    } catch (e) {
      console.warn('[Knowledge] AI enrichment failed for:', path, e);
    }
  }

  // ── Internal: Index Manipulation ──

  private addTokensToIndex(
    path: string,
    tokens: string[],
    index: Record<string, string[]>,
    df: Record<string, number> | null,
  ) {
    const seen = new Set<string>();
    for (const token of tokens) {
      if (!index[token]) index[token] = [];
      if (!index[token].includes(path)) {
        index[token].push(path);
      }
      if (df && !seen.has(token)) {
        df[token] = (df[token] || 0) + 1;
        seen.add(token);
      }
    }
  }

  private removeTokensFromIndex(
    path: string,
    tokens: string[],
    index: Record<string, string[]>,
    df: Record<string, number> | null,
  ) {
    const seen = new Set<string>();
    for (const token of tokens) {
      if (index[token]) {
        index[token] = index[token].filter(p => p !== path);
        if (index[token].length === 0) delete index[token];
      }
      if (df && !seen.has(token)) {
        df[token] = Math.max((df[token] || 0) - 1, 0);
        if (df[token] === 0) delete df[token];
        seen.add(token);
      }
    }
  }

  private removeFromIndex(path: string) {
    const profile = this.index.profiles[path];
    if (profile) {
      this.removeTokensFromIndex(path, profile.tokens, this.index.tokenIndex, this.index.docFrequency);
      this.removeTokensFromIndex(path, profile.entities, this.index.entityIndex, null);
      for (const tag of profile.tags) {
        this.tagIndex.get(tag)?.delete(path);
        if (this.tagIndex.get(tag)?.size === 0) this.tagIndex.delete(tag);
      }
    }
    delete this.index.profiles[path];
    delete this.index.relations[path];
    this.titleTokensCache.delete(path);

    // Remove from other notes' relations
    for (const [, rels] of Object.entries(this.index.relations)) {
      const idx = rels.findIndex(r => r.target === path);
      if (idx >= 0) rels.splice(idx, 1);
    }
  }

  private updateIndexReferences(oldPath: string, newPath: string, index: Record<string, string[]>) {
    for (const [, paths] of Object.entries(index)) {
      const idx = paths.indexOf(oldPath);
      if (idx >= 0) paths[idx] = newPath;
    }
  }

  // ── Internal: Multi-Path Recall + Ranking ──

  private computeRelations(sourcePath: string) {
    const profile = this.index.profiles[sourcePath];
    if (!profile) return;

    // T6: Content inheritance — composite notes inherit embedded atoms' tokens/entities
    let effectiveTokens = profile.tokens;
    let effectiveEntities = profile.entities;
    if (profile.role === 'composite') {
      const mergedTokens = [...profile.tokens];
      const mergedEntities = [...profile.entities];
      const seenTokens = new Set(profile.tokens);
      const seenEntities = new Set(profile.entities.map(e => e.toLowerCase()));
      for (const embedPath of profile.outEmbeds) {
        const ep = this.index.profiles[embedPath];
        if (ep) {
          for (const t of ep.tokens) {
            if (!seenTokens.has(t)) { mergedTokens.push(t); seenTokens.add(t); }
          }
          for (const e of ep.entities) {
            if (!seenEntities.has(e.toLowerCase())) { mergedEntities.push(e); seenEntities.add(e.toLowerCase()); }
          }
        }
      }
      effectiveTokens = mergedTokens;
      effectiveEntities = mergedEntities;
    }

    const candidates = new Set<string>();

    // Path 1: Graph recall (1-2 hop)
    const directLinks = new Set<string>();
    for (const link of profile.outLinks) {
      if (this.index.profiles[link]) {
        candidates.add(link);
        directLinks.add(link);
      }
    }
    // Embed targets (stronger than links)
    const directEmbeds = new Set<string>();
    for (const embed of profile.outEmbeds) {
      if (this.index.profiles[embed]) {
        candidates.add(embed);
        directEmbeds.add(embed);
      }
    }
    // Backlinks
    const resolvedLinks = this.app.metadataCache.resolvedLinks || {};
    for (const [otherPath, links] of Object.entries(resolvedLinks)) {
      if (otherPath !== sourcePath && links[sourcePath]) {
        candidates.add(otherPath);
        directLinks.add(otherPath);
      }
    }
    // Back-embeds (notes that embed this note) — O(1) via reverse index
    const backEmbedders = this.reverseEmbedIndex.get(sourcePath);
    if (backEmbedders) {
      for (const embedderPath of backEmbedders) {
        if (embedderPath !== sourcePath) {
          candidates.add(embedderPath);
          directEmbeds.add(embedderPath);
        }
      }
    }
    // 2-hop neighbors (through links and embeds)
    const oneHop = new Set([...directLinks, ...directEmbeds]);
    for (const neighbor of oneHop) {
      const neighborProfile = this.index.profiles[neighbor];
      if (neighborProfile) {
        for (const link of neighborProfile.outLinks) {
          if (link !== sourcePath && this.index.profiles[link]) {
            candidates.add(link);
          }
        }
      }
    }

    // Path 2: Tag recall (via tagIndex — O(tags × avg_notes_per_tag))
    for (const tag of profile.tags) {
      const taggedPaths = this.tagIndex.get(tag);
      if (taggedPaths) {
        for (const otherPath of taggedPaths) {
          if (otherPath !== sourcePath) candidates.add(otherPath);
        }
      }
    }

    // Path 3: Token recall (top TF-IDF tokens → inverted index)
    const tfA = computeTFVector(effectiveTokens);
    const topTokens = [...tfA.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([token]) => token);
    for (const token of topTokens) {
      const paths = this.index.tokenIndex[token];
      if (paths) {
        for (const p of paths) {
          if (p !== sourcePath) candidates.add(p);
        }
      }
    }

    // Path 4: Title recall
    const sourceTitleTokens = this.titleTokensCache.get(sourcePath);
    if (sourceTitleTokens && sourceTitleTokens.size > 0) {
      for (const [otherPath, otherTokens] of this.titleTokensCache) {
        if (otherPath !== sourcePath && otherTokens.size > 0) {
          // Check if any title tokens overlap
          for (const t of sourceTitleTokens) {
            if (otherTokens.has(t)) {
              candidates.add(otherPath);
              break;
            }
          }
        }
      }
    }

    // Path 5: Entity recall
    for (const entity of effectiveEntities.slice(0, 10)) {
      const paths = this.index.entityIndex[entity];
      if (paths) {
        for (const p of paths) {
          if (p !== sourcePath) candidates.add(p);
        }
      }
    }

    // ── Score candidates ──
    const scored: Relationship[] = [];
    const totalDocs = this.index.totalNotes || 1;

    for (const targetPath of candidates) {
      const targetProfile = this.index.profiles[targetPath];
      if (!targetProfile) continue;

      const signals: RelationshipSignals = {};
      let totalWeight = 0;
      let totalScore = 0;

      // Signal 1: Link distance
      if (directLinks.has(targetPath)) {
        signals.linkDistance = 1;
        totalScore += W_LINK * 1.0;
      } else {
        // Check 2-hop
        let is2hop = false;
        for (const mid of directLinks) {
          const midProfile = this.index.profiles[mid];
          if (midProfile && midProfile.outLinks.includes(targetPath)) {
            is2hop = true;
            break;
          }
        }
        if (is2hop) {
          signals.linkDistance = 2;
          totalScore += W_LINK * 0.5;
        }
      }
      totalWeight += W_LINK;

      // Signal 1.5: Embed distance (stronger than link)
      if (directEmbeds.has(targetPath)) {
        signals.embedDistance = 1;
        totalScore += W_EMBED * 1.0;
      }
      totalWeight += W_EMBED;

      // Signal 2: Shared tags
      const commonTags = profile.tags.filter(t => targetProfile.tags.includes(t));
      if (commonTags.length > 0) {
        signals.sharedTags = commonTags.length;
        totalScore += W_TAG * Math.min(commonTags.length / 3, 1.0);
      }
      totalWeight += W_TAG;

      // Signal 3: Token similarity (TF-IDF cosine)
      if (effectiveTokens.length > 0 && targetProfile.tokens.length > 0) {
        const tfB = computeTFVector(targetProfile.tokens);
        const sim = cosineSimilarity(tfA, tfB, this.index.docFrequency, totalDocs);
        if (sim > 0) {
          signals.tokenSim = Math.round(sim * 1000) / 1000;
          totalScore += W_TOKEN * sim;
        }
      }
      totalWeight += W_TOKEN;

      // Signal 4: Entity overlap
      const commonEntities = effectiveEntities.filter(e =>
        targetProfile.entities.some(te => te.toLowerCase() === e.toLowerCase())
      );
      if (commonEntities.length > 0) {
        signals.entityOverlap = commonEntities.length;
        totalScore += W_ENTITY * Math.min(commonEntities.length / 5, 1.0);
      }
      totalWeight += W_ENTITY;

      // Signal 5: Title similarity
      const targetTitleTokens = this.titleTokensCache.get(targetPath);
      if (sourceTitleTokens && targetTitleTokens && sourceTitleTokens.size > 0 && targetTitleTokens.size > 0) {
        const titleJaccard = jaccardSimilarity(sourceTitleTokens, targetTitleTokens);
        if (titleJaccard > 0) {
          signals.titleSim = Math.round(titleJaccard * 1000) / 1000;
          totalScore += W_TITLE * titleJaccard;
        }
      }
      totalWeight += W_TITLE;

      // Signal 7: Semantic similarity (topic + enriched data overlap)
      // Uses AI-extracted topics as a semantic layer above raw tokens
      if (profile.topics.length > 0 && targetProfile.topics.length > 0) {
        const srcTopics = new Set(profile.topics.map(t => t.toLowerCase()));
        const tgtTopics = new Set(targetProfile.topics.map(t => t.toLowerCase()));
        let topicOverlap = 0;
        for (const t of srcTopics) { if (tgtTopics.has(t)) topicOverlap++; }
        if (topicOverlap > 0) {
          const topicSim = topicOverlap / Math.max(srcTopics.size, tgtTopics.size);
          signals.semanticSim = Math.round(topicSim * 1000) / 1000;
          totalScore += W_SEMANTIC * topicSim;
        }
      }
      // Also check embedding cosine similarity if available
      if (
        profile.embedding && targetProfile.embedding &&
        profile.embedding.length > 0 && profile.embedding.length === targetProfile.embedding.length
      ) {
        const embSim = embeddingCosine(profile.embedding, targetProfile.embedding);
        if (embSim > 0) {
          // Combine: use max of topic-based and embedding-based similarity
          const current = signals.semanticSim || 0;
          if (embSim > current) {
            signals.semanticSim = Math.round(embSim * 1000) / 1000;
            // Adjust score: replace topic-based with embedding-based
            totalScore += W_SEMANTIC * (embSim - current);
          }
        }
      }
      totalWeight += W_SEMANTIC;

      const score = totalWeight > 0 ? totalScore / totalWeight : 0;
      if (score < NOISE_THRESHOLD) continue;

      const hasExplicitLink = signals.linkDistance === 1 || signals.embedDistance === 1;
      scored.push({
        target: targetPath,
        score: Math.round(score * 1000) / 1000,
        signals,
        type: hasExplicitLink ? 'explicit' : 'inferred',
      });
    }

    // ── Post-processing ──

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Recency boost
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    for (const rel of scored) {
      const tp = this.index.profiles[rel.target];
      if (tp && (now - tp.lastModified) < SEVEN_DAYS) {
        rel.score = Math.round(rel.score * 1.1 * 1000) / 1000;
      }
    }

    // Reciprocity bonus
    for (const rel of scored) {
      const reverseRels = this.index.relations[rel.target];
      if (reverseRels?.some(r => r.target === sourcePath)) {
        rel.score = Math.round(rel.score * 1.15 * 1000) / 1000;
      }
    }

    // Re-sort after boosts
    scored.sort((a, b) => b.score - a.score);

    // Diversity filter: max 3 from same folder
    const folderCounts = new Map<string, number>();
    const diverse: Relationship[] = [];
    for (const rel of scored) {
      const folder = rel.target.split('/').slice(0, -1).join('/') || '/';
      const count = folderCounts.get(folder) || 0;
      if (count < 3) {
        diverse.push(rel);
        folderCounts.set(folder, count + 1);
        if (diverse.length >= MAX_RELATIONS_PER_NOTE) break;
      }
    }

    this.index.relations[sourcePath] = diverse;
  }

  private cascadeUpdate(sourcePath: string) {
    // Only cascade to direct links (1-hop) to avoid O(n²) recomputation
    const rels = this.index.relations[sourcePath] || [];
    const directTargets = rels
      .filter(r => r.signals.linkDistance === 1)
      .slice(0, 5); // limit cascade scope
    for (const rel of directTargets) {
      this.computeRelations(rel.target);
    }
  }

  // ── Internal: Helpers ──

  private extractTitleTokens(path: string): Set<string> {
    const basename = path.split('/').pop()?.replace(/\.md$/, '') || '';
    const words = basename.toLowerCase()
      .split(/[\s_\-/]+/)
      .filter(w => w.length >= 2 && !STOPWORDS.has(w));
    return new Set(words);
  }

  private shouldExclude(path: string): boolean {
    const parts = path.toLowerCase().split('/');
    return parts.some(p => this.excludeFolders.has(p));
  }

  private async persistIndex() {
    await this.store.save(this.index);
  }

  private emitUpdate(path: string) {
    if (this.onRelationsUpdate) {
      this.onRelationsUpdate(path, this.index.relations[path] || []);
    }
  }
}
