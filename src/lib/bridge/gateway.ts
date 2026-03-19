/**
 * Gateway — shared state and helpers for API routes and WebSocket server.
 * Extracted from the old Express src/index.ts.
 */
import path from 'path';
import { randomBytes } from 'crypto';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

import { discoverLanguageServers, getLanguageServer } from './discovery';
import { getApiKey } from './statedb';
import * as grpc from './grpc';

// Re-export bridge modules for convenience
export { discoverLanguageServers, getLanguageServer } from './discovery';
export { getApiKey, getUserInfo, getWorkspaces, getPlaygrounds, getConversations, addLocalConversation } from './statedb';
export * as grpc from './grpc';

// --- Helper: get all server connections ---
export function getAllConnections() {
  const servers = discoverLanguageServers();
  const apiKey = getApiKey();
  if (!apiKey || servers.length === 0) return [];
  return servers.map(s => ({ ...s, apiKey }));
}

export function getDefaultConnection() {
  const srv = getLanguageServer();
  const apiKey = getApiKey();
  if (!srv || !apiKey) return null;
  return { ...srv, apiKey };
}

// --- Conversation → Owner Server Mapping ---
export interface OwnerInfo { port: number; csrf: string; apiKey: string; stepCount: number; }
export const convOwnerMap = new Map<string, OwnerInfo>();
export let ownerMapAge = 0;

/**
 * Pre-registered owners: conversations manually added by route.ts after creation.
 * These survive refreshOwnerMap() clears because the server's GetAllCascadeTrajectories
 * may take several seconds to include newly created conversations.
 * Each entry has a TTL — after 60s the server should have caught up.
 */
export const preRegisteredOwners = new Map<string, OwnerInfo & { registeredAt: number }>();
const PRE_REG_TTL_MS = 60_000;

/** Pre-register a conversation owner immediately after creation */
export function preRegisterOwner(cascadeId: string, info: OwnerInfo) {
  preRegisteredOwners.set(cascadeId, { ...info, registeredAt: Date.now() });
  convOwnerMap.set(cascadeId, info);
  console.log(`📌 [OwnerMap] Pre-registered ${cascadeId.slice(0,8)} → port ${info.port}`);
}

/** Get the owner server connection for a specific conversation */
export function getOwnerConnection(cascadeId: string) {
  // 1. Check main ownerMap (populated by refreshOwnerMap)
  const owner = convOwnerMap.get(cascadeId);
  if (owner) {
    console.log(`🗺️ [OwnerMap] ${cascadeId.slice(0,8)} → port ${owner.port} (from ownerMap)`);
    return owner;
  }
  // 2. Check pre-registered owners (survives refresh cycles)
  const preReg = preRegisteredOwners.get(cascadeId);
  if (preReg && Date.now() - preReg.registeredAt < PRE_REG_TTL_MS) {
    console.log(`📌 [OwnerMap] ${cascadeId.slice(0,8)} → port ${preReg.port} (from pre-registration, age=${Math.round((Date.now() - preReg.registeredAt)/1000)}s)`);
    return preReg;
  }
  // 3. Fallback
  const conns = getAllConnections();
  console.log(`🗺️ [OwnerMap] ${cascadeId.slice(0,8)} → NOT in ownerMap, falling back to first of ${conns.length} server(s)`);
  return conns.length > 0 ? conns[0] : null;
}

