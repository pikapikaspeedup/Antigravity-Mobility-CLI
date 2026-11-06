#!/usr/bin/env node
/**
 * Antigravity ACP Agent — bridges cc-connect to the Antigravity Gateway.
 *
 * Commands intercepted inside session/prompt:
 *   /models           → list available models + quota
 *   /model <name>     → switch model for subsequent messages
 *   /status           → show current session info + model quota
 *   /workspace        → switch workspace (rebind conversation)
 *   /help             → show command list
 *
 * Session lifecycle:
 *   /new  (cc-connect built-in) → session/new → unbound session → workspace selection
 *   All messages stay in the SAME conversation until /new
 *   Non-streaming: full response sent after agent turn completes
 */

import { createInterface } from 'readline';
import WebSocket from 'ws';

const BASE = process.env.AG_BASE_URL || 'http://127.0.0.1:3100';

const DEFAULT_MODEL = 'MODEL_PLACEHOLDER_M417'; // Gemini 4 Argon (High)

// ─── Session ─────────────────────────────────────────────────────────────

interface Session {
  cascadeId?: string;
  workspace?: string;
  model: string;
  ws?: WebSocket;
  cancelled: boolean;
}

const sessions = new Map<string, Session>();
let counter = 0;

// Workspace cache — 2.0 hub projects + any legacy servers with a workspace
let runningWorkspaces: { workspace: string; port: number; projectId?: string; name?: string }[] = [];
let cachedConvs: any[] = [];

// Model cache
interface ModelInfo {
  label: string;
  model: string;
  remaining: number;
  resetTime: string;
  recommended: boolean;
}
let models: ModelInfo[] = [];

// ─── JSON-RPC ────────────────────────────────────────────────────────────

