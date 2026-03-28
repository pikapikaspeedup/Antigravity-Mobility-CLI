/**
 * Shared Copilot API utilities — callCopilot, parseJSON, throttle.
 *
 * Used by both CopilotKnowledgeProvider and atom-operations to avoid
 * duplicated HTTP / throttle logic.
 */

import { requestUrl } from 'obsidian';
import type { CopilotCredentials } from './copilot-auth';
import { ensureFreshCopilotToken } from './copilot-auth';

// ── Rate Control ──

const MIN_INTERVAL_MS = 800;
let lastCallTime = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastCallTime = Date.now();
}

// ── Core API Call ──

export interface CopilotCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  maxContentChars?: number;
}

const DEFAULTS: Required<CopilotCallOptions> = {
  model: 'gpt-4o',
  maxTokens: 512,
  temperature: 0.1,
  maxContentChars: 3000,
};

/**
 * Send a chat completion request to the Copilot API.
 * Handles token refresh, throttling, and content truncation.
 */
export async function callCopilot(
  getCredentials: () => CopilotCredentials | null,
  onRefreshed: (c: CopilotCredentials) => void,
  systemPrompt: string,
  userContent: string,
  opts?: CopilotCallOptions,
): Promise<string> {
  const creds = getCredentials();
  if (!creds) throw new Error('Copilot not authenticated');

  const freshCreds = await ensureFreshCopilotToken(creds);
  if (freshCreds !== creds) onRefreshed(freshCreds);

  await throttle();

  const { model, maxTokens, temperature, maxContentChars } = { ...DEFAULTS, ...opts };
  const truncated = userContent.length > maxContentChars
    ? userContent.slice(0, maxContentChars) + '\n\n[...truncated]'
    : userContent;

  const res = await requestUrl({
    url: `${freshCreds.apiBaseUrl}/chat/completions`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${freshCreds.copilotToken}`,
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.96.2',
      'User-Agent': 'GitHubCopilotChat/0.22.2',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: truncated },
      ],
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  });

  const content = res.json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty Copilot response');
  return content;
}

/**
 * Parse a JSON string from AI output, stripping markdown fences if present.
 */
export function parseJSON(raw: string): any {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  return JSON.parse(cleaned);
}
