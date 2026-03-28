/**
 * GitHub Copilot OAuth Authentication
 *
 * Implements Device Flow OAuth to authenticate with GitHub,
 * then exchanges the token for a Copilot API token.
 *
 * Flow:
 * 1. Request device code from GitHub
 * 2. User authorizes in browser
 * 3. Poll for access token
 * 4. Exchange GitHub token for Copilot API token
 * 5. Cache and refresh tokens automatically
 */

import { requestUrl, Notice } from 'obsidian';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';

export interface CopilotCredentials {
  githubToken: string;
  copilotToken: string;
  copilotExpiresAt: number; // ms since epoch
  apiBaseUrl: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// ── Device Flow OAuth ──

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'read:user',
  });

  const res = await requestUrl({
    url: DEVICE_CODE_URL,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const json = res.json;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('GitHub device code response missing fields');
  }
  return json as DeviceCodeResponse;
}

async function pollForAccessToken(
  deviceCode: string,
  intervalMs: number,
  expiresAt: number,
  signal?: { cancelled: boolean },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  while (Date.now() < expiresAt) {
    if (signal?.cancelled) throw new Error('Login cancelled');
    await sleep(intervalMs);

    const res = await requestUrl({
      url: ACCESS_TOKEN_URL,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const json = res.json;
    if (json.access_token) return json.access_token;
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      intervalMs = Math.max(intervalMs, (json.interval || 10) * 1000);
      continue;
    }
    if (json.error === 'expired_token') throw new Error('Device code expired');
    if (json.error === 'access_denied') throw new Error('Access denied by user');
    if (json.error) throw new Error(`GitHub OAuth error: ${json.error}`);
  }
  throw new Error('Device code expired');
}

// ── Copilot Token Exchange ──

function deriveCopilotApiBaseUrl(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) return DEFAULT_COPILOT_API_BASE_URL;
  const host = proxyEp.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.');
  return host ? `https://${host}` : DEFAULT_COPILOT_API_BASE_URL;
}

async function exchangeForCopilotToken(githubToken: string): Promise<{
  token: string;
  expiresAt: number;
  baseUrl: string;
}> {
  const res = await requestUrl({
    url: COPILOT_TOKEN_URL,
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
    },
  });

  const json = res.json;
  if (!json.token) throw new Error('Copilot token response missing token');

  let expiresAt: number;
  if (typeof json.expires_at === 'number') {
    expiresAt = json.expires_at > 1e10 ? json.expires_at : json.expires_at * 1000;
  } else if (typeof json.expires_at === 'string') {
    const parsed = parseInt(json.expires_at, 10);
    expiresAt = parsed > 1e10 ? parsed : parsed * 1000;
  } else {
    expiresAt = Date.now() + 30 * 60 * 1000; // fallback 30min
  }

  return {
    token: json.token,
    expiresAt,
    baseUrl: deriveCopilotApiBaseUrl(json.token),
  };
}

// ── Public API ──

/**
 * Start the GitHub Device Flow login.
 * Returns a promise that resolves with credentials once the user authorizes.
 */
export async function loginWithGitHubCopilot(
  onDeviceCode: (userCode: string, verificationUri: string) => void,
  signal?: { cancelled: boolean },
): Promise<CopilotCredentials> {
  const device = await requestDeviceCode();
  onDeviceCode(device.user_code, device.verification_uri);

  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = Math.max(1000, device.interval * 1000);

  const githubToken = await pollForAccessToken(device.device_code, intervalMs, expiresAt, signal);
  const copilot = await exchangeForCopilotToken(githubToken);

  return {
    githubToken,
    copilotToken: copilot.token,
    copilotExpiresAt: copilot.expiresAt,
    apiBaseUrl: copilot.baseUrl,
  };
}

/**
 * Refresh the Copilot API token if expired.
 * Returns updated credentials or the same ones if still valid.
 */