function write(msg: object) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function ok(id: number | string, data: any) { write({ jsonrpc: '2.0', id, result: data }); }
function err(id: number | string, code: number, msg: string) { write({ jsonrpc: '2.0', id, error: { code, message: msg } }); }
function notify(method: string, params: any) { write({ jsonrpc: '2.0', method, params }); }
function reply(sid: string, text: string) {
  notify('session/update', {
    sessionId: sid,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

// ─── HTTP ────────────────────────────────────────────────────────────────

async function get(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function post(path: string, body?: any): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try {
    const j = JSON.parse(t);
    if (!r.ok && j.error) throw new Error(j.message || j.error);
    return j;
  } catch {
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    return t;
  }
}

// ─── Data fetchers ───────────────────────────────────────────────────────

async function refreshWorkspaces() {
  try {
    const convs: any[] = await get('/api/conversations');
    if (Array.isArray(convs)) {
      cachedConvs = convs.slice(0, 15);
    }
  } catch {}

  try {
    const hubProjects: any[] = await get('/api/hub-projects');
    if (Array.isArray(hubProjects) && hubProjects.length > 0) {
      runningWorkspaces = hubProjects
        .filter((p: any) => p.folders && p.folders.length > 0)
        .map((p: any) => ({
          workspace: p.folders[0].uri || `file://${p.folders[0].path}`,
          port: 0,
          projectId: p.id,
          name: p.name,
        }));
      return;
    }
  } catch {}
  const servers: any[] = await get('/api/servers');
  runningWorkspaces = servers
    .filter((s: any) => s.workspace)
    .map((s: any) => ({ workspace: s.workspace, port: s.port }));
}

async function refreshModels() {
  const d = await get('/api/models');
  models = (d.clientModelConfigs || []).map((c: any) => ({
    label: c.label || '',
    model: c.modelOrAlias?.model || '',
    remaining: c.quotaInfo?.remainingFraction ?? -1,
    resetTime: c.quotaInfo?.resetTime || '',
    recommended: !!c.isRecommended,
  }));
  // Stable sort: recommended first, then alphabetical by label
  models.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

// ─── Workspace helpers ───────────────────────────────────────────────────

function matchWorkspace(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const uri = cwd.startsWith('file://') ? cwd : `file://${cwd}`;
  return runningWorkspaces.find(w => w.workspace === uri)?.workspace
    || runningWorkspaces.find(w => uri.startsWith(w.workspace) || w.workspace.startsWith(uri))?.workspace;
}

function fmtWorkspaceList(currentCascadeId?: string): string {
  const lines: string[] = [];
  const projCount = runningWorkspaces.length + 1;
  lines.push(`📂 Projects（发 ws 1~${projCount} 新建会话）：`);
  for (let i = 0; i < runningWorkspaces.length; i++) {
    const p = runningWorkspaces[i].workspace.replace('file://', '');
    lines.push(`  ${i + 1}. ${runningWorkspaces[i].name || p.split('/').pop() || p}\n     ${p}`);
  }
  lines.push(`  ${projCount}. [Playground] (新建空白对话)`);

  if (cachedConvs.length > 0) {
    const startIdx = projCount + 1;
    const endIdx = projCount + cachedConvs.length;
    lines.push(`\n💬 Conversations（电脑端已打开的会话，发 ws ${startIdx}~${endIdx} 直接进入）：`);
    for (let i = 0; i < cachedConvs.length; i++) {
      const c = cachedConvs[i];
      const proj = c.projectName ? ` [${c.projectName}]` : '';
      const active = c.id === currentCascadeId ? '👉 ' : '  ';
      lines.push(`${active}${startIdx + i}. ${c.title}${proj} (${c.steps || 0}步)`);
    }
  }
  return lines.join('\n');
}

async function createConv(workspace: string): Promise<string> {
  if (workspace === 'playground') {
    const d = await post('/api/conversations', {});
    if (!d.cascadeId) throw new Error(d.message || d.error || '创建对话失败');
    return d.cascadeId;
  }
  const matched = runningWorkspaces.find(w => w.workspace === workspace);
  const body = matched?.projectId ? { projectId: matched.projectId } : { workspace };
  const d = await post('/api/conversations', body);
  if (!d.cascadeId) throw new Error(d.message || d.error || '创建对话失败');
  return d.cascadeId;
}

// ─── WebSocket: stream steps & wait for completion ───────────────────────

function formatToolCall(toolName: string, argumentsJson?: string): string {
  if (!argumentsJson) return toolName;
  try {
    const args = JSON.parse(argumentsJson);
    if (args.toolSummary) return `${toolName} (${args.toolSummary})`;
    if (args.Path) {
      const shortPath = String(args.Path).split('/').slice(-2).join('/');
      return `${toolName} (${shortPath})`;
    }
    if (args.CommandLine) {
      const cmd = String(args.CommandLine).replace(/\s+/g, ' ').slice(0, 50);
      return `${toolName} (${cmd}${ String(args.CommandLine).length > 50 ? '…' : '' })`;
    }
    if (args.query || args.Query) return `${toolName} (${args.query || args.Query})`;
    if (args.Role) return `${toolName} (${args.Role})`;
  } catch {}
  return toolName;
}

/**
 * Subscribe to cascadeId via WebSocket, then call onReady() which triggers
 * POST /send. Streams tool calls and model responses incrementally via reply()
 * as they happen, and resolves when the agent turn finishes.
 */
function waitDone(
  sid: string,
  session: Session,
  onReady: () => Promise<void>,
): Promise<{ emitted: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    session.ws = ws;

    let done = false;
    let readySent = false;
    let wasRunning = false;
    let sawNewAgentStep = false;
    let startStepIndex = 0;
    let hasEmitted = false;
    let errorMsg: string | undefined;

    const streamedLengths = new Map<number, number>();
    const announcedTools = new Set<string>();

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(readyTimer);
      session.ws = undefined;
      try { ws.close(); } catch {}
      resolve({ emitted: hasEmitted, error: errorMsg });
    }

    async function triggerReady() {
      if (readySent || done) return;
      readySent = true;
      clearTimeout(readyTimer);
      try {
        await onReady();
      } catch (e: any) {
        errorMsg = e.message || '发送消息失败';
        finish();
      }
    }

    const timer = setTimeout(() => {
      if (!hasEmitted && !errorMsg) {
        errorMsg = '任务等待超时（15分钟），请检查电脑端 Antigravity 状态';
      }
      finish();
    }, 15 * 60 * 1000);

    let readyTimer: ReturnType<typeof setTimeout>;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', cascadeId: session.cascadeId }));
      // Fallback: if no initial WS snapshot arrives within 2s, trigger onReady anyway
      readyTimer = setTimeout(() => { triggerReady(); }, 2000);
    });

    ws.on('message', async (raw: Buffer) => {
      if (done || session.cancelled) { finish(); return; }
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error' && (!m.cascadeId || m.cascadeId === session.cascadeId)) {
          errorMsg = m.message || '对话连接异常';
          finish();
          return;
        }
        if (m.cascadeId !== session.cascadeId) return;

        // First message is the initial snapshot before our prompt is sent
        if (!readySent) {
          startStepIndex = m.data?.steps?.length ?? m.stepCount ?? 0;
          await triggerReady();
          return;
        }

        if (m.type === 'steps' && Array.isArray(m.data?.steps)) {
          const steps: any[] = m.data.steps;
          for (let idx = startStepIndex; idx < steps.length; idx++) {
            const s = steps[idx];
            if (!s?.type) continue;
            const t = s.type.replace('CORTEX_STEP_TYPE_', '');

            if (t === 'PLANNER_RESPONSE') {
              let txt = s.plannerResponse?.modifiedResponse || s.plannerResponse?.response || '';
              txt = txt.replace(/\[([^\]]+)\]\(cci:[^)]+\)/g, '$1');
              const prevLen = streamedLengths.get(idx) || 0;
              if (txt.length > prevLen) {
                const prefix = prevLen === 0 && hasEmitted ? '\n\n' : '';
                const delta = prefix + txt.slice(prevLen);
                streamedLengths.set(idx, txt.length);
                hasEmitted = true;
                reply(sid, delta);
              }
            } else if (t === 'TASK_BOUNDARY') {
              const tb = s.taskBoundary;
              const tbKey = `tb_${idx}`;
              if (tb?.taskName && !announcedTools.has(tbKey)) {
                announcedTools.add(tbKey);
                const prefix = hasEmitted ? '\n' : '';
                hasEmitted = true;
                reply(sid, `${prefix}📋 ${(tb.mode || '').replace('MODE_', '')}: ${tb.taskName}\n`);
              }
            } else if (t === 'ERROR_MESSAGE') {
              const errKey = `err_${idx}`;
              if (!announcedTools.has(errKey)) {
                announcedTools.add(errKey);
                const shortErr = s.errorMessage?.error?.shortError || s.errorMessage?.message || '步骤执行异常';
                const prefix = hasEmitted ? '\n' : '';
                hasEmitted = true;
                reply(sid, `${prefix}⚠️ ${shortErr}\n`);
              }
            } else if (t !== 'USER_INPUT' && t !== 'CHECKPOINT' && t !== 'SYSTEM_MESSAGE') {
              const tc = s.metadata?.toolCall;
              const toolName = tc?.name || s.action?.toolName || s.toolResult?.toolName || s.title || '';
              if (toolName) {
                const tcKey = tc?.id || `step_${idx}`;
                if (!announcedTools.has(tcKey)) {
                  announcedTools.add(tcKey);
                  const label = formatToolCall(toolName, tc?.argumentsJson);
                  const prefix = hasEmitted ? '\n' : '';
                  hasEmitted = true;
                  reply(sid, `${prefix}🔧 ${label}\n`);
                }
              }
            }
          }

          if (m.isActive) wasRunning = true;
          if (steps.length > startStepIndex + 1) sawNewAgentStep = true;

          if ((wasRunning || sawNewAgentStep) && (!m.isActive || m.cascadeStatus === 'idle')) {
            finish();
          }
        } else if (m.type === 'status') {
          if (m.isActive) wasRunning = true;
          if ((m.stepCount ?? 0) > startStepIndex + 1) sawNewAgentStep = true;

          if ((wasRunning || sawNewAgentStep) && (!m.isActive || m.cascadeStatus === 'idle')) {
            finish();
          }
        }
      } catch {}
    });

    ws.on('error', (e: any) => {
      errorMsg = `WebSocket 连接错误: ${e.message || '未知错误'}`;
      finish();
    });
    ws.on('close', () => { finish(); });
  });
}

