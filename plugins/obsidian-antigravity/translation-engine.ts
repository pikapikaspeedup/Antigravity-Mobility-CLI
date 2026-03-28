/**
 * Translation Engine — Block-level multilingual translation with caching.
 *
 * Core responsibilities:
 * 1. Split markdown into translatable blocks (preserving structure)
 * 2. Hash blocks for incremental change detection
 * 3. Translate via Copilot API with format preservation
 * 4. Cache translations in IndexedDB for fast retrieval
 * 5. Detect stale blocks and retranslate only what changed
 */

import { App, TFile, Notice } from 'obsidian';
import { callCopilot } from './copilot-api';
import type { CopilotCredentials } from './copilot-auth';
import { logger } from './logger';

const LOG_SRC = 'Translation';

// ── Types ──

export type SupportedLang = 'zh' | 'en' | 'ja' | 'ko' | 'es' | 'fr' | 'de';

export const LANG_LABELS: Record<SupportedLang, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
};

export interface TranslatedBlock {
  index: number;
  sourceHash: string;
  sourceText: string;
  translatedText: string;
  isStale: boolean;
}

export interface TranslationEntry {
  sourcePath: string;
  sourceContentHash: string;
  targetLang: SupportedLang;
  blocks: TranslatedBlock[];
  fullTranslation: string;      // Assembled from blocks
  lastTranslated: number;       // Timestamp ms
  staleBlockCount: number;
}

// ── Block Splitting ──

/** Represents a parsed block from markdown content */
interface ContentBlock {
  index: number;
  text: string;
  translatable: boolean;  // false for code fences, frontmatter, etc.
}

/**
 * Split markdown into blocks at semantic boundaries.
 * Preserves code blocks, frontmatter, and empty lines as non-translatable.
 */
