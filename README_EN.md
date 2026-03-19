# Antigravity Gateway

> **Turn [Antigravity](https://antigravity.dev) into a headless API server** — unlocking remote access, subagent integration, and automated AI workflows, all powered by your existing Antigravity subscription.

<p align="center">
  <img src="https://img.shields.io/badge/Antigravity-Gateway-6366f1?style=for-the-badge" alt="Antigravity Gateway" />
  <img src="https://img.shields.io/badge/TypeScript-Node.js-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Next.js_16-React_19-000?style=for-the-badge&logo=next.js" alt="Next.js" />
</p>

**[中文文档 →](README.md)**

---

## 💡 Three Goals

Antigravity is a powerful AI coding agent from Google DeepMind — but it's locked inside a desktop IDE. This project has three ambitions:

### 1. 🔓 Free Use — Use Antigravity Anywhere

Break free from the desktop. Access your AI coding agent from any device — phone, tablet, another laptop, or a headless server. The full-featured web UI runs in any browser.

### 2. 🤖 Subagent Mode — Let Other Tools Use Antigravity

Expose Antigravity as a standard REST + WebSocket API. Any tool, script, or automation platform (n8n, Make, Zapier, cron) can create conversations, send prompts, and consume AI responses programmatically.

### 3. ⚡ Workflow Anywhere — Execute Custom Workflows On-Demand

Trigger any Antigravity Skill or Workflow from the command line. Run the same AI pipelines you use in the IDE — topic discovery, content generation, code reviews — headlessly, on schedule, or from CI/CD.

```bash
# Example: trigger a workflow from the terminal
python3 scripts/call_workflow.py   # → creates conversation, runs /ai-topic-discovery, prints results
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| 🌐 **Remote Web UI** | Full chat interface with Markdown rendering, tool cards, model selector, Stop/Revert/Proceed |
| 🤖 **REST API** | 17 endpoints covering conversations, models, skills, workflows, rules, analytics |
| ⚡ **Real-time WebSocket** | StreamAgentStateUpdates proxied as JSON — subscribe and get AI responses in real-time |
| 🔍 **Auto-Discovery** | Zero config. Automatically finds all running language_server instances via `ps`+`lsof` |
| 🔀 **Smart Routing** | Routes each conversation to the correct workspace-matching server (not random) |
| 📱 **Mobile-First** | Built with shadcn/ui + Tailwind CSS 4, responsive from phone to desktop |
| 🎯 **Skill/Workflow Support** | `@skill-name` and `/workflow-name` autocomplete in the chat input |

---

## Architecture

```
┌───────────────────────────────────────────────────┐
│       Your Browser / cURL / Python / CI/CD        │
│         (phone, tablet, laptop, server)           │
└──────────────┬────────────────────────────────────┘
               │ HTTP :3000 + WebSocket /ws
               ▼
┌──────────────────────────────────────────────────┐
│           Antigravity Gateway (Single Port)       │
│  ┌─────────────────────────────────────────────┐ │
│  │         Next.js 16 + Custom Server          │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │ │
│  │  │ React UI │  │ API Routes│  │WebSocket │  │ │
│  │  │ (SSR)    │  │ (REST)   │  │(ws proxy)│  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  │ │
│  │              Bridge Layer                    │ │
│  │  discovery.ts — process scan + fs decode     │ │
│  │  statedb.ts   — SQLite read (state.vscdb)    │ │
│  │  grpc.ts      — gRPC-Web client (HTTPS)      │ │
│  │  gateway.ts   — owner routing + connection    │ │
│  └──────────────────┬──────────────────────────┘ │
└─────────────────────┼────────────────────────────┘
                      │ gRPC-Web (HTTPS, 127.0.0.1)
                      ▼
┌──────────────────────────────────────────────────┐
│      Antigravity Language Server(s)               │
│   (one per workspace, auto-discovered via ps)     │
│   Shared .pb files, isolated in-memory state      │
└──────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- **Antigravity** desktop app installed and running (at least one workspace open)
- **Node.js** ≥ 20

### Install & Run

```bash
git clone https://github.com/pikapikaspeedup/Antigravity-Mobility-CLI.git
cd Antigravity-Mobility-CLI

npm install
npm run dev
```

That's it! Open `http://localhost:3000` in any browser.

> For remote access from other devices on your network, use `http://<your-ip>:3000`.

### Verify

```bash
# Check discovered servers
curl http://localhost:3000/api/servers

# Check user info
curl http://localhost:3000/api/me

# List available models
curl http://localhost:3000/api/models | jq '.clientModelConfigs[] | {label, model: .modelOrAlias.model}'
```

---

## API at a Glance

Full documentation: **[docs/GATEWAY_API.md](docs/GATEWAY_API.md)**

### Conversations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/conversations` | List all conversations (gRPC + SQLite + .pb merge) |
| `POST` | `/api/conversations` | Create new. Body: `{"workspace": "file:///path"}` |
| `POST` | `/api/conversations/:id/send` | Send message. Body: `{"text": "...", "model": "MODEL_ID"}` |
| `GET` | `/api/conversations/:id/steps` | Get all steps (checkpoint) |
| `POST` | `/api/conversations/:id/cancel` | Stop AI generation |
| `POST` | `/api/conversations/:id/proceed` | Approve and continue |
| `POST` | `/api/conversations/:id/revert` | Revert to step N |

### Environment

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/servers` | Running language_server instances |
| `GET` | `/api/workspaces` | All known workspaces + playgrounds |
| `POST` | `/api/workspaces/launch` | Open workspace in Antigravity (async) |
| `POST` | `/api/workspaces/close` | Hide workspace from sidebar (server stays running) |
| `DELETE` | `/api/workspaces/close` | Unhide workspace (show again) |
| `GET` | `/api/me` | User info |
| `GET` | `/api/models` | Available models with quotas |
| `GET` | `/api/skills` | All skills (global + workspace) |
| `GET` | `/api/workflows` | All workflows |
| `GET` | `/api/rules` | Custom rules |
| `GET` | `/api/analytics` | Usage analytics |
| `GET` | `/api/mcp` | MCP server config |

### WebSocket

```bash
# Connect and subscribe
wscat -c ws://localhost:3000/ws
> {"type": "subscribe", "cascadeId": "conversation-uuid"}
# ← {"type": "steps", "cascadeId": "...", "data": {"steps": [...], "status": "CASCADE_RUN_STATUS_RUNNING"}}
```

### Available Models

| Internal ID | Display Name |
|-------------|-------------|
| `MODEL_PLACEHOLDER_M37` | Gemini 3.1 Pro (High) |
| `MODEL_PLACEHOLDER_M36` | Gemini 3.1 Pro (Low) |
| `MODEL_PLACEHOLDER_M47` | Gemini 3 Flash |
| `MODEL_PLACEHOLDER_M35` | Claude Sonnet 4.6 (Thinking) |
| `MODEL_PLACEHOLDER_M26` | Claude Opus 4.6 (Thinking) |
| `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` | GPT-OSS 120B (Medium) |

---

## Quick Examples

### One-Liner: Ask a Question

```bash
CID=$(curl -sX POST http://localhost:3000/api/conversations \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"file:///Users/you/project"}' | jq -r .cascadeId) && \
curl -sX POST "http://localhost:3000/api/conversations/$CID/send" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Explain the architecture of this project"}' && \
sleep 15 && \
curl -s "http://localhost:3000/api/conversations/$CID/steps" | \
  jq -r '[.steps[] | select(.plannerResponse)] | last | .plannerResponse.modifiedResponse'
```

### Python: Full Conversation

```python
import requests, time

BASE = "http://localhost:3000"

# Create conversation
cid = requests.post(f"{BASE}/api/conversations",
    json={"workspace": "file:///path/to/your/project"}).json()["cascadeId"]

# Send message
requests.post(f"{BASE}/api/conversations/{cid}/send",
    json={"text": "Review this codebase", "model": "MODEL_PLACEHOLDER_M26"})

# Wait and get result
time.sleep(20)
steps = requests.get(f"{BASE}/api/conversations/{cid}/steps").json()["steps"]
ai_reply = [s for s in steps if s.get("plannerResponse")][-1]
print(ai_reply["plannerResponse"]["modifiedResponse"])
```

### Trigger a Workflow

```bash
python3 scripts/call_workflow.py
# Creates conversation → sends /ai-topic-discovery → monitors progress → prints results
```

---

## Project Structure

```
Antigravity-Mobility-CLI/
├── server.ts                     # Custom server: Next.js + WebSocket on single port
├── src/app/
│   ├── page.tsx                  # Main chat page
│   └── api/                      # 17 REST API route handlers
│       ├── conversations/        # CRUD + send/cancel/revert/proceed
│       ├── models/               # Model listing with quotas
│       ├── skills/               # Skill discovery
│       └── ...
├── src/lib/bridge/               # Core bridge to Antigravity
│   ├── discovery.ts              # Auto-discover language_servers (ps + lsof + fs decode)
│   ├── grpc.ts                   # gRPC-Web client for all RPC methods
│   ├── statedb.ts                # Read API keys, workspaces from SQLite
│   └── gateway.ts                # Owner routing, connection management
├── scripts/
│   └── call_workflow.py          # Example: headless workflow execution
├── docs/                         # 📚 Technical documentation
│   ├── GATEWAY_API.md            # External API reference (for CLI/integration)
│   ├── API_REFERENCE.md          # Internal gRPC protocol reference
│   ├── STATE_DB_DATA_MAP.md      # SQLite state.vscdb data structure
│   ├── CDP_REVERSE_ENGINEERING.md # How to reverse-engineer Antigravity
│   └── GAP_ANALYSIS.md           # Feature coverage vs native Agent Manager
├── PITFALLS.md                   # 🚧 17 documented pitfalls & solutions
└── package.json
```

---

## Documentation

| Document | Description |
|----------|-------------|
| **[docs/GATEWAY_API.md](docs/GATEWAY_API.md)** | 📘 **External API docs** — Every endpoint with request/response schemas, model table, step types, and integration examples (Python, Shell, Node.js) |
| **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)** | 🔧 **Internal gRPC reference** — All reverse-engineered `LanguageServerService` RPC methods, streaming protocol details, step data architecture |
| **[docs/STATE_DB_DATA_MAP.md](docs/STATE_DB_DATA_MAP.md)** | 🗄️ **SQLite data map** — What's stored in `state.vscdb`, which keys matter, what's stale vs real-time |
| **[docs/CDP_REVERSE_ENGINEERING.md](docs/CDP_REVERSE_ENGINEERING.md)** | 🔍 **Reverse engineering guide** — How to use Chrome DevTools Protocol to capture and decode Antigravity's internal gRPC traffic |
| **[docs/GAP_ANALYSIS.md](docs/GAP_ANALYSIS.md)** | 📊 **Feature gap analysis** — 15 implemented step types, 8 skippable types, missing interaction capabilities |
| **[PITFALLS.md](PITFALLS.md)** | 🚧 **Pitfalls & lessons** — 17 hard-won lessons: multi-server routing, delta merging, workspace_id decoding, ghost conversations, Agent Manager visibility, and more |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Next.js 16 (custom server), WebSocket (ws), TypeScript |
| **Frontend** | React 19, shadcn/ui, Tailwind CSS 4, Lucide Icons, Marked |
| **Bridge** | gRPC-Web over HTTPS, SQLite (better-sqlite3), process discovery (ps + lsof) |
| **Protocol** | Reverse-engineered `exa.language_server_pb.LanguageServerService` |

## 💡 Core Use Cases

Antigravity Gateway is more than a UI—it's a bridge to embed AI capabilities seamlessly into your workflow:

<p align="center">
  <img src="docs/assets/mobile_coding.png" width="45%" alt="Mobile Coding Concept" />
  &nbsp; &nbsp; &nbsp;
  <img src="docs/assets/api_automation.png" width="45%" alt="API Automation Concept" />
</p>

- 📱 **Mobile Coding**: Open the Web UI on your phone or tablet's browser, connect to Antigravity on your computer via the local network, and do code reviews or architecture planning on the couch.
- 🤖 **AI for your AI (Subagent Mode)**: Use the REST API to let n8n, Make, or your custom Python scripts hit Antigravity's capabilities directly.
- 🔄 **Automated Review & Docs (Cron Jobs)**: Hook it up to CI/CD or night crons to process repos, generate reviews, or write documentation automatically.
- 🤝 **Pair Programming**: Share `http://<your-lan-ip>:3000` with a colleague in the office. Both of you can watch the AI's thought process in real-time on your own screens.

---

## 📱 Mobile Setup (Hands-on)

The Gateway features a fully responsive design (built with shadcn/ui + Tailwind CSS). To use Antigravity on your phone or tablet:

1. **Same Network**: Ensure your phone and the computer running the Gateway are on the same Wi-Fi network.
2. **Find Your IP**:
   - Mac: Systems Settings -> Wi-Fi -> details to find your IP (e.g., `192.168.x.x`).
   - Or via terminal: `ipconfig getifaddr en0`.
3. **Start the Gateway**: Run `npm run dev` on your computer (Next.js allows local network access by default).
4. **Access on Mobile**: Open Safari or Chrome on your phone and go to `http://192.168.x.x:3000`.
5. **Start Chatting**: Select a workspace you already have open in Antigravity on your desktop (or use Playground), and enjoy your full-featured AI coding assistant on mobile!

---

## Known Limitations

| Limitation | Description |
|------------|-------------|
| 🔒 **Agent Manager visibility** | Conversations created via Gateway are **not visible** in Agent Manager's sidebar. Root cause: Agent Manager tracks conversations through an internal IPC mechanism (`UnifiedStateSync`) that external gRPC calls cannot reach. Both sides share the same `.pb` files and language servers — conversations are functionally identical and interoperable, but each side maintains its own conversation list. See [PITFALLS.md §16](PITFALLS.md) for full investigation details. |
| 🔄 **Protocol stability** | The gRPC API was reverse-engineered and may break with Antigravity updates. |

## Important Notes

- ⚠️ **Requires a running Antigravity desktop app** — this bridges to local language servers, not a cloud API.
- 🔒 **All traffic stays local** — the gateway connects to `127.0.0.1` only. No data leaves your machine.
- 🔄 **Protocol may change** — the gRPC API was reverse-engineered and may break with Antigravity updates.
- 📖 **Read [PITFALLS.md](PITFALLS.md)** — 17 hard-won lessons that will save you hours of debugging.

## 💬 Community & Support

Join our community to share workflows, report bugs, or discuss how to integrate Antigravity into your own tools:

<p align="left">
  <img src="docs/assets/group.jpg" width="250" alt="WeChat Group QR Code" />
</p>

**🎉 Welcome to: Antigravity CLI 交流使用群 (WeChat)**

_(If you have great ideas for automation or are stuck with headless development, feel free to join and discuss!)_

---

## Contributing

PRs welcome! If you discover new gRPC endpoints or fix routing issues, please update the relevant docs:
- New API methods → `docs/API_REFERENCE.md`
- New pitfalls → `PITFALLS.md`
- External API changes → `docs/GATEWAY_API.md`

## Disclaimer

This is an **unofficial, community-driven** open-source tool built for educational and interoperability purposes.
- This project **does not** bypass paywalls, crack authentication, or enable API abuse.
- Running this project **strictly requires** a valid, authenticated installation of the official Antigravity desktop app on the user's machine.
- All AI processing consumes the user's own legal quotas.
- This project is **not affiliated with, endorsed by, or authorized by Google DeepMind**. The "Antigravity" trademark belongs to its respective owners.
- The internal gRPC API was reverse-engineered and may break at any time. **Use at your own risk**. The authors are not responsible for any potential account risks or data loss incurred by using this tool.

## License

MIT

---

<p align="center">
  <sub>Built with curiosity and reverse engineering. Not affiliated with Google DeepMind.</sub>
</p>
