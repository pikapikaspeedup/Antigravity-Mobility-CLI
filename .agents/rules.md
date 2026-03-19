# Antigravity Gateway — Workspace Rules

> These rules are automatically loaded at the start of every conversation in this workspace.

## Project Overview

**Antigravity Gateway** is an open-source project that reverse-engineers Antigravity's local gRPC `language_server` and exposes it as a web application with REST API + WebSocket support. It turns Antigravity into a headless, remotely accessible AI coding agent.

## Architecture

### Single-Port Stack (Next.js Custom Server)

Everything runs on **one port** (`3000` by default) through a custom Next.js server:

| Layer | Technology | Location |
|-------|-----------|----------|
| **Frontend** | React 19 + shadcn/ui + Tailwind CSS 4 | `src/app/page.tsx` |
| **API** | Next.js 16 App Router API Routes | `src/app/api/` |
| **WebSocket** | `ws` library, attached to custom server | `server.ts` |
| **Bridge** | gRPC-Web, SQLite, process discovery | `src/lib/bridge/` |

### Bridge Layer (`src/lib/bridge/`)

| Module | Responsibility |
|--------|----------------|
| `discovery.ts` | Auto-discover running `language_server` instances via `ps` + `lsof` + filesystem decode |
| `grpc.ts` | gRPC-Web client wrapping all RPC methods (Connect protocol over HTTPS) |
| `statedb.ts` | Read API keys, workspaces, user info from SQLite `state.vscdb` |
| `gateway.ts` | Owner routing — maps each conversation to the correct workspace server |
| `tunnel.ts` | Cloudflare tunnel management for remote access |

### Multi-Server Model

Antigravity runs **one `language_server` per workspace**. Key implications:

- All servers share `.pb` checkpoint files on disk, but each has **isolated in-memory state**
- Messages sent to the wrong server create invisible forks — see PITFALLS.md §1
- **Owner routing must match by workspace URI**, not by stepCount or random selection

## Critical Rules

> 📖 Read `PITFALLS.md` for the full 16 documented pitfalls with root causes and solutions.

1. **Owner routing = workspace matching.** The conversation's `workspaces[].workspaceFolderAbsoluteUri` must match the server's workspace. Never pick by stepCount.
2. **All per-conversation operations** (send, stream, cancel, revert, proceed) must go through `getOwnerConnection()` with a fresh `ownerMap`.
3. **`StreamAgentStateUpdates`** is the only reliable real-time source. Responses are **delta**, not full snapshots — must merge via `indices` array.
4. **Do NOT merge checkpoint + live fork data** — causes UI flicker and duplicate steps.
5. **Use `CancelCascadeInvocation`**, not `CancelCascadeSteps`.
6. **SQLite `state.vscdb`** is an async snapshot (5–15 min delay). Use gRPC for live data; SQLite is a fallback only.
7. **Ghost conversations**: After `StartCascade`, immediately call `UpdateConversationAnnotations` or the 0-step conversation will be filtered out.
8. **Pre-registered owners** (`preRegisteredOwners` Map) prevent `refreshOwnerMap().clear()` from racing with new conversations.

## API Endpoints (Next.js App Router)

All routes are under `src/app/api/`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/servers` | Discovered language_server instances |
| GET | `/api/workspaces` | All known workspaces + playgrounds |
| GET | `/api/me` | Current user info + API key |
| GET | `/api/models` | Available models with display labels + quota |
| GET | `/api/conversations` | List all conversations (gRPC + SQLite + .pb merge) |
| POST | `/api/conversations` | Create new conversation |
| GET | `/api/conversations/:id/steps` | Get conversation steps |
| POST | `/api/conversations/:id/send` | Send message |
| POST | `/api/conversations/:id/cancel` | Cancel AI generation |
| POST | `/api/conversations/:id/revert` | Revert to step |
| POST | `/api/conversations/:id/proceed` | Approve artifact |
| GET | `/api/skills` | List skills (filesystem scan) |
| GET | `/api/workflows` | List workflows |
| GET | `/api/rules` | Custom rules |
| GET | `/api/analytics` | Usage analytics |
| GET | `/api/mcp` | MCP server config |
| WS | `ws://localhost:3000/ws` | Real-time `StreamAgentStateUpdates` |

## Key Reference Docs

| Document | Purpose |
|----------|---------|
| `PITFALLS.md` | 16 documented pitfalls — **read before making changes** |
| `docs/GATEWAY_API.md` | External API reference (for integrators) |
| `docs/API_REFERENCE.md` | Internal gRPC protocol reference |
| `docs/STATE_DB_DATA_MAP.md` | SQLite `state.vscdb` data structure |
| `docs/CDP_REVERSE_ENGINEERING.md` | How to reverse-engineer Antigravity's protocol |
| `docs/REMOTE_ACCESS.md` | Cloudflare tunnel setup for remote access |

## Model IDs

Internal IDs like `MODEL_PLACEHOLDER_M26` map to display names via `GetCascadeModelConfigData`. Always show `label` to users, not raw IDs. The `/api/models` endpoint provides the mapping.

## Development

```bash
npm install && npm run dev
```

- Entry point: `server.ts` (custom server with Next.js + WebSocket)
- Hot reload via `tsx watch` (excludes `data/` directory)
- Requires Antigravity desktop app running with at least one workspace open

## Contributing

When adding or modifying functionality:

- New gRPC methods → update `docs/API_REFERENCE.md`
- New pitfalls discovered → append to `PITFALLS.md`
- API endpoint changes → update `docs/GATEWAY_API.md`
- New API routes go in `src/app/api/[endpoint]/route.ts`
