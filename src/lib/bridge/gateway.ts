/**
 * Gateway — shared state and helpers for API routes and WebSocket server.
 * Extracted from the old Express src/index.ts.
 */
import { discoverLanguageServers, getLanguageServer } from './discovery';
import { getApiKey } from './statedb';
import * as grpc from './grpc';
import { createLogger } from '../logger';

const log = createLogger('Gateway');

// Re-export bridge modules for convenience
export { discoverLanguageServers, getLanguageServer } from './discovery';
export { getApiKey, getUserInfo, getWorkspaces, getPlaygrounds, getConversations, addLocalConversation } from './statedb';
export * as grpc from './grpc';

// --- Helper: get all server connections ---
export function getAllConnections() {
  const servers = discoverLanguageServers();
  if (servers.length === 0) return [];
  const apiKey = getApiKey();
  return servers.map(s => ({ ...s, apiKey }));
}

export function getDefaultConnection() {
  const srv = getLanguageServer();
  if (!srv) return null;
  return { ...srv, apiKey: getApiKey() };
}

// --- Conversation → Owner Server Mapping ---
export interface OwnerInfo { port: number; csrf: string; apiKey: string; stepCount: number; workspace?: string; }
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
  log.info({ cascadeId: cascadeId.slice(0,8), port: info.port }, 'Pre-registered owner');
}

/** Get the owner server connection for a specific conversation */
export function getOwnerConnection(cascadeId: string) {
  // 1. Check main ownerMap (populated by refreshOwnerMap)
  const owner = convOwnerMap.get(cascadeId);
  if (owner) {
    log.debug({ cascadeId: cascadeId.slice(0,8), port: owner.port, source: 'ownerMap' }, 'Owner lookup');
    return owner;
  }
  // 2. Check pre-registered owners (survives refresh cycles)
  const preReg = preRegisteredOwners.get(cascadeId);
  if (preReg && Date.now() - preReg.registeredAt < PRE_REG_TTL_MS) {
    log.debug({ cascadeId: cascadeId.slice(0,8), port: preReg.port, source: 'pre-reg', ageSec: Math.round((Date.now() - preReg.registeredAt)/1000) }, 'Owner lookup');
    return preReg;
  }
  // 3. Fallback
  const conns = getAllConnections();
  log.debug({ cascadeId: cascadeId.slice(0,8), serverCount: conns.length, source: 'fallback' }, 'Owner lookup fallback');
  return conns.length > 0
    ? { port: conns[0].port, csrf: conns[0].csrf, apiKey: conns[0].apiKey, stepCount: 0 }
    : null;
}

/** Refresh the owner map from the 2.0 hub. */
export async function refreshOwnerMap() {
  const conns = getAllConnections();
  log.info({ serverCount: conns.length, servers: conns.map(c => String(c.port)).join(', ') }, 'OwnerMap refreshing');

  convOwnerMap.clear();

  for (const conn of conns) {
    try {
      const data = await grpc.getAllCascadeTrajectories(conn.port, conn.csrf);
      const summaries = data?.trajectorySummaries || {};
      log.debug({ port: conn.port, convCount: Object.keys(summaries).length }, 'Hub trajectories loaded');

      for (const [id, info] of Object.entries(summaries) as [string, any][]) {
        convOwnerMap.set(id, {
          port: conn.port,
          csrf: conn.csrf,
          apiKey: conn.apiKey,
          stepCount: info.stepCount || 0,
        });
      }
    } catch (e: any) {
      log.warn({ port: conn.port, err: e.message }, 'Failed to get trajectories');
    }
  }

  // Merge back pre-registered owners that weren't found in server data yet
  const now = Date.now();
  for (const [id, preReg] of preRegisteredOwners.entries()) {
    if (now - preReg.registeredAt > PRE_REG_TTL_MS) {
      preRegisteredOwners.delete(id); // expired
    } else if (!convOwnerMap.has(id)) {
      convOwnerMap.set(id, preReg);
      log.debug({ cascadeId: id.slice(0,8), port: preReg.port, ageSec: Math.round((now - preReg.registeredAt)/1000) }, 'Preserved pre-reg');
    } else {
      // Server caught up, clean pre-registration
      preRegisteredOwners.delete(id);
    }
  }

  ownerMapAge = Date.now();
  log.info({ total: convOwnerMap.size, preRegPending: preRegisteredOwners.size }, 'OwnerMap rebuilt');
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