// ─── Slash command handlers ──────────────────────────────────────────────

async function cmdModels(sid: string): Promise<string> {
  await refreshModels();
  if (models.length === 0) return '⚠️ 无可用模型';
  const lines = models.map((m, i) => {
    const pct = m.remaining >= 0 ? `${Math.round(m.remaining * 100)}%` : '?';
    const star = m.recommended ? '⭐' : '  ';
    return `${star} ${i + 1}. ${m.label}\n     余量: ${pct}`;
  });
  return `📋 可用模型：\n\n${lines.join('\n')}`;
}

async function cmdModel(sid: string, session: Session, arg: string): Promise<string> {
  // Don't re-fetch models — use cached list from last /models call
  // to preserve the same ordering the user saw
  if (models.length === 0) await refreshModels();

  if (!arg) {
    const cur = session.model
      ? models.find(m => m.model === session.model)?.label || session.model
      : '默认';
    return `当前模型: ${cur}\n\n用法: /model <名称或编号>\n例如: /model 1 或 /model gemini`;
  }

  // Try match by number
  const num = parseInt(arg, 10);
  if (num >= 1 && num <= models.length) {
    session.model = models[num - 1].model;
    return `✅ 已切换模型: ${models[num - 1].label}`;
  }

  // Try match by name (case-insensitive partial match)
  const q = arg.toLowerCase();
  const match = models.find(m =>
    m.label.toLowerCase().includes(q) || m.model.toLowerCase().includes(q)
  );
  if (match) {
    session.model = match.model;
    return `✅ 已切换模型: ${match.label}`;
  }

  return `❌ 未找到模型 "${arg}"。发 /models 查看列表。`;
}

