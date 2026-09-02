import https from 'https';
import { IncomingMessage } from 'http';
import { getDiscoveredIdeVersion } from './discovery';

const agent = new https.Agent({ rejectUnauthorized: false });

/**
 * Build a Connect streaming envelope: [flags:1][length:4 BE][payload]
 */
function buildConnectEnvelope(json: Record<string, any>): Buffer {
  const payload = Buffer.from(JSON.stringify(json), 'utf-8');
  const header = Buffer.alloc(5);
  header.writeUInt8(0x00, 0); // flags = normal data
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Parse Connect streaming envelopes from a buffer.
 * Returns parsed messages and remaining unprocessed bytes.
 */
function parseConnectEnvelopes(buf: Buffer): { messages: any[]; remaining: Buffer } {
  const messages: any[] = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const flags = buf.readUInt8(pos);
    const length = buf.readUInt32BE(pos + 1);
    if (pos + 5 + length > buf.length) break; // incomplete
    const payload = buf.subarray(pos + 5, pos + 5 + length);
    try {
      messages.push(JSON.parse(payload.toString('utf-8')));
    } catch { /* skip malformed */ }
    pos += 5 + length;
  }
  return { messages, remaining: buf.subarray(pos) };
}

/**
 * Open a Connect streaming connection to StreamAgentStateUpdates.
 * Returns an abort function. Calls onUpdate for each streamed update.
 * The language server sends the full state initially, then pushes deltas on changes.
 */
export function streamAgentState(
  port: number,
  csrf: string,
  conversationId: string,
  onUpdate: (update: any) => void,
  onError?: (err: Error) => void,
): () => void {
  const body = buildConnectEnvelope({
    conversationId,
    subscriberId: `gateway-${Date.now()}`,
  });

  let aborted = false;
  const req = https.request({
    hostname: '127.0.0.1',
    port,
    path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
    method: 'POST',
    agent,
    headers: {
      'Content-Type': 'application/connect+json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': csrf,
      'Content-Length': body.length,
    },
  }, (res: IncomingMessage) => {
    let buffer = Buffer.alloc(0);

    res.on('data', (chunk: Buffer) => {
      if (aborted) return;
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, remaining } = parseConnectEnvelopes(buffer);
      buffer = Buffer.from(remaining);
      for (const msg of messages) {
        const update = msg?.update;
        if (update) {
          onUpdate(update);
        } else if (msg?.error) {
          onError?.(new Error(msg.error.message || 'stream error'));
        }
      }
    });

    res.on('end', () => {
      if (!aborted) {
        onError?.(new Error('stream ended'));
      }
    });

    res.on('error', (err) => {
      if (!aborted) onError?.(err);
    });
  });

  req.on('error', (err) => {
    if (!aborted) onError?.(err);
  });

  req.write(body);
  req.end();

  // Return abort function
  return () => {
    aborted = true;
    req.destroy();
  };
}

export interface GrpcCallOptions {
  port: number;
  csrf: string;
  method: string;
  body: Record<string, any>;
}

/**
 * Make a gRPC-Web call to the language_server.
 */