export function splitIntoBlocks(content: string): ContentBlock[] {
  if (!content) return [];

  const blocks: ContentBlock[] = [];
  const lines = content.split('\n');
  let current: string[] = [];
  let inCodeFence = false;
  let inFrontmatter = false;
  let blockIndex = 0;

  const flush = (translatable: boolean) => {
    if (current.length > 0) {
      blocks.push({
        index: blockIndex++,
        text: current.join('\n'),
        translatable,
      });
      current = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Frontmatter detection
    if (i === 0 && line === '---') {
      inFrontmatter = true;
      current.push(line);
      continue;
    }
    if (inFrontmatter) {
      current.push(line);
      if (line === '---') {
        inFrontmatter = false;
        flush(false); // frontmatter is not translated
      }
      continue;
    }

    // Code fence detection
    if (line.startsWith('```')) {
      if (!inCodeFence) {
        flush(true);   // flush preceding translatable block
        inCodeFence = true;
        current.push(line);
      } else {
        current.push(line);
        inCodeFence = false;
        flush(false);  // code block is not translated
      }
      continue;
    }

    if (inCodeFence) {
      current.push(line);
      continue;
    }

    // Empty line = block separator
    if (line.trim() === '') {
      flush(true);
      blocks.push({ index: blockIndex++, text: '', translatable: false });
      continue;
    }

    // Heading starts a new block
    if (line.startsWith('#') && current.length > 0) {
      flush(true);
    }

    current.push(line);
  }

  // Flush remaining
  if (inCodeFence) {
    flush(false);
  } else {
    flush(true);
  }

  return blocks;
}

/**
 * Reassemble blocks into full document text.
 */
export function assembleBlocks(blocks: { text: string }[]): string {
  return blocks.map(b => b.text).join('\n');
}

// ── Hashing ──

/**
 * Simple fast hash (djb2) for change detection. Not cryptographic.
 */
export function hashString(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

// ── Translation Cache (IndexedDB) ──

const DB_NAME = 'antigravity-translations';
const DB_VERSION = 1;
const STORE_NAME = 'translations';

function cacheKey(path: string, lang: SupportedLang): string {
  return `${lang}::${path}`;
}

export class TranslationCache {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  async get(path: string, lang: SupportedLang): Promise<TranslationEntry | null> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(cacheKey(path, lang));
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(entry: TranslationEntry): Promise<void> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const key = cacheKey(entry.sourcePath, entry.targetLang);
      const req = store.put({ key, data: entry });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async delete(path: string, lang: SupportedLang): Promise<void> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(cacheKey(path, lang));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async deleteAllForPath(path: string): Promise<void> {
    await this.open();
    const tx = this.db!.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if ((cursor.value.key as string).includes(`::${path}`)) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

// ── Language Detection ──

/**
 * Detect dominant language of text content.
 * Simple heuristic: CJK character ratio.
 */
export function detectLanguage(text: string): SupportedLang {
  // Count CJK characters (Chinese/Japanese/Korean unified ideographs)
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0;
  // Count Japanese-specific (hiragana, katakana)
  const jp = text.match(/[\u3040-\u309f\u30a0-\u30ff]/g)?.length ?? 0;
  // Count Korean-specific (hangul)
  const kr = text.match(/[\uac00-\ud7af\u1100-\u11ff]/g)?.length ?? 0;
  // Count Latin characters
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;

  const total = text.length || 1;

  if (jp / total > 0.05) return 'ja';
  if (kr / total > 0.05) return 'ko';
  if (cjk / total > 0.1) return 'zh';
  return 'en';
}

// ── Translation Engine ──

const TRANSLATION_SYSTEM_PROMPT = `You are a professional document translator. Your task:
1. Translate the given markdown text to the target language.
2. PRESERVE ALL markdown formatting exactly: headings (#), bold (**), italic (*), links ([]()), images (![]()),  lists (- / 1.), blockquotes (>), tables, inline code (\`\`), and wikilinks ([[...]]).
3. Do NOT translate: code blocks, file paths, URLs, variable names, frontmatter keys, tag names (#tag).
4. Translate naturally — not word-by-word. Adapt idioms and phrasing for the target language.
5. Output ONLY the translated text. No explanations, no wrapping.`;

export class TranslationEngine {
  private cache: TranslationCache;
  private getCredentials: () => CopilotCredentials | null;
  private onCredentialsRefreshed: (c: CopilotCredentials) => void;
  private translatingPaths = new Set<string>(); // prevent concurrent translation of same file

  constructor(
    private app: App,
    getCredentials: () => CopilotCredentials | null,
    onCredentialsRefreshed: (c: CopilotCredentials) => void,
  ) {
    this.cache = new TranslationCache();
    this.getCredentials = getCredentials;
    this.onCredentialsRefreshed = onCredentialsRefreshed;
  }

  getCache(): TranslationCache { return this.cache; }

  /**
   * Get cached translation for a file. Returns null if not cached.
   */
  async getCachedTranslation(path: string, targetLang: SupportedLang): Promise<TranslationEntry | null> {
    return this.cache.get(path, targetLang);
  }

  /**
   * Check if a cached translation is fully fresh (no stale blocks).
   */
  async isCacheFresh(path: string, targetLang: SupportedLang, currentContent: string): Promise<boolean> {
    const entry = await this.cache.get(path, targetLang);
    if (!entry) return false;
    return entry.sourceContentHash === hashString(currentContent);
  }

  /**
   * Translate a file's content to the target language.
   * Uses incremental block-level translation — only retranslates changed blocks.
   *
   * @returns The full translated content, or null if translation failed.
   */
  async translateFile(
    path: string,
    content: string,
    targetLang: SupportedLang,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string | null> {
    if (this.translatingPaths.has(path)) {
      logger.warn(LOG_SRC, 'Translation already in progress', { path });
      return null;
    }

    this.translatingPaths.add(path);
    try {
      return await this._doTranslate(path, content, targetLang, onProgress);
    } finally {
      this.translatingPaths.delete(path);
    }
  }

  private async _doTranslate(
    path: string,
    content: string,
    targetLang: SupportedLang,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string | null> {
    const contentHash = hashString(content);
    const blocks = splitIntoBlocks(content);
    const existing = await this.cache.get(path, targetLang);

    // Build a map of previously translated blocks by their source hash
    const prevBlockMap = new Map<string, string>();
    if (existing) {
      for (const b of existing.blocks) {
        if (!b.isStale) {
          prevBlockMap.set(b.sourceHash, b.translatedText);
        }
      }
    }

    // Identify which blocks need translation
    const translatedBlocks: TranslatedBlock[] = [];
    const toTranslate: { block: ContentBlock; hash: string }[] = [];

    for (const block of blocks) {
      const bHash = hashString(block.text);
      if (!block.translatable || block.text.trim() === '') {
        // Non-translatable block — keep as-is
        translatedBlocks.push({
          index: block.index,
          sourceHash: bHash,
          sourceText: block.text,
          translatedText: block.text,
          isStale: false,
        });
      } else if (prevBlockMap.has(bHash)) {
        // Block unchanged — reuse cached translation
        translatedBlocks.push({
          index: block.index,
          sourceHash: bHash,
          sourceText: block.text,
          translatedText: prevBlockMap.get(bHash)!,
          isStale: false,
        });
      } else {
        // New or changed block — needs translation
        toTranslate.push({ block, hash: bHash });
        translatedBlocks.push({
          index: block.index,
          sourceHash: bHash,
          sourceText: block.text,
          translatedText: '', // Will be filled
          isStale: true,
        });
      }
    }

    const totalToTranslate = toTranslate.length;
    logger.info(LOG_SRC, `Translating ${path} → ${targetLang}`, {
      totalBlocks: blocks.length,
      cachedBlocks: blocks.length - totalToTranslate,
      toTranslate: totalToTranslate,
    });

    if (totalToTranslate === 0) {
      // All blocks cached — just reassemble
      const full = assembleBlocks(translatedBlocks.map(b => ({ text: b.translatedText })));
      const entry: TranslationEntry = {
        sourcePath: path,
        sourceContentHash: contentHash,
        targetLang,
        blocks: translatedBlocks,
        fullTranslation: full,
        lastTranslated: Date.now(),
        staleBlockCount: 0,
      };
      await this.cache.put(entry);
      return full;
    }

    // Batch translate: group adjacent blocks to reduce API calls
    const batches = this.buildBatches(toTranslate);
    let done = 0;

    for (const batch of batches) {
      const batchText = batch.map(b => b.block.text).join('\n\n---BLOCK_SEP---\n\n');
      const langName = LANG_LABELS[targetLang];

      try {
        const result = await callCopilot(
          this.getCredentials,
          this.onCredentialsRefreshed,
          TRANSLATION_SYSTEM_PROMPT,
          `Translate to ${langName}:\n\n${batchText}`,
          { model: 'gpt-4o', maxTokens: 4096, temperature: 0.1, maxContentChars: 12000 },
        );

        // Split result back into blocks
        const parts = batch.length > 1
          ? result.split(/---BLOCK_SEP---/g).map(s => s.trim())
          : [result.trim()];

        for (let i = 0; i < batch.length; i++) {
          const translated = parts[i] ?? parts[parts.length - 1] ?? batch[i].block.text;
          const blockEntry = translatedBlocks.find(b => b.index === batch[i].block.index);
          if (blockEntry) {
            blockEntry.translatedText = translated;
            blockEntry.isStale = false;
          }
        }

        done += batch.length;
        onProgress?.(done, totalToTranslate);
      } catch (e) {
        logger.error(LOG_SRC, 'Block translation failed', { error: (e as Error).message });
        // Mark blocks as stale but use source text as fallback
        for (const b of batch) {
          const blockEntry = translatedBlocks.find(be => be.index === b.block.index);
          if (blockEntry) {
            blockEntry.translatedText = b.block.text; // fallback to source
            blockEntry.isStale = true;
          }
        }
        done += batch.length;
        onProgress?.(done, totalToTranslate);
      }
    }

    const staleCount = translatedBlocks.filter(b => b.isStale).length;
    const full = assembleBlocks(translatedBlocks.map(b => ({ text: b.translatedText })));

    const entry: TranslationEntry = {
      sourcePath: path,
      sourceContentHash: contentHash,
      targetLang,
      blocks: translatedBlocks,
      fullTranslation: full,
      lastTranslated: Date.now(),
      staleBlockCount: staleCount,
    };
    await this.cache.put(entry);

    logger.info(LOG_SRC, `Translation complete: ${path}`, { staleCount });
    return full;
  }

  /**
   * Group blocks into batches to reduce API calls.
   * Each batch stays under ~3000 chars to fit in a single API call.
   */
  private buildBatches(items: { block: ContentBlock; hash: string }[]): typeof items[] {
    const batches: typeof items[] = [];
    let currentBatch: typeof items = [];
    let currentLen = 0;
    const MAX_BATCH_CHARS = 3000;

    for (const item of items) {
      if (currentLen + item.block.text.length > MAX_BATCH_CHARS && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentLen = 0;
      }
      currentBatch.push(item);
      currentLen += item.block.text.length;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
  }

  /**
   * Get a diff summary: which blocks are stale in the cache.
   */
  async getStaleSummary(path: string, content: string, targetLang: SupportedLang): Promise<{
    hasCached: boolean;
    totalBlocks: number;
    staleBlocks: number;
    freshBlocks: number;
  }> {
    const blocks = splitIntoBlocks(content);
    const existing = await this.cache.get(path, targetLang);

    if (!existing) {
      const translatableCount = blocks.filter(b => b.translatable && b.text.trim() !== '').length;
      return { hasCached: false, totalBlocks: blocks.length, staleBlocks: translatableCount, freshBlocks: 0 };
    }

    const prevHashSet = new Set(existing.blocks.filter(b => !b.isStale).map(b => b.sourceHash));
    let stale = 0;
    let fresh = 0;

    for (const block of blocks) {
      if (!block.translatable || block.text.trim() === '') continue;
      const h = hashString(block.text);
      if (prevHashSet.has(h)) {
        fresh++;
      } else {
        stale++;
      }
    }

    return { hasCached: true, totalBlocks: blocks.length, staleBlocks: stale, freshBlocks: fresh };
  }

  /**
   * Handle file rename in cache.
   */
  async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
    for (const lang of Object.keys(LANG_LABELS) as SupportedLang[]) {
      const entry = await this.cache.get(oldPath, lang);
      if (entry) {
        entry.sourcePath = newPath;
        await this.cache.put(entry);
        await this.cache.delete(oldPath, lang);
      }
    }
  }

  /**
   * Handle file deletion — remove all cached translations.
   */
  async onFileDeleted(path: string): Promise<void> {
    await this.cache.deleteAllForPath(path);
  }

  /**
   * Clear cached translation for a specific file + language (force re-translation).
   */
  async clearCache(path: string, targetLang: SupportedLang): Promise<void> {
    await this.cache.delete(path, targetLang);
  }

  isTranslating(path: string): boolean {
    return this.translatingPaths.has(path);
  }
}