async function cmdStatus(sid: string, session: Session): Promise<string> {
  await refreshModels();
  const lines: string[] = ['📊 系统状态\n'];

  // Current workspace
  const wsName = session.workspace
    ? session.workspace.replace('file://', '').split('/').pop()
    : '(未绑定)';
  lines.push(`工作区: ${wsName}`);

  // Current model
  const curModel = session.model
    ? models.find(m => m.model === session.model)?.label || session.model
    : '默认';
  lines.push(`模型: ${curModel}`);

  // Conversation
  lines.push(`对话 ID: ${session.cascadeId?.slice(0, 8) || '(无)'}`);

  // Model quotas
  lines.push('\n📈 模型余量:');
  for (const m of models) {
    const pct = m.remaining >= 0 ? `${Math.round(m.remaining * 100)}%` : '?';
    const bar = m.remaining >= 0 ? progressBar(m.remaining) : '???';
    lines.push(`  ${m.label}: ${bar} ${pct}`);
  }

  return lines.join('\n');
}

function progressBar(frac: number): string {
  const len = 10;
  const filled = Math.round(frac * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

async function cmdWorkspace(sid: string, session: Session, arg: string): Promise<string> {
  // Always fetch live data when listing (!arg), or if cache is empty when selecting by number
  // so the numbering doesn't shift between viewing `ws` and sending `ws <num>`.
  if (!arg || (runningWorkspaces.length === 0 && cachedConvs.length === 0)) {
    await refreshWorkspaces();
  }
  const projTotal = runningWorkspaces.length + 1; // +1 for playground
  const allTotal = projTotal + cachedConvs.length;

  if (!arg) {
    if (runningWorkspaces.length === 0 && cachedConvs.length === 0) {
      return '⚠️ 没有运行中的工作区或历史会话。请先在 Antigravity 中打开项目。';
    }
    const cur = session.workspace
      ? session.workspace.replace('file://', '').split('/').pop()
      : '(未绑定)';
    const curConv = session.cascadeId ? ` (对话: ${session.cascadeId.slice(0, 8)})` : '';
    return `当前状态: ${cur}${curConv}\n\n${fmtWorkspaceList(session.cascadeId)}`;
  }

  const num = parseInt(arg, 10);
  if (num >= 1 && num <= projTotal) {
    const ws = num <= runningWorkspaces.length ? runningWorkspaces[num - 1].workspace : 'playground';
    try {
      const cascadeId = await createConv(ws);
      session.cascadeId = cascadeId;
      session.workspace = ws;
      const name = ws === 'playground' ? 'Playground' : ws.replace('file://', '').split('/').pop();
      return `✅ 已切换工作区: ${name}\n新对话已创建 (${cascadeId.slice(0, 8)})。`;
    } catch (e: any) {
      return `❌ 切换失败: ${e.message}`;
    }
  } else if (num > projTotal && num <= allTotal) {
    const target = cachedConvs[num - projTotal - 1];
    session.cascadeId = target.id;
    session.workspace = target.title || target.projectName || 'Conversation';
    const proj = target.projectName ? ` [${target.projectName}]` : '';
    return `✅ 已接入电脑端会话: ${target.title}${proj}\n对话 ID: ${target.id.slice(0, 8)} (${target.steps || 0}步)\n现在发送的消息将直接在该会话中继续。`;
  }

  return `❌ 无效编号。发 ws 查看 Projects 与 Conversations 列表。`;
}

async function cmdConversations(sid: string, session: Session, arg: string): Promise<string> {
  if (!arg || cachedConvs.length === 0) {
    cachedConvs = (await get('/api/conversations')).slice(0, 20);
  }
  if (!arg) {
    if (!cachedConvs.length) return '⚠️ 暂无历史对话';
    const cur = session.cascadeId ? session.cascadeId.slice(0, 8) : '(无)';
    const lines = cachedConvs.map((c: any, i: number) => {
      const proj = c.projectName ? ` [${c.projectName}]` : '';
      const active = c.id === session.cascadeId ? '👉 ' : '   ';
      return `${active}${i + 1}. ${c.title}${proj} (${c.steps || 0}步, ${c.id.slice(0, 8)})`;
    });
    return `当前对话: ${cur}\n\n💬 电脑端已打开的 Conversations（发 对话 <编号> 接入该会话）：\n\n${lines.join('\n')}`;
  }
  const num = parseInt(arg, 10);
  if (num >= 1 && num <= cachedConvs.length) {
    const target = cachedConvs[num - 1];
    session.cascadeId = target.id;
    session.workspace = target.title || target.projectName || 'Conversation';
    const proj = target.projectName ? ` [${target.projectName}]` : '';
    return `✅ 已接入电脑端会话: ${target.title}${proj}\n对话 ID: ${target.id.slice(0, 8)} (${target.steps || 0}步)\n现在发送的消息将直接在该会话中继续。`;
  }
  return '❌ 无效编号。发 对话 查看最近对话列表。';
}

async function cmdWorkflows(): Promise<string> {
  const wfs: any[] = await get('/api/workflows');
  if (!wfs?.length) return '⚠️ 没有可用的 Workflow';
  const lines = wfs.map((w, i) => {
    const desc = w.description ? ` — ${w.description}` : '';
    const scope = w.scope === 'global' ? '🌐' : '📁';
    return `${scope} ${i + 1}. ${w.name}${desc}`;
  });
  return `🔄 Workflow 列表：\n\n${lines.join('\n')}\n\n用法：直接发消息让 agent 使用某个 workflow，如 "用 xxx workflow 做 yyy"`;
}

async function cmdSkills(): Promise<string> {
  const skills: any[] = await get('/api/skills');
  if (!skills?.length) return '⚠️ 没有可用的 Skill';
  const lines = skills.map((s, i) => {
    const desc = s.description ? ` — ${s.description}` : '';
    const scope = s.scope === 'global' ? '🌐' : '📁';
    return `${scope} ${i + 1}. ${s.name}${desc}`;
  });
  return `🧠 Skill 列表：\n\n${lines.join('\n')}\n\n用法：直接发消息引用 skill，如 "用 xxx skill"`;
}

function cmdHelp(): string {
  return [
    '📖 Antigravity 微信助手\n',
    '── 会话管理 ──',
    '/new — 新建会话',
    '/list — 列出会话历史',
    '/switch <编号> — 切换到历史会话\n',
    '── 模型和工作区 ──',
    '模型 — 查看可用模型和余量',
    '模型 <编号或名称> — 切换模型',
    'ws — 查看/切换工作区（新建对话）',
    '对话 — 查看/接入 Antigravity 已有 Conversations',
    '状态 — 当前会话信息\n',
    '── 知识库 ──',
    'workflow — 列出可用工作流',
    'skill — 列出可用技能\n',
    '── 其他 ──',
    '📸 直接发图片 → agent 自动分析',
    '💬 直接打字 → agent 直接回复',
    '帮助 — 显示本页',
  ].join('\n');
}

// ─── ACP handlers ────────────────────────────────────────────────────────

async function onInit(id: number | string) {
  ok(id, { protocolVersion: 1, agentCapabilities: { loadSession: false } });
}

async function onNewSession(id: number | string, params: any) {
  const sid = `ag-${++counter}-${Date.now()}`;
  const cwd: string | undefined = params?.cwd;

  try {
    await refreshWorkspaces();
    const matched = matchWorkspace(cwd);

    if (matched) {
      const cascadeId = await createConv(matched);
      sessions.set(sid, { cascadeId, workspace: matched, model: DEFAULT_MODEL, cancelled: false });
    } else {
      // Unbound — workspace selection on first prompt
      sessions.set(sid, { model: DEFAULT_MODEL, cancelled: false });
    }
    ok(id, { sessionId: sid });
  } catch (e: any) {
    err(id, -32000, `创建会话失败: ${e.message}`);
  }
}

async function onPrompt(id: number | string, params: any) {
  const session = sessions.get(params.sessionId);
  if (!session) { err(id, -32000, 'Session not found'); return; }

  const blocks: any[] = params.prompt || [];
  const text = blocks.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text).join('\n').trim();
  if (!text) { ok(id, { stopReason: 'end_turn' }); return; }

  session.cancelled = false;
  const sid = params.sessionId;

  // ━━━ Command intercept ━━━
  // Slash commands (/models etc.) AND keyword commands (模型, model, ws)
  // Note: cc-connect intercepts built-in /model, /workspace, /status, /help
  // — they never reach here. Only non-built-in slash commands and keywords do.
  const lower = text.toLowerCase().trim();
  let intercepted: string | null = null;

  if (lower === '/models' || lower === '模型' || lower === '模型列表') {
    intercepted = await cmdModels(sid);
  } else if (lower.startsWith('/model ') || lower.startsWith('model ') || lower.startsWith('切换模型 ') || lower.startsWith('模型 ')) {
    const arg = text.replace(/^(\/model|model|切换模型|模型)\s+/i, '').trim();
    intercepted = await cmdModel(sid, session, arg);
  } else if (lower === '/model' || lower === 'model') {
    intercepted = await cmdModel(sid, session, '');
  } else if (lower === '/status' || lower === '状态') {
    intercepted = await cmdStatus(sid, session);
  } else if (lower.startsWith('/workspace') || lower.startsWith('ws ') || lower === 'ws' || lower === '工作区') {
    const arg = text.replace(/^(\/workspace|ws|工作区)\s*/i, '').trim();
    intercepted = await cmdWorkspace(sid, session, arg);
  } else if (lower === '对话' || lower.startsWith('对话 ') || lower === 'convs' || lower.startsWith('convs ')) {
    const arg = text.replace(/^(对话|convs)\s*/i, '').trim();
    intercepted = await cmdConversations(sid, session, arg);
  } else if (lower === '/help' || lower === '帮助' || lower === '命令') {
    intercepted = cmdHelp();
  } else if (lower === 'workflow' || lower === 'workflows' || lower === '流程') {
    intercepted = await cmdWorkflows();
  } else if (lower === 'skill' || lower === 'skills' || lower === '技能') {
    intercepted = await cmdSkills();
  }

  if (intercepted) {
    reply(sid, intercepted);
    ok(id, { stopReason: 'end_turn' });
    return;
  }

  // ━━━ Workspace selection (unbound session) ━━━
  if (!session.cascadeId) {
    await handleWsSelect(id, sid, session, text);
    return;
  }

  // ━━━ Normal message ━━━
  try {
    // Extract image paths from cc-connect's "(Image files saved locally: ...)" annotation
    // and convert to @[path] file references that the send API understands
    let msgText = text;
    const imgMatch = text.match(/\(Image files saved locally:\s*(.+?)\)\s*$/);
    if (imgMatch) {
      const paths = imgMatch[1].split(',').map(p => p.trim()).filter(Boolean);
      msgText = text.replace(imgMatch[0], '').trim();
      if (!msgText) msgText = '请分析这张图片';
      for (const p of paths) {
        msgText += ` @[${p}]`;
      }
    }

    const res = await waitDone(sid, session, async () => {
      await post(`/api/conversations/${session.cascadeId}/send`, {
        text: msgText,
        model: session.model,
        agenticMode: true,
      });
    });
    if (res.error) {
      reply(sid, `${res.emitted ? '\n\n' : ''}❌ ${res.error}`);
    } else if (!res.emitted) {
      reply(sid, '⚠️ 未收到模型输出（该会话可能已失效或仍在后台运行，请发 ws 重新选择会话）');
    }
    ok(id, { stopReason: session.cancelled ? 'cancelled' : 'end_turn' });
  } catch (e: any) {
    if (session.cancelled) {
      ok(id, { stopReason: 'cancelled' });
    } else {
      reply(sid, `❌ ${e.message}`);
      ok(id, { stopReason: 'end_turn' });
    }
  }
}

async function handleWsSelect(rpcId: number | string, sid: string, session: Session, text: string) {
  const num = parseInt(text.trim(), 10);
  if (isNaN(num) || (runningWorkspaces.length === 0 && cachedConvs.length === 0)) {
    await refreshWorkspaces();
  }
  const projTotal = runningWorkspaces.length + 1; // +1 for playground
  const allTotal = projTotal + cachedConvs.length;

  if (num >= 1 && num <= projTotal) {
    const ws = num <= runningWorkspaces.length ? runningWorkspaces[num - 1].workspace : 'playground';
    try {
      session.cascadeId = await createConv(ws);
      session.workspace = ws;
      const name = ws === 'playground' ? 'Playground' : ws.replace('file://', '').split('/').pop();
      reply(sid, `✅ 已绑定: ${name}\n\n现在可以开始对话了。`);
    } catch (e: any) {
      reply(sid, `❌ 绑定失败: ${e.message}\n\n${fmtWorkspaceList(session.cascadeId)}`);
    }
  } else if (num > projTotal && num <= allTotal) {
    const target = cachedConvs[num - projTotal - 1];
    session.cascadeId = target.id;
    session.workspace = target.title || target.projectName || 'Conversation';
    const proj = target.projectName ? ` [${target.projectName}]` : '';
    reply(sid, `✅ 已接入电脑端会话: ${target.title}${proj}\n对话 ID: ${target.id.slice(0, 8)} (${target.steps || 0}步)\n\n现在可以继续对话了。`);
  } else if (runningWorkspaces.length === 0 && cachedConvs.length === 0) {
    reply(sid, '⚠️ 没有运行中的工作区或历史会话。请先在 Antigravity 中打开项目，然后发 /new 重试。');
  } else {
    reply(sid, `请选择要新建的 Project 或接入已有的 Conversation（发送数字）：\n\n${fmtWorkspaceList(session.cascadeId)}`);
  }
  ok(rpcId, { stopReason: 'end_turn' });
}

async function onCancel(params: any) {
  const s = sessions.get(params?.sessionId);
  if (!s) return;
  s.cancelled = true;
  try { s.ws?.close(); } catch {}
  if (s.cascadeId) {
    try { await post(`/api/conversations/${s.cascadeId}/cancel`); } catch {}
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────

async function dispatch(msg: any) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':      return onInit(id);
      case 'session/new':     return onNewSession(id, params);
      case 'session/load':    return err(id, -32601, 'not supported');
      case 'authenticate':    return ok(id, {});
      case 'session/setMode': return ok(id, {});
      case 'session/prompt':  return onPrompt(id, params);
      case 'session/cancel':  return onCancel(params);
      default: if (id != null) err(id, -32601, `Unknown: ${method}`);
    }
  } catch (e: any) {
    if (id != null) err(id, -32603, e.message);
  }
}

// ─── Stdio ───────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (l) => { const s = l.trim(); if (s) try { dispatch(JSON.parse(s)); } catch {} });
rl.on('close', () => process.exit(0));
process.on('unhandledRejection', () => {});
