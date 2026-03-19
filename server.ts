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

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000');

const app = next({ dev, hostname, port });
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
    let abortStream: (() => void) | null = null;

    ws.on('message', async (raw: Buffer) => {
      try {
        await ensureBridge();
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.cascadeId) {
          const cascadeId = msg.cascadeId;
          if (abortStream) { abortStream(); abortStream = null; }

          if (!gateway.convOwnerMap.has(cascadeId) || Date.now() - gateway.ownerMapAge > 30_000) {
            await gateway.refreshOwnerMap();
          }

          const owner = gateway.getOwnerConnection(cascadeId);
          if (!owner) {
            ws.send(JSON.stringify({ type: 'error', message: 'No server found for this conversation' }));
            return;
          }
          console.log(`📡 Stream subscribe: ${cascadeId.slice(0,8)} → port ${owner.port}`);

          let fullSteps: any[] = [];

          function startStream(conn: { port: number; csrf: string }) {
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
                  const indices: number[] = stepsUpdate.indices || [];
                  const newSteps: any[] = stepsUpdate.steps || [];
                  const totalLength: number = stepsUpdate.totalLength || 0;

                  if (indices.length > 0 && indices.length === newSteps.length) {
                    if (totalLength > fullSteps.length) {
                      fullSteps.length = totalLength;
                    }
                    for (let i = 0; i < indices.length; i++) {
                      fullSteps[indices[i]] = newSteps[i];
                    }
                  } else if (newSteps.length > fullSteps.length) {
                    fullSteps = [...newSteps];
                  } else if (newSteps.length === fullSteps.length) {
                    fullSteps = [...newSteps];
                  }

                  const cleanSteps = fullSteps.filter(s => s != null);
                  ws.send(JSON.stringify({ type: 'steps', cascadeId, data: { steps: cleanSteps }, isActive, cascadeStatus }));
                } else {
                  ws.send(JSON.stringify({ type: 'status', cascadeId, isActive, cascadeStatus }));
                }
              },
              async (err: Error) => {
                console.log(`Stream ended for ${cascadeId.slice(0,8)}: ${err.message}, reconnecting...`);
                setTimeout(async () => {
                  if (ws.readyState === ws.OPEN) {
                    await ensureBridge();
                    await gateway.refreshOwnerMap();
                    const newOwner = gateway.getOwnerConnection(cascadeId);
                    if (newOwner) {
                      console.log(`📡 Stream reconnect: ${cascadeId.slice(0,8)} → port ${newOwner.port}`);
                      fullSteps = [];
                      startStream(newOwner);
                    }
                  }
                }, 2000);
              }
            );
            abortStream = abort;
          }

          startStream(owner);
        }

        if (msg.type === 'unsubscribe') {
          if (abortStream) { abortStream(); abortStream = null; }
        }
      } catch {}
    });

    ws.on('close', () => {
      if (abortStream) { abortStream(); abortStream = null; }
    });
  });

  server.listen(port, hostname, () => {
    console.log(`\n🚀 Antigravity Gateway running on http://${hostname}:${port}`);
    console.log(`   Single-port mode: Next.js + API + WebSocket\n`);
    console.log(`📱 Open on phone: http://<your-ip>:${port}\n`);
  });
});
