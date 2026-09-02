#!/usr/bin/env node
/**
 * ag — Antigravity Gateway CLI
 *
 * A lightweight CLI that talks to the local Next.js server (http://localhost:PORT).
 * No persistent connections, no MCP stdio fragility — just plain HTTP.
 *
 * Usage:
 *   npx tsx scripts/ag.ts <command> [options]
 *
 * Commands:
 *   projects                       List all projects
 *   project <id>                   Show project detail + pipeline status
 *   runs [--status=running]        List runs (optionally filter by status)
 *   run <runId>                    Show run detail
 *   dispatch <groupId>             Dispatch a new run
 *     --project <projectId>        Attach to project
 *     --source <runId>             Source run ID (repeatable)
 *     --template <templateId>      Template ID
 *     --prompt "..."               Goal / prompt
 *   intervene <runId> <action>     Intervene on a run (retry|restart_role|nudge|cancel)
 *     --prompt "..."               Optional feedback
 *     --role <roleId>              Target specific role
 *   resume <projectId>             Resume project from first actionable stage
 *     --action <action>            recover|nudge|restart_role|cancel
 *     --role <roleId>              Target specific role for restart_role
 */

export {};

const BASE = process.env.AG_BASE_URL || 'http://localhost:3000';

// ── Helpers ──────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: any): Promise<any> {
  const url = `${BASE}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }
}

function die(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function table(rows: Record<string, any>[], columns?: string[]) {
  if (rows.length === 0) return console.log('  (empty)');
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));

  console.log(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
  console.log(cols.map((_, i) => '─'.repeat(widths[i])).join('  '));
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? '—').padEnd(widths[i])).join('  '));
  }
}

function shortId(id: string) { return id?.slice(0, 8) || '—'; }

// ── Commands ─────────────────────────────────────────────────────────────

async function cmdProjects() {
  const data = await api('GET', '/api/projects');
  const projects = Array.isArray(data) ? data : data.projects || [];
  console.log(`\n📋 Projects (${projects.length})\n`);
  table(projects.map((p: any) => ({
    id: shortId(p.projectId),
    name: p.name,
    status: p.status,
    pipeline: p.pipelineState?.status || '—',
    stage: p.pipelineState?.currentStageIndex ?? '—',
    runs: p.runIds?.length || 0,
  })));
}

async function cmdProject(projectId: string) {
  const data = await api('GET', `/api/projects/${projectId}`);
  if (data.error) die(data.error);

  console.log(`\n🏗️  ${data.name}`);
  console.log(`   ID: ${data.projectId}`);
  console.log(`   Status: ${data.status}  |  Pipeline: ${data.pipelineState?.status || '—'}\n`);

  if (data.pipelineState?.stages) {
    const stages = data.pipelineState.stages;
    const icons: Record<string, string> = { completed: '✅', running: '🔄', pending: '⏳', failed: '❌', blocked: '⛔', cancelled: '🚫' };
    console.log('Pipeline Stages:');
    for (const s of stages) {
      const icon = icons[s.status] || '❓';
      console.log(`  ${icon} Stage ${s.stageIndex}: ${s.groupId}  [${s.status}]  attempts=${s.attempts}  run=${shortId(s.runId || '')}`);
    }
  }

  if (data.runIds?.length) {
    console.log(`\nRun IDs: ${data.runIds.map(shortId).join(', ')}`);
  }
}

async function cmdRuns(statusFilter?: string) {
  const data = await api('GET', `/api/agent-runs${statusFilter ? `?status=${statusFilter}` : ''}`);
  const runs = Array.isArray(data) ? data : data.runs || [];
  console.log(`\n🏃 Runs (${runs.length}${statusFilter ? ` — filtered: ${statusFilter}` : ''})\n`);
  table(runs.slice(0, 30).map((r: any) => ({
    id: shortId(r.runId),
    group: r.groupId,
    status: r.status,
    round: r.currentRound || '—',
    review: r.reviewOutcome || '—',
    project: shortId(r.projectId || ''),
  })));
  if (runs.length > 30) console.log(`  ... and ${runs.length - 30} more`);
}

async function cmdRun(runId: string) {
  const data = await api('GET', `/api/agent-runs/${runId}`);
  if (data.error) die(data.error);

  console.log(`\n🔍 Run ${shortId(data.runId)}`);
  console.log(`   Group: ${data.groupId}  |  Status: ${data.status}  |  Round: ${data.currentRound || '—'}`);
  console.log(`   Review: ${data.reviewOutcome || '—'}  |  Template: ${data.templateId || '—'}`);
  if (data.lastError) console.log(`   ⚠️  Error: ${data.lastError}`);
  if (data.result?.summary) console.log(`   📝 ${data.result.summary.slice(0, 150)}`);

  if (data.roles?.length) {
    console.log(`\n   Roles:`);
    for (const role of data.roles) {
      const dec = role.reviewDecision ? ` → ${role.reviewDecision}` : '';
      console.log(`     [R${role.round}] ${role.roleId.padEnd(28)} ${role.status}${dec}`);
    }
  }

  if (data.liveState) {
    const ls = data.liveState;
    console.log(`\n   Live: ${ls.cascadeStatus}  steps=${ls.stepCount}  last=${ls.lastStepType}`);
  }
}

async function cmdDispatch(groupId: string, args: Record<string, string | string[]>) {
  const body: any = {
    groupId,
    ...(args.workspace ? { workspace: args.workspace } : {}),
  };
  if (args.project) body.projectId = args.project;
  if (args.template) body.templateId = args.template;
  if (args.prompt) body.prompt = args.prompt;
  if (args.source) {
    body.sourceRunIds = Array.isArray(args.source) ? args.source : [args.source];
  }

  console.log(`\n🚀 Dispatching ${groupId}...`);
  const data = await api('POST', '/api/agent-runs', body);
  if (data.error) die(data.error);
  console.log(`   ✅ Run created: ${data.runId}`);
  console.log(`   Status: ${data.status}`);
}

async function cmdIntervene(runId: string, action: string, args: Record<string, string>) {
  const body: any = { action };
  if (args.prompt) body.prompt = args.prompt;
  if (args.role) body.roleId = args.role;

  console.log(`\n🔧 Intervening on ${shortId(runId)} with action: ${action}...`);
  const data = await api('POST', `/api/agent-runs/${runId}/intervene`, body);
  if (data.error) die(data.error);
  console.log(`   ✅ ${data.status || JSON.stringify(data)}`);
}

async function cmdResume(projectId: string, args: Record<string, string>) {
  const body: any = {};
  if (args.action) body.action = args.action;
  if (args.prompt) body.prompt = args.prompt;
  if (args.role) body.roleId = args.role;

  console.log(`\n♻️  Resuming project ${shortId(projectId)}...`);
  const data = await api('POST', `/api/projects/${projectId}/resume`, body);
  if (data.error) die(data.error);
  console.log(`   ✅ ${data.message || JSON.stringify(data)}`);
  if (data.runId) console.log(`   Run: ${data.runId}`);
}

// ── Arg Parser ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      let key: string, value: string;
      if (eqIdx > -1) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        value = argv[++i] || '';
      }
      // Support repeatable flags
      if (flags[key]) {
        if (Array.isArray(flags[key])) {
          (flags[key] as string[]).push(value);
        } else {
          flags[key] = [flags[key] as string, value];
        }
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === 'help') {
    console.log(`
