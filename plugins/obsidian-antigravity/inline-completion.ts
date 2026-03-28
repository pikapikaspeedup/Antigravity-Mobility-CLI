/**
 * Inline Completion Engine for Obsidian
 *
 * Provides Copilot-like ghost text in the editor using CodeMirror 6.
 * Supports GitHub Copilot API and any OpenAI-compatible endpoint.
 *
 * Architecture:
 * - Ghost Text: CM6 ViewPlugin + Decoration.widget for transparent text overlay
 * - Provider: Abstracted completion API (Copilot / OpenAI / Ollama)
 * - Trigger: Debounced on document changes (configurable delay)
 * - Accept: Tab (full) / Right Arrow (word) / Escape (dismiss)
 */

import {
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { StateField, StateEffect, Prec } from '@codemirror/state';
import { requestUrl } from 'obsidian';
import { ensureFreshCopilotToken, type CopilotCredentials } from './copilot-auth';

// ── Types ──

export type CompletionProvider = 'copilot' | 'openai' | 'ollama' | 'custom';

export interface InlineCompletionConfig {
  enabled: boolean;
  provider: CompletionProvider;
  // Copilot credentials (managed externally)
  copilotCredentials?: CopilotCredentials;
  // OpenAI-compatible settings
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  // Behavior
  triggerDelay: number;     // ms to wait after typing (default 500)
  maxPrefixChars: number;   // chars before cursor for context (default 3000)
  maxSuffixChars: number;   // chars after cursor for context (default 1000)
  maxTokens: number;        // max tokens to generate (default 128)
  temperature: number;      // 0-1 (default 0.1)
  // Callbacks
  onCredentialsRefreshed?: (creds: CopilotCredentials) => void;
}

// ── Ghost Text Widget ──

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) { super(); }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'ag-ghost-text';
    span.textContent = this.text;
    return span;
  }

  eq(other: GhostTextWidget): boolean {
    return this.text === other.text;
  }
}

// ── State Effects ──

const setSuggestion = StateEffect.define<string | null>();

const suggestionField = StateField.define<{ text: string; pos: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) {
        if (e.value === null) return null;
        return { text: e.value, pos: tr.state.selection.main.head };
      }
    }
    // Clear on any document change or cursor movement
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

const suggestionDecoration = EditorView.decorations.compute([suggestionField], (state) => {
  const suggestion = state.field(suggestionField);
  if (!suggestion) return Decoration.none;

  const widget = Decoration.widget({
    widget: new GhostTextWidget(suggestion.text),
    side: 1,
  });
  return Decoration.set([widget.range(suggestion.pos)]);
});

// ── Completion Request ──

let activeAbort: AbortController | null = null;

async function requestCompletion(
  config: InlineCompletionConfig,
  prefix: string,
  suffix: string,
): Promise<string | null> {
  activeAbort?.abort();
  const abort = new AbortController();
  activeAbort = abort;

  try {
    if (config.provider === 'copilot' && config.copilotCredentials) {
      return await requestCopilotCompletion(config, prefix, suffix);
    }
    if (config.provider === 'copilot' && !config.copilotCredentials) {
      console.warn('[AG-Inline] Copilot selected but no credentials');
      return null;
    }
    return await requestOpenAICompletion(config, prefix, suffix);
  } catch (e: any) {
    if (e.name === 'AbortError') return null;
    console.warn('[AG-Inline] Completion failed:', e.message, e);
    return null;
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

async function requestCopilotCompletion(
  config: InlineCompletionConfig,
  prefix: string,
  suffix: string,
): Promise<string | null> {
  if (!config.copilotCredentials) return null;

  // Refresh token if needed
  const creds = await ensureFreshCopilotToken(config.copilotCredentials);
  if (creds !== config.copilotCredentials) {
    config.copilotCredentials = creds;
    config.onCredentialsRefreshed?.(creds);
  }

  const url = `${creds.apiBaseUrl}/chat/completions`;
  const body = {
    model: config.model || 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are an intelligent text completion assistant for Obsidian notes. Your job is to predict the most logical text that should be written at the cursor position marked with <CURSOR/>. Your answer must seamlessly continue from the text before the cursor. Only output the completion text, nothing else. Do not repeat the prefix. Do not add explanations. Keep your answer concise (1-3 sentences max). Match the language and style of the surrounding text.`,
      },
      {
        role: 'user',
        content: `${prefix}<CURSOR/>${suffix}`,
      },
    ],
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
  };

  console.debug('[AG-Inline] Copilot request:', url, { model: body.model, prefixLen: prefix.length });

  // Use fetch instead of requestUrl to capture error response body
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.copilotToken}`,
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.96.2',
      'User-Agent': 'GitHubCopilotChat/0.22.2',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[AG-Inline] Copilot API error:', res.status, errText);
    return null;
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || null;
}

async function requestOpenAICompletion(
  config: InlineCompletionConfig,
  prefix: string,
  suffix: string,
): Promise<string | null> {
  const baseUrl = config.apiBaseUrl || 'https://api.openai.com/v1';
  const model = config.model || 'gpt-4o-mini';
  const apiKey = config.apiKey;
  if (!apiKey) return null;

  const res = await requestUrl({
    url: `${baseUrl}/chat/completions`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `You are an intelligent text completion assistant for Obsidian notes. Your job is to predict the most logical text that should be written at the cursor position marked with <CURSOR/>. Your answer must seamlessly continue from the text before the cursor. Only output the completion text, nothing else. Do not repeat the prefix. Do not add explanations. Keep your answer concise (1-3 sentences max). Match the language and style of the surrounding text.`,
        },
        {
          role: 'user',
          content: `${prefix}<CURSOR/>${suffix}`,
        },
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      stream: false,
    }),
  });

  const json = res.json;
  return json.choices?.[0]?.message?.content?.trim() || null;
}