export function grpcCall(opts: GrpcCallOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(opts.body);
    const req = https.request({
      hostname: '127.0.0.1',
      port: opts.port,
      path: `/exa.language_server_pb.LanguageServerService/${opts.method}`,
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': opts.csrf,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Convenience wrappers ---

export function buildMetadata(apiKey: string, ideVersion?: string) {
  const metadata: Record<string, string> = {
    ideName: 'antigravity',
    locale: 'en',
    ideVersion: ideVersion || getDiscoveredIdeVersion() || '2.11.0',
    extensionName: 'antigravity',
  };
  if (apiKey) metadata.apiKey = apiKey;
  return metadata;
}

export function buildCascadeConfig(
  model: string = 'MODEL_PLACEHOLDER_M26',
  agenticMode: boolean = true,
  artifactReviewMode: string = 'ARTIFACT_REVIEW_MODE_AUTO',
) {
  return {
    plannerConfig: {
      conversational: { plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT', agenticMode },
      toolConfig: {
        runCommand: { autoCommandConfig: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER' } },
        notifyUser: { artifactReviewMode },
        code: { allowEditGitignore: true },
        viewFile: { allowViewGitignore: true },
        grep: { allowAccessGitignore: true },
      },
      requestedModel: { model },
    },
  };
}



export async function startCascade(
  port: number,
  csrf: string,
  apiKey: string,
  options?: string | { projectId?: string; workspaceUris?: string[] },
) {
  const opts = typeof options === 'string' ? { workspaceUris: [options] } : (options || {});
  const body: Record<string, unknown> = {
    metadata: buildMetadata(apiKey),
    source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
  };
  if (opts.projectId) body.projectId = opts.projectId;
  if (opts.workspaceUris?.length) body.workspaceUris = opts.workspaceUris;
  return grpcCall({
    port, csrf,
    method: 'StartCascade',
    body,
  });
}

export async function updateConversationAnnotations(port: number, csrf: string, _apiKey: string, cascadeId: string, annotations: Record<string, any>) {
  // NOTE: Agent Manager does NOT send metadata in this call — only cascadeId + annotations + mergeAnnotations
  return grpcCall({
    port, csrf,
    method: 'UpdateConversationAnnotations',
    body: {
      cascadeId,
      annotations,
      mergeAnnotations: true
    },
  });
}

export async function sendMessage(
  port: number,
  csrf: string,
  apiKey: string,
  cascadeId: string,
  text: string,
  model?: string,
  agenticMode: boolean = true,
  attachments?: { items?: import('../types').MessageItem[], media?: import('../types').MessageMedia[] },
  artifactReviewMode?: string,
) {
  const items: import('../types').MessageItem[] = attachments?.items ? [...attachments.items] : [];
  if (text) {
    items.push({ text });
  }

  const body: any = {
    cascadeId,
    items,
    metadata: buildMetadata(apiKey),
    cascadeConfig: buildCascadeConfig(model, agenticMode, artifactReviewMode),
  };

  if (attachments?.media && attachments.media.length > 0) {
    body.media = attachments.media;
  }

  return grpcCall({
    port, csrf,
    method: 'SendUserCascadeMessage',
    body,
  });
}

export async function proceedArtifact(port: number, csrf: string, apiKey: string, cascadeId: string, artifactUri: string, model?: string) {
  return grpcCall({
    port, csrf,
    method: 'SendUserCascadeMessage',
    body: {
      cascadeId,
      metadata: buildMetadata(apiKey),
      cascadeConfig: buildCascadeConfig(model),
      artifactComments: [{
        artifactUri,
        fullFile: {},
        approvalStatus: 'ARTIFACT_APPROVAL_STATUS_APPROVED',
      }],
    },
  });
}

export async function revertToStep(port: number, csrf: string, apiKey: string, cascadeId: string, stepIndex: number, model?: string) {
  return grpcCall({
    port, csrf,
    method: 'RevertToCascadeStep',
    body: {
      cascadeId,
      stepIndex,
      metadata: buildMetadata(apiKey),
      overrideConfig: buildCascadeConfig(model)?.plannerConfig ? { plannerConfig: buildCascadeConfig(model).plannerConfig } : undefined,
    },
  });
}

export async function getModelConfigs(port: number, csrf: string, apiKey: string) {
  return grpcCall({
    port, csrf,
    method: 'GetCascadeModelConfigData',
    body: { metadata: buildMetadata(apiKey) },
  });
}

export async function getTrajectorySteps(port: number, csrf: string, apiKey: string, cascadeId: string) {
  return grpcCall({
    port, csrf,
    method: 'GetCascadeTrajectorySteps',
    body: { cascadeId, metadata: buildMetadata(apiKey) },
  });
}

export async function cancelCascade(port: number, csrf: string, apiKey: string, cascadeId: string) {
  return grpcCall({
    port, csrf,
    method: 'CancelCascadeInvocation',
    body: { cascadeId, metadata: buildMetadata(apiKey) },
  });
}

export async function getRevertPreview(port: number, csrf: string, apiKey: string, cascadeId: string, stepIndex: number, model?: string) {
  return grpcCall({
    port, csrf,
    method: 'GetRevertPreview',
    body: {
      cascadeId,
      stepIndex,
      metadata: buildMetadata(apiKey),
      overrideConfig: buildCascadeConfig(model)?.plannerConfig ? { plannerConfig: buildCascadeConfig(model).plannerConfig } : undefined,
    },
  });
}

export async function initializePanelState(port: number, csrf: string, apiKey: string) {
  return grpcCall({
    port, csrf,
    method: 'InitializeCascadePanelState',
    body: { metadata: buildMetadata(apiKey) },
  });
}

export async function createProject(port: number, csrf: string, project: { id: string; name: string; projectResources: unknown }) {
  return grpcCall({
    port, csrf,
    method: 'CreateProject',
    body: { project },
  });
}

export async function resolveFolder(port: number, csrf: string, folderUri: string) {
  return grpcCall({
    port, csrf,
    method: 'ResolveFolder',
    body: { folderUri },
  });
}

export async function addTrackedWorkspace(port: number, csrf: string, workspacePath: string) {
  // 2.0 hub requires a filesystem path, not a file:// URI.
  const workspace = workspacePath.replace(/^file:\/\//, '');
  return grpcCall({
    port, csrf,
    method: 'AddTrackedWorkspace',
    body: { workspace },
  });
}

export async function getAllSkills(port: number, csrf: string) {
  return grpcCall({
    port, csrf,
    method: 'GetAllSkills',
    body: {},
  });
}

export async function loadTrajectory(port: number, csrf: string, cascadeId: string) {
  return grpcCall({
    port, csrf,
    method: 'LoadTrajectory',
    body: { cascadeId },
  });
}

export async function getAllCascadeTrajectories(port: number, csrf: string) {
  return grpcCall({
    port, csrf,
    method: 'GetAllCascadeTrajectories',
    body: {},
  });
}

export async function getCascadeTrajectory(port: number, csrf: string, cascadeId: string) {
  return grpcCall({
    port, csrf,
    method: 'GetCascadeTrajectory',
    body: { cascadeId },
  });
}

export async function getAllWorkflows(port: number, csrf: string) {
  return grpcCall({
    port, csrf,
    method: 'GetAllWorkflows',
    body: {},
  });
}

export async function getAllRules(port: number, csrf: string) {
  return grpcCall({
    port, csrf,
    method: 'GetAllRules',
    body: {},
  });
}

export async function getUserStatus(port: number, csrf: string, apiKey: string = '') {
  return grpcCall({
    port, csrf,
    method: 'GetUserStatus',
    body: { metadata: buildMetadata(apiKey) },
  });
}

export async function getUserAnalyticsSummary(port: number, csrf: string, apiKey: string) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return grpcCall({
    port, csrf,
    method: 'GetUserAnalyticsSummary',
    body: {
      metadata: buildMetadata(apiKey),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      startTimestamp: thirtyDaysAgo.toISOString(),
      endTimestamp: now.toISOString(),
    },
  });
}