Antigravity Gateway CLI (ag)

Commands:
  projects                       List all projects
  project <id>                   Show project detail + pipeline
  runs [--status=running]        List runs
  run <runId>                    Show run detail
  dispatch <groupId> [options]   Dispatch a new run
    --project <id>                 Attach to project
    --source <runId>               Source run (repeatable)
    --template <id>                Template ID
    --prompt "..."                 Goal
  intervene <runId> <action>     Intervene (retry|restart_role|nudge|cancel)
    --prompt "..."                 Feedback
    --role <roleId>                Target role
  resume <projectId>             Resume from first actionable stage
    --action <action>              recover|nudge|restart_role|cancel
    --role <roleId>                Target role for restart_role

Environment:
  AG_BASE_URL                    Server URL (default: http://localhost:3000)
`);
    return;
  }

  switch (cmd) {
    case 'projects': return cmdProjects();
    case 'project':  return cmdProject(positional[1] || die('Usage: ag project <projectId>'));
    case 'runs':     return cmdRuns(flags.status as string);
    case 'run':      return cmdRun(positional[1] || die('Usage: ag run <runId>'));
    case 'dispatch': return cmdDispatch(positional[1] || die('Usage: ag dispatch <groupId>'), flags);
    case 'intervene': return cmdIntervene(
      positional[1] || die('Usage: ag intervene <runId> <action>'),
      (positional[2] as string) || die('Usage: ag intervene <runId> <action>'),
      flags as Record<string, string>,
    );
    case 'resume': return cmdResume(positional[1] || die('Usage: ag resume <projectId>'), flags as Record<string, string>);
    default: die(`Unknown command: ${cmd}. Run 'ag help' for usage.`);
  }
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