export async function ensureFreshCopilotToken(
  creds: CopilotCredentials,
): Promise<CopilotCredentials> {
  // 5 minute safety margin
  if (creds.copilotExpiresAt - Date.now() > 5 * 60 * 1000) {
    return creds;
  }
  const copilot = await exchangeForCopilotToken(creds.githubToken);
  return {
    ...creds,
    copilotToken: copilot.token,
    copilotExpiresAt: copilot.expiresAt,
    apiBaseUrl: copilot.baseUrl,
  };
}

/**
 * Check Copilot quota usage.
 */
export async function fetchCopilotUsage(
  githubToken: string,
): Promise<{ premiumRemaining: number; chatRemaining: number; plan: string } | null> {
  try {
    const res = await requestUrl({
      url: 'https://api.github.com/copilot_internal/user',
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${githubToken}`,
      },
    });
    const json = res.json;
    return {
      premiumRemaining: json.quota_snapshots?.premium_interactions?.percent_remaining ?? -1,
      chatRemaining: json.quota_snapshots?.chat?.percent_remaining ?? -1,
      plan: json.copilot_plan ?? 'unknown',
    };
  } catch {
    return null;
  }
}

// ── Model Catalog ──

export interface CopilotModel {
  id: string;
  name: string;
  multiplier: number;   // 0 = included free on paid plans
  freeMultiplier: number; // multiplier on Free plan (0 = not available, 1 = counts as 1)
  category: 'included' | 'premium' | 'ultra';
}

/** Static model catalog from GitHub docs (updated 2026-03) */
export const COPILOT_MODELS: CopilotModel[] = [
  // ── Included (0x on paid plans) ──
  { id: 'gpt-4o', name: 'GPT-4o', multiplier: 0, freeMultiplier: 1, category: 'included' },
  { id: 'gpt-4.1', name: 'GPT-4.1', multiplier: 0, freeMultiplier: 1, category: 'included' },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', multiplier: 0, freeMultiplier: 1, category: 'included' },
  { id: 'raptor-mini', name: 'Raptor mini', multiplier: 0, freeMultiplier: 1, category: 'included' },
  // ── Low cost (0.25x–0.33x) ──
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', multiplier: 0.33, freeMultiplier: 1, category: 'premium' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', multiplier: 0.33, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1-Codex-Mini', multiplier: 0.33, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', multiplier: 0.33, freeMultiplier: 0, category: 'premium' },
  { id: 'grok-code-fast-1', name: 'Grok Code Fast 1', multiplier: 0.25, freeMultiplier: 1, category: 'premium' },
  // ── Standard (1x) ──
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.1', name: 'GPT-5.1', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1-Codex', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1-Codex-Max', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.2', name: 'GPT-5.2', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2-Codex', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  { id: 'gpt-5.4', name: 'GPT-5.4', multiplier: 1, freeMultiplier: 0, category: 'premium' },
  // ── Ultra (3x+) ──
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', multiplier: 3, freeMultiplier: 0, category: 'ultra' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', multiplier: 3, freeMultiplier: 0, category: 'ultra' },
  { id: 'claude-opus-4.6-fast', name: 'Claude Opus 4.6 (fast)', multiplier: 30, freeMultiplier: 0, category: 'ultra' },
];

/**
 * Try to fetch models from the Copilot API, fall back to static catalog.
 */
export async function fetchCopilotModels(
  copilotToken: string,
  apiBaseUrl: string,
): Promise<CopilotModel[]> {
  try {
    const res = await requestUrl({
      url: `${apiBaseUrl}/models`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
      },
    });
    const json = res.json;
    if (json.data && Array.isArray(json.data)) {
      // Merge API models with our static multiplier data
      const staticMap = new Map(COPILOT_MODELS.map(m => [m.id, m]));
      const merged: CopilotModel[] = [];
      for (const apiModel of json.data) {
        const id = apiModel.id || apiModel.name;
        const existing = staticMap.get(id);
        merged.push(existing ?? {
          id,
          name: apiModel.name || id,
          multiplier: -1, // unknown
          freeMultiplier: 0,
          category: 'premium' as const,
        });
      }
      return merged.length > 0 ? merged : COPILOT_MODELS;
    }
  } catch {
    // API may not support /models — use static catalog
  }
  return COPILOT_MODELS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
