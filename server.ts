/**
 * Custom Next.js server with WebSocket support.
 * Runs both Next.js and WS server on a single port.
 *
 * IMPORTANT: Do NOT statically import bridge modules here.
 * tsx watch monitors all static imports — if bridge files change,
 * it restarts the server, but Next.js doesn't release .next/dev/lock
 * in time, causing lock conflicts and restart loops.
 * Use dynamic import() instead so tsx watch only watches this file.
 */
import { createServer } from 'http';
import next from 'next';
import { parse } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from './src/lib/logger';
import { mergeStepsUpdate, extractLastTaskBoundary } from './src/lib/agents/step-merger';

const log = createLogger('Server');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000');

const app = next({ dev, hostname, port, turbopack: false });
const handle = app.getRequestHandler();

// Lazy-loaded bridge modules (loaded on first WS connection, not at startup)
let bridgeLoaded = false;
let gateway: any = null;
let grpc: any = null;

async function ensureBridge() {
  if (!bridgeLoaded) {
    gateway = await import('./src/lib/bridge/gateway');
    grpc = await import('./src/lib/bridge/grpc');
    bridgeLoaded = true;
  }
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    // CORS for remote clients (Obsidian plugin, etc.)
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = parse(req.url || '', true);
    handle(req, res, parsedUrl);
  });

  // --- WebSocket Server ---
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url || '', true);
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    // Other upgrade requests (e.g. Next.js HMR) are handled by Next.js
  });

  wss.on('connection', (ws: WebSocket) => {
    const activeStreams = new Map<string, { abort: () => void; fullSteps: any[] }>();

    function startStreamForId(cascadeId: string, conn: { port: number; csrf: string }) {
      // Clean up existing stream for this ID if any
      const existing = activeStreams.get(cascadeId);
      if (existing) { existing.abort(); activeStreams.delete(cascadeId); }

      let fullSteps: any[] = [];

      const abort = grpc.streamAgentState(
        conn.port,
        conn.csrf,
        cascadeId,
        (update: any) => {
          const stepsUpdate = update?.mainTrajectoryUpdate?.stepsUpdate;
          const status = update?.status || '';
          const isActive = status !== 'CASCADE_RUN_STATUS_IDLE';
          const cascadeStatus = status.replace('CASCADE_RUN_STATUS_', '').toLowerCase();

          if (stepsUpdate?.steps?.length) {
            // Use shared merge logic
            fullSteps = mergeStepsUpdate(fullSteps, stepsUpdate);

            // Extract task boundary from merged steps (most reliable)
            const lastTaskBoundary = extractLastTaskBoundary(fullSteps);

            const cleanSteps = fullSteps.filter(s => s != null);
            ws.send(JSON.stringify({
              type: 'steps', cascadeId, data: { steps: cleanSteps }, isActive, cascadeStatus,
              totalLength: stepsUpdate.totalLength || cleanSteps.length,
              lastTaskBoundary,
            }));
          } else {
            const lastTaskBoundary = extractLastTaskBoundary(fullSteps);
            ws.send(JSON.stringify({
              type: 'status', cascadeId, isActive, cascadeStatus,
              stepCount: fullSteps.filter(s => s != null).length,
              lastTaskBoundary,
            }));
          }
        },
        async (err: Error) => {
          if (err.message.includes('not_found') || err.message.includes('not found in any store')) {
            log.warn({ cascadeId: cascadeId.slice(0,8), err: err.message }, 'Trajectory not found, stopping stream');
            activeStreams.delete(cascadeId);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'error',
                cascadeId,
                message: `对话不存在或未持久化 (${cascadeId.slice(0, 8)})，请发送 ws 重新选择工作区或已有对话`,
              }));
            }
            return;
          }
          log.warn({ cascadeId: cascadeId.slice(0,8), err: err.message }, 'Stream ended, reconnecting...');
          setTimeout(async () => {
            if (ws.readyState === ws.OPEN) {
              await ensureBridge();
              await gateway.refreshOwnerMap();
              const newOwner = gateway.getOwnerConnection(cascadeId);
              if (newOwner) {
                log.info({ cascadeId: cascadeId.slice(0,8), port: newOwner.port }, 'Stream reconnected');
                startStreamForId(cascadeId, newOwner);
              }
            }
          }, 2000);
        }
      );

      activeStreams.set(cascadeId, { abort, fullSteps });
    }

    ws.on('message', async (raw: Buffer) => {
      try {
        await ensureBridge();
        const msg = JSON.parse(raw.toString());

        // Single subscribe (backward compatible — clears all previous streams)
        if (msg.type === 'subscribe' && msg.cascadeId) {
          const cascadeId = msg.cascadeId;
          // Close all existing streams
          for (const [, s] of activeStreams) s.abort();
          activeStreams.clear();

          if (!gateway.convOwnerMap.has(cascadeId) || Date.now() - gateway.ownerMapAge > 30_000) {
            await gateway.refreshOwnerMap();
          }

          const owner = gateway.getOwnerConnection(cascadeId);
          if (!owner) {
            ws.send(JSON.stringify({ type: 'error', message: 'No server found for this conversation' }));
            return;
          }
          log.info({ cascadeId: cascadeId.slice(0,8), port: owner.port }, 'Stream subscribe');
          startStreamForId(cascadeId, owner);
        }

        // Multi-subscribe (add streams without clearing existing)
        if (msg.type === 'multi-subscribe' && Array.isArray(msg.cascadeIds)) {
          if (Date.now() - gateway.ownerMapAge > 30_000) {
            await gateway.refreshOwnerMap();
          }
          for (const cascadeId of msg.cascadeIds) {
            if (activeStreams.has(cascadeId)) continue; // already streaming
            const owner = gateway.getOwnerConnection(cascadeId);
            if (owner) {
              log.info({ cascadeId: cascadeId.slice(0,8), port: owner.port }, 'Multi-subscribe');
              startStreamForId(cascadeId, owner);
            }
          }
        }

        if (msg.type === 'unsubscribe') {
          if (msg.cascadeId) {
            const s = activeStreams.get(msg.cascadeId);
            if (s) { s.abort(); activeStreams.delete(msg.cascadeId); }
          } else {
            for (const [, s] of activeStreams) s.abort();
            activeStreams.clear();
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      for (const [, s] of activeStreams) s.abort();
      activeStreams.clear();
    });
  });

  server.listen(port, hostname, async () => {
    log.info({ hostname, port }, '🚀 Antigravity Gateway running');
    log.info('Single-port mode: Next.js + API + WebSocket');

    // --- Auto-start Cloudflare Tunnel ---
    try {
      const tunnel = await import('./src/lib/bridge/tunnel');
      const config = tunnel.loadTunnelConfig();
      if (config?.autoStart && config.tunnelName) {
        log.info({ tunnelName: config.tunnelName }, '🌐 Auto-starting tunnel...');
        const result = await tunnel.startTunnel(port);
        if (result.success) {
          log.info({ url: result.url }, '🌐 Tunnel active');
        } else {
          log.warn({ error: result.error }, '🌐 Tunnel failed');
        }
      }
    } catch (err: any) {
      log.warn({ err: err.message }, '🌐 Tunnel auto-start skipped');
    }
  });

  // Clean up tunnel on exit
  const cleanup = async () => {
    try {
      const tunnel = await import('./src/lib/bridge/tunnel');
      tunnel.stopTunnel();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
});
