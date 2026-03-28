/**
 * Copilot Knowledge Provider
 *
 * Implements KnowledgeProvider interface using GitHub Copilot API
 * for AI-enhanced entity extraction, topic analysis, and keyword detection.
 *
 * Uses the cheapest available model (gpt-4o) with structured JSON output
 * to minimize quota consumption.
 */

import { requestUrl } from 'obsidian';
import type { KnowledgeProvider } from './knowledge-engine';
import type { CopilotCredentials } from './copilot-auth';
import { ensureFreshCopilotToken } from './copilot-auth';
import { callCopilot as sharedCallCopilot, parseJSON } from './copilot-api';

// ── Constants ──

const MAX_CONTENT_CHARS = 3000;

// ── Prompt Templates ──

const EXTRACT_PROMPT = `You are a knowledge analysis assistant. Analyze the note content and extract structured information.

Return a JSON object with these fields:
- "entities": array of named entities, concepts, proper nouns, and significant references (max 20)
- "topics": array of high-level topics or themes (max 10)
- "keywords": array of content-specific keywords not captured by entities/topics (max 15)
- "summary": one-sentence summary (max 80 chars)

Rules:
- Be precise: only include clearly identifiable items
- Prefer specificity over generality
- Entities should be things that could be linked to other notes
- Topics should be broad enough to connect across notes
- Keywords are domain-specific terms
- Return valid JSON only, no markdown fences`;

// ── Provider Implementation ──

export class CopilotKnowledgeProvider implements KnowledgeProvider {
  private getCredentials: () => CopilotCredentials | null;
  private onCredentialsRefreshed: (creds: CopilotCredentials) => void;

  constructor(
    getCredentials: () => CopilotCredentials | null,
    onCredentialsRefreshed: (creds: CopilotCredentials) => void,
  ) {
    this.getCredentials = getCredentials;
    this.onCredentialsRefreshed = onCredentialsRefreshed;
  }

  private async callCopilot(systemPrompt: string, userContent: string): Promise<string> {
    return sharedCallCopilot(
      this.getCredentials,
      this.onCredentialsRefreshed,
      systemPrompt,
      userContent,
    );
  }

  async extractEntities(content: string): Promise<string[]> {
    try {
      const raw = await this.callCopilot(EXTRACT_PROMPT, content);
      const data = parseJSON(raw);
      return Array.isArray(data.entities)
        ? data.entities.filter((e: any) => typeof e === 'string' && e.length >= 2).slice(0, 20)
        : [];
    } catch (e) {
      console.warn('[Knowledge/Copilot] Entity extraction failed:', e);
      return [];
    }
  }

  async extractTopics(content: string): Promise<string[]> {
    try {
      const raw = await this.callCopilot(EXTRACT_PROMPT, content);
      const data = parseJSON(raw);
      return Array.isArray(data.topics)
        ? data.topics.filter((t: any) => typeof t === 'string' && t.length >= 2).slice(0, 10)
        : [];
    } catch (e) {
      console.warn('[Knowledge/Copilot] Topic extraction failed:', e);
      return [];
    }
  }

  async extractKeywords(content: string): Promise<string[]> {
    try {
      const raw = await this.callCopilot(EXTRACT_PROMPT, content);
      const data = parseJSON(raw);
      return Array.isArray(data.keywords)
        ? data.keywords.filter((k: any) => typeof k === 'string' && k.length >= 2).slice(0, 15)
        : [];
    } catch (e) {
      console.warn('[Knowledge/Copilot] Keyword extraction failed:', e);
      return [];
    }
  }

  async generateSummary(content: string): Promise<string> {
    try {
      const raw = await this.callCopilot(EXTRACT_PROMPT, content);
      const data = parseJSON(raw);
      return typeof data.summary === 'string' ? data.summary.slice(0, 200) : '';
    } catch (e) {
      console.warn('[Knowledge/Copilot] Summary generation failed:', e);
      return '';
    }
  }

  /**
   * Batch extraction: single API call returns all fields.
   * More efficient than calling each method individually.
   */
  async extractAll(content: string): Promise<{
    entities: string[];
    topics: string[];
    keywords: string[];
    summary: string;
  }> {
    try {
      const raw = await this.callCopilot(EXTRACT_PROMPT, content);
      const data = parseJSON(raw);
      return {
        entities: Array.isArray(data.entities)
          ? data.entities.filter((e: any) => typeof e === 'string' && e.length >= 2).slice(0, 20) : [],
        topics: Array.isArray(data.topics)
          ? data.topics.filter((t: any) => typeof t === 'string' && t.length >= 2).slice(0, 10) : [],
        keywords: Array.isArray(data.keywords)
          ? data.keywords.filter((k: any) => typeof k === 'string' && k.length >= 2).slice(0, 15) : [],
        summary: typeof data.summary === 'string' ? data.summary.slice(0, 200) : '',
      };
    } catch (e) {
      console.warn('[Knowledge/Copilot] Batch extraction failed:', e);
      return { entities: [], topics: [], keywords: [], summary: '' };
    }
  }

  /**
   * Get embedding vector for content using the Copilot embeddings API.
   * Falls back gracefully if the endpoint is not supported.
   */
  async getEmbedding(content: string): Promise<number[]> {
    const creds = this.getCredentials();
    if (!creds) throw new Error('Copilot not authenticated');

    const freshCreds = await ensureFreshCopilotToken(creds);
    if (freshCreds !== creds) this.onCredentialsRefreshed(freshCreds);

    const truncated = content.length > MAX_CONTENT_CHARS
      ? content.slice(0, MAX_CONTENT_CHARS)
      : content;

    try {
      const res = await requestUrl({
        url: `${freshCreds.apiBaseUrl}/embeddings`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${freshCreds.copilotToken}`,
          'Content-Type': 'application/json',
          'Editor-Version': 'vscode/1.96.2',
          'User-Agent': 'GitHubCopilotChat/0.22.2',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: truncated,
        }),
      });

      const embedding = res.json?.data?.[0]?.embedding;
      if (Array.isArray(embedding) && embedding.length > 0) {
        return embedding;
      }
      return [];
    } catch (e) {
      // Embeddings endpoint may not be supported — fail silently
      console.warn('[Knowledge/Copilot] Embedding failed (endpoint may not be supported):', e);
      return [];
    }
  }
}