/** Refresh the owner map from all servers */
export async function refreshOwnerMap() {
  const conns = getAllConnections();
  const serverWorkspaceMap = new Map<number, string>();
  const servers = discoverLanguageServers();
  for (const conn of conns) {
    const srv = servers.find(s => s.port === conn.port);
    if (srv?.workspace) {
      serverWorkspaceMap.set(conn.port, srv.workspace);
    }
  }

  console.log(`🔄 [OwnerMap] Refreshing from ${conns.length} server(s): ${conns.map(c => `${c.port}(${serverWorkspaceMap.get(c.port)?.split('/').pop() || '?'})`).join(', ')}`);

  const wsMatched = new Map<string, OwnerInfo>();
  const scFallback = new Map<string, OwnerInfo>();

  for (const conn of conns) {
    try {
      const data = await grpc.getAllCascadeTrajectories(conn.port, conn.csrf);
      const summaries = data?.trajectorySummaries || {};
      const serverWs = serverWorkspaceMap.get(conn.port) || '';
      const convCount = Object.keys(summaries).length;
      console.log(`🔄 [OwnerMap] port=${conn.port} returned ${convCount} conversation(s), serverWs="${serverWs.split('/').pop()}"`);

      for (const [id, info] of Object.entries(summaries) as [string, any][]) {
        const steps = info.stepCount || 0;
        const ownerEntry: OwnerInfo = { port: conn.port, csrf: conn.csrf, apiKey: conn.apiKey, stepCount: steps };

        const convWorkspaces: string[] = (info.workspaces || [])
          .map((w: any) => w.workspaceFolderAbsoluteUri || '')
          .filter(Boolean);

        const matched = serverWs && convWorkspaces.some(ws => serverWs.includes(ws) || ws.includes(serverWs));
        if (matched) {
          const existing = wsMatched.get(id);
          if (!existing || steps > existing.stepCount) {
            wsMatched.set(id, ownerEntry);
          }
        }

        const existing = scFallback.get(id);
        if (!existing || steps > existing.stepCount) {
          scFallback.set(id, ownerEntry);
        }
      }
    } catch (e: any) {
      console.warn(`❌ [OwnerMap] Failed to get trajectories from port ${conn.port}:`, e.message);
    }
  }

  convOwnerMap.clear();
  const allIds = new Set([...wsMatched.keys(), ...scFallback.keys()]);
  for (const id of allIds) {
    const matched = wsMatched.get(id);
    const fallback = scFallback.get(id);
    if (matched) {
      convOwnerMap.set(id, matched);
    } else if (fallback) {
      convOwnerMap.set(id, fallback);
    }
  }

  // Merge back pre-registered owners that weren't found in server data yet
  const now = Date.now();
  for (const [id, preReg] of preRegisteredOwners.entries()) {
    if (now - preReg.registeredAt > PRE_REG_TTL_MS) {
      preRegisteredOwners.delete(id); // expired
    } else if (!convOwnerMap.has(id)) {
      convOwnerMap.set(id, preReg);
      console.log(`📌 [OwnerMap] Preserved pre-registered ${id.slice(0,8)} → port ${preReg.port} (age=${Math.round((now - preReg.registeredAt)/1000)}s)`);
    } else {
      // Server caught up, clean pre-registration
      preRegisteredOwners.delete(id);
    }
  }

  ownerMapAge = Date.now();
  console.log(`🔄 [OwnerMap] Rebuilt: ${convOwnerMap.size} total conversations mapped (${preRegisteredOwners.size} pre-registered pending)`);

  for (const id of allIds) {
    const matched = wsMatched.get(id);
    const fallback = scFallback.get(id);
    if (matched && fallback && matched.port !== fallback.port) {
      console.log(`🔀 Owner routing: ${id.slice(0,8)} → port ${matched.port} (workspace match) instead of ${fallback.port} (stepCount ${fallback.stepCount})`);
    }
  }
}

/**
 * Try a gRPC call on ALL servers until one succeeds.
 * Used ONLY for non-conversation-specific calls.
 */
export async function tryAllServers<T>(
  fn: (port: number, csrf: string, apiKey: string) => Promise<T>,
  timeoutMs = 5000
): Promise<T> {
  const conns = getAllConnections();
  if (conns.length === 0) throw new Error('No language_server found');

  const errors: string[] = [];
  for (const conn of conns) {
    try {
      const result = await Promise.race([
        fn(conn.port, conn.csrf, conn.apiKey),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs)
        )
      ]);
      return result;
    } catch (e: any) {
      errors.push(`port ${conn.port}: ${e.message}`);
    }
  }
  throw new Error(`All ${conns.length} servers failed: ${errors.join('; ')}`);
}

// --- Playground name generator ---
const PG_ADJECTIVES = [
  'astral','blazing','celestial','cosmic','crystal','dark','deep','distant',
  'dynamic','ecliptic','ethereal','frozen','galactic','giant','glacial',
  'golden','gravitic','harmonic','icy','inertial','interstellar','ionic',
  'iridescent','kinetic','lunar','nascent','nomad','orbital','polar',
  'prismic','prograde','pyro','radiant','resonant','shining','silent',
  'silver','spinning','stellar','synthetic','temporal','triple','twilight',
  'ultraviolet','vacant','vast','velvet','white','zero',
];
const PG_NOUNS = [
  'aldrin','andromeda','aurora','belt','cassini','chromosphere','copernicus',
  'cosmos','curie','disk','eagle','einstein','expanse','feynman','filament',
  'flare','galaxy','halley','hubble','ionosphere','kuiper','lagoon',
  'magnetar','meteorite','nadir','nebula','newton','oort','orbit','orion',
  'pathfinder','planetoid','planck','prominence','pulsar','radiation',
  'rocket','rosette','singularity','sunspot','supernova','trifid',
  'triangulum','whirlpool','zodiac',
];
const PLAYGROUND_DIR = path.join(homedir(), '.gemini/antigravity/playground');

export function generatePlaygroundName(): string {
  for (let i = 0; i < 50; i++) {
    const adj = PG_ADJECTIVES[randomBytes(1)[0] % PG_ADJECTIVES.length];
    const noun = PG_NOUNS[randomBytes(1)[0] % PG_NOUNS.length];
    const name = `${adj}-${noun}`;
    if (!existsSync(path.join(PLAYGROUND_DIR, name))) return name;
  }
  return `cosmic-${randomBytes(3).toString('hex')}`;
}

export const PLAYGROUND_DIR_PATH = PLAYGROUND_DIR;