// ── Keymap: Tab/RightArrow/Escape ──

function acceptFullSuggestion(view: EditorView): boolean {
  const suggestion = view.state.field(suggestionField);
  if (!suggestion) return false;

  view.dispatch({
    changes: { from: suggestion.pos, insert: suggestion.text },
    selection: { anchor: suggestion.pos + suggestion.text.length },
    effects: setSuggestion.of(null),
  });
  return true;
}

function acceptWordSuggestion(view: EditorView): boolean {
  const suggestion = view.state.field(suggestionField);
  if (!suggestion) return false;

  // Extract first word (up to next space or end)
  const match = suggestion.text.match(/^\S+\s?/);
  if (!match) return false;

  const word = match[0];
  const remaining = suggestion.text.slice(word.length);

  view.dispatch({
    changes: { from: suggestion.pos, insert: word },
    effects: setSuggestion.of(remaining || null),
    selection: { anchor: suggestion.pos + word.length },
  });
  return true;
}

function dismissSuggestion(view: EditorView): boolean {
  const suggestion = view.state.field(suggestionField);
  if (!suggestion) return false;

  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

const inlineCompletionKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptFullSuggestion },
    { key: 'ArrowRight', run: acceptWordSuggestion },
    { key: 'Escape', run: dismissSuggestion },
  ]),
);

// ── ViewPlugin: trigger completions on typing ──

function createInlineCompletionPlugin(getConfig: () => InlineCompletionConfig) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return ViewPlugin.fromClass(
    class {
      constructor(private view: EditorView) {}

      update(update: ViewUpdate) {
        const config = getConfig();
        if (!config.enabled) {
          return;
        }

        // Only trigger on document changes (user typing)
        if (!update.docChanged) return;

        // Clear previous debounce
        if (debounceTimer) clearTimeout(debounceTimer);

        console.debug('[AG-Inline] Doc changed, scheduling completion in', config.triggerDelay, 'ms');

        debounceTimer = setTimeout(() => {
          this.triggerCompletion(config);
        }, config.triggerDelay);
      }

      async triggerCompletion(config: InlineCompletionConfig) {
        const state = this.view.state;
        const pos = state.selection.main.head;
        const doc = state.doc.toString();

        const prefix = doc.slice(Math.max(0, pos - config.maxPrefixChars), pos);
        const suffix = doc.slice(pos, Math.min(doc.length, pos + config.maxSuffixChars));

        // Skip if prefix is too short or cursor at very start
        if (prefix.trim().length < 3) {
          console.debug('[AG-Inline] Skipped: prefix too short');
          return;
        }

        console.debug('[AG-Inline] Requesting completion...', {
          provider: config.provider,
          prefixLen: prefix.length,
          suffixLen: suffix.length,
          hasCreds: !!config.copilotCredentials,
        });

        const result = await requestCompletion(config, prefix, suffix);
        console.debug('[AG-Inline] Completion result:', result ? `"${result.slice(0, 80)}..."` : 'null');

        if (!result) return;

        // Only apply if cursor hasn't moved since we started
        if (this.view.state.selection.main.head === pos) {
          console.debug('[AG-Inline] Applying suggestion at pos', pos);
          this.view.dispatch({ effects: setSuggestion.of(result) });
        } else {
          console.debug('[AG-Inline] Cursor moved, discarding suggestion');
        }
      }

      destroy() {
        if (debounceTimer) clearTimeout(debounceTimer);
      }
    },
  );
}

// ── Public API ──

/**
 * Create CodeMirror extensions for inline completion.
 * Returns an array of extensions to register with `registerEditorExtension`.
 */
export function createInlineCompletionExtensions(
  getConfig: () => InlineCompletionConfig,
) {
  return [
    suggestionField,
    suggestionDecoration,
    createInlineCompletionPlugin(getConfig),
    inlineCompletionKeymap,
  ];
}
