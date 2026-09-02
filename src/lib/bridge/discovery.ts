import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { createLogger } from '../logger';

const log = createLogger('Discovery');

export interface LanguageServerInfo {
  pid: number;
  port: number;
  csrf: string;
  ideVersion?: string;
}

let _cachedServers: LanguageServerInfo[] = [];
let _cacheTime = 0;
const CACHE_TTL_MS = 3000;

function collectListenPorts(lsofOutput: string, pid: number): number[] {
  const ports: number[] = [];
  const pidRegex = new RegExp(`^language_\\S*\\s+${pid}\\s+.*:(\\d{4,5})\\s+\\(LISTEN\\)`, 'gm');
  let match: RegExpExecArray | null;
  while ((match = pidRegex.exec(lsofOutput)) !== null) {
    const port = parseInt(match[1]);
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

/**
 * Antigravity 2.0 hub listens on two ports: HTTPS gRPC and HTTP UI.
 * Prefer the HTTPS gRPC port recorded in language_server.log.
 */
function pickGrpcPort(ports: number[]): number {
  if (ports.length === 0) return 0;
  if (ports.length === 1) return ports[0];

  const logPaths = [
    path.join(homedir(), 'Library/Logs/Antigravity/language_server.log'),
    path.join(homedir(), '.config/Antigravity/logs/language_server.log'),
  ];
  for (const logPath of logPaths) {
    try {
      if (!existsSync(logPath)) continue;
      const text = readFileSync(logPath, 'utf-8').slice(-80_000);
      const matches = [...text.matchAll(/listening on random port at (\d+) for HTTPS/gi)];
      if (matches.length > 0) {
        const logged = parseInt(matches[matches.length - 1][1]);
        if (ports.includes(logged)) return logged;
      }
    } catch { /* ignore */ }
  }

  return Math.min(...ports);
}

function isHubProcess(line: string): boolean {
  return /--subclient_type[=\s]+hub\b/.test(line)
    || (/--standalone\b/.test(line) && !/--workspace_id[=\s]+/.test(line));
}

/**
 * Discover the Antigravity 2.0 hub language_server.
 * Cached for 3 seconds.
 */
export function discoverLanguageServers(): LanguageServerInfo[] {
  if (Date.now() - _cacheTime < CACHE_TTL_MS && _cachedServers.length > 0) {
    return _cachedServers;
  }

  const servers: LanguageServerInfo[] = [];

  try {
    const psOutput = execSync('ps aux', { encoding: 'utf-8', timeout: 5000 });
    const psLines = psOutput.split('\n').filter(l =>
      l.includes('language_server') && l.includes('--csrf_token') && isHubProcess(l)
    );

    let lsofOutput = '';
    try {
      lsofOutput = execSync('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null', { encoding: 'utf-8', timeout: 10000 });
    } catch {}

    for (const line of psLines) {
      const pidMatch = line.match(/^\S+\s+(\d+)/);
      const csrfMatch = line.match(/--csrf_token[=\s]+(\S+)/);
      if (!pidMatch || !csrfMatch) continue;

      const pid = parseInt(pidMatch[1]);
      const csrf = csrfMatch[1];
      const port = pickGrpcPort(collectListenPorts(lsofOutput, pid));
      if (port === 0) continue;

      const versionMatch = line.match(/--override_ide_version[=\s]+(\S+)/);
      servers.push({ pid, port, csrf, ideVersion: versionMatch?.[1] });
    }
  } catch { /* ps failed */ }

  if (servers.length !== _cachedServers.length || servers.some((s, i) => s.port !== _cachedServers[i]?.port)) {
    log.info({
      count: servers.length,
      servers: servers.map(s => `pid=${s.pid} port=${s.port} v=${s.ideVersion || '?'}`).join(' | '),
    }, 'Hub discovered');
  }

  _cachedServers = servers;
  _cacheTime = Date.now();
  return servers;
}

/** Return the running 2.0 hub, or null. */
export function getLanguageServer(): LanguageServerInfo | null {
  return discoverLanguageServers()[0] || null;
}

export function getDiscoveredIdeVersion(): string | undefined {
  return getLanguageServer()?.ideVersion;
}
