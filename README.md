# Engram 🧠

**Give your AI agents memory. Real memory.**

Engram is a collaborative memory system that lets multiple AI agents remember, learn, and share knowledge — all running locally on your machine. No cloud APIs. No data leaving your network. Just SQLite, Ollama, and a simple plugin.

Built for [OpenClaw](https://github.com/openclaw/openclaw). Part of the [Cortex](https://github.com/maiyangyun/engram#part-of-cortex) family.

---

## What Can Engram Do?

**For a single agent:**
- Automatically remember what users tell you and what you decide
- Recall relevant memories before every response — no manual lookup needed
- Build up expertise over time, across conversations, across channels

**For multiple agents:**
- Share a single memory database across all your agents
- Each agent has private memories invisible to others
- Shared memories flow automatically to everyone who needs them
- One agent learns something? Others can benefit immediately

**For you (the human):**
- Your agents stop asking the same questions twice
- Project decisions persist across sessions
- Switch channels (webchat → Feishu → Telegram) without losing context

---

## Quick Start

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) `>= 2026.3.24`
- [Ollama](https://ollama.com) running locally:
  ```bash
  ollama pull nomic-embed-text
  ollama pull qwen3:8b
  ```

### Install

```bash
git clone https://github.com/maiyangyun/engram.git
cd engram
npm install && npm run build
ln -s "$(pwd)" ~/.openclaw/extensions/engram
```

### Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["~/.openclaw/extensions/engram"] },
    "slots": { "memory": "engram" },
    "entries": {
      "engram": {
        "enabled": true,
        "config": {
          "userId": "your_user_id",
          "autoRecall": true,
          "autoCapture": true,
          "ollamaBaseUrl": "http://localhost:11434",
          "embeddingModel": "ollama/nomic-embed-text",
          "extractionModel": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

```bash
openclaw gateway restart
```

That's it. Your agents now have memory.

---

## How It Works

```
User speaks → autoRecall searches memories → injects relevant context
                                ↓
                          Agent responds
                                ↓
                    autoCapture fires (agent_end hook)
                                ↓
              ┌─────────────────┴─────────────────┐
              │ short (<500 chars)                 │ long (≥500 chars)
              │ embed directly → store             │ LLM extracts facts → embed → store
              └───────────────────────────────────┘
                                ↓
                     SQLite (WAL mode, crash-safe)
```

### What Gets Remembered

Engram captures both sides of the conversation:
- **What users say** — preferences, facts, requests, context
- **What agents decide** — analysis, recommendations, commitments, plans

Each memory is tagged with a `source_role` (`user`, `assistant`, or `both`) so you always know where knowledge came from.

### Memory Types

| Type | What It Stores | Example |
|------|---------------|---------|
| `semantic` | Stable facts, knowledge, preferences | "User prefers PostgreSQL" |
| `episodic` | Events, incidents, time-bound things | "Deployed v2.1 on 2026-04-09" |
| `procedural` | Processes, decisions, how-to knowledge | "Always run migrations before deploying" |

---

## Multi-Agent Memory

This is where Engram gets interesting.

### Isolation

Every memory has an `agent_id`. Agent A's memories are invisible to Agent B. This happens automatically — Engram reads the agent identity from the session key.

### Shared Memories

Some knowledge should be visible to everyone. Two ways to share:

**Manual:** Use `visibility: "shared"` when adding a memory:
```
memory_add(text="Project deadline is March 15", visibility="shared")
```

**Automatic:** Configure keywords in `~/.engram/shared-rules.json`:
```json
{
  "sharedKeywords": ["bonbon", "engram", "project-x"]
}
```

Any auto-captured memory containing these keywords is automatically promoted to shared visibility. Think of it as: **keywords = auto-promotion rules** that decide whether a memory stays in one agent's notebook or goes on the team bulletin board.

### Five-Layer Visibility

Memories merge from broad to specific:

| Layer | Scope | Who Sees It |
|-------|-------|-------------|
| 1 | Shared (`agent_id=null`) | All agents |
| 2 | Agent-specific | Only that agent |
| 3 | + Organization | Org-scoped agents |
| 4 | + Project | Project-scoped agents |
| 5 | + Run | Single conversation only |

---

## Tools Reference

Engram registers six tools, compatible with the OpenClaw memory interface:

| Tool | Description |
|------|-------------|
| `memory_search` | Vector search with five-dimensional filtering and visibility merge |
| `memory_add` | Store memories with type classification and visibility control |
| `memory_get` | Retrieve a specific memory by ID |
| `memory_list` | List memories with optional filters |
| `memory_update` | Update a memory's content (re-embeds automatically) |
| `memory_delete` | Delete by ID or bulk delete with safety confirmation |

### Key Parameters

**`memory_add`:**
- `text` / `facts` — what to remember
- `memory_type` — `semantic`, `episodic`, or `procedural` (default: `semantic`)
- `visibility` — `agent` (private, default) or `shared` (all agents)
- `agentId`, `orgId`, `projectId` — ownership dimensions

**`memory_search`:**
- `query` — natural language search
- `scope` — `personal` (agent only), `shared` (shared only), `all` (merged, default)
- `agentId`, `orgId`, `projectId` — filters
- `memory_type` — filter by type

---

## Configuration

### Plugin Config (openclaw.json)

| Field | Default | Description |
|-------|---------|-------------|
| `userId` | `"default"` | Root user ID for scoping |
| `defaultOrgId` | `null` | Default organization |
| `defaultProjectId` | `null` | Default project |
| `autoCapture` | `true` | Auto-extract memories from conversations |
| `autoRecall` | `true` | Auto-inject memories into context |
| `embeddingModel` | `ollama/nomic-embed-text` | Embedding model |
| `extractionModel` | `ollama/qwen3:8b` | LLM for fact extraction |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama API endpoint |
| `dbPath` | `~/.engram/engram.db` | SQLite database path |
| `searchThreshold` | `0.5` | Minimum similarity score (0-1) |
| `topK` | `10` | Max memories per search |

### Shared Rules (~/.engram/shared-rules.json)

```json
{
  "sharedKeywords": ["project-name", "team-term", "product-name"]
}
```

---

## Tech Stack

- **Storage:** SQLite with WAL mode (crash-safe, concurrent reads)
- **Embeddings:** Ollama + nomic-embed-text (768-dim, local)
- **Extraction:** Ollama + qwen3:8b (local LLM, no cloud calls)
- **Runtime:** Node.js, TypeScript, tsup
- **Framework:** OpenClaw plugin SDK

Zero external API calls. Zero cloud cost. Your data stays yours.

---

## Part of Cortex

Engram is one of three products under the **Cortex** umbrella — tools for making AI agents truly capable team members:

| Product | Purpose |
|---------|---------|
| **Imprint** | Build expert-level agents from structured profile documents. *Helps agents know who they are.* |
| **Engram** | Multi-agent collaborative memory system. *Helps agents accumulate and share experience.* |
| **Synapse** | Agent-first human-agent collaboration workspace. *Helps agents work alongside humans.* |

**Imprint → Engram → Synapse**: Identity → Memory → Collaboration.

---

## Changelog

### v0.2 (2026-04-10)

**New Features:**
- **Bidirectional autoCapture** — now remembers both user input AND agent responses (decisions, analysis, recommendations). Each memory tagged with `source_role: user|assistant|both`
- **Multi-agent support** — multiple agents share one database with automatic identity isolation via session keys
- **Shared memory** — `visibility: "shared"` parameter on `memory_add`, plus keyword-based auto-promotion via `shared-rules.json`

**Improvements:**
- autoRecall timeout increased from 8s to 15s (handles Ollama cold starts)
- Fast-capture threshold raised from 200 to 500 characters (reduces unnecessary LLM calls)
- Plugin config schema declared for OpenClaw UI compatibility

### v0.1 (2026-04-09)

- Initial release
- Five-dimensional ownership, five-layer visibility, three memory types
- autoCapture + autoRecall pipelines
- SQLite WAL storage, Ollama embeddings + extraction
- Cross-channel memory (webchat, Feishu, etc.)

---

## Roadmap

- [ ] Project-scoped sharing (shared within a project, not globally)
- [ ] Memory deduplication
- [ ] Multilingual extraction (currently defaults to English output)
- [ ] Embedding cache for faster recall under concurrency
- [ ] Memory importance decay over time
- [ ] Web dashboard for memory inspection

---

## Get in Touch

Engram is built by **Ben** (AI) and **Soren** (human) as part of the Cortex project at Pumpkin Global Limited.

- **GitHub Issues:** [github.com/maiyangyun/engram/issues](https://github.com/maiyangyun/engram/issues)
- **Discord:** [OpenClaw Community](https://discord.com/invite/clawd)
- **Email:** maiyangyun@gmail.com

If you're building multi-agent systems and want your agents to actually *remember* — give Engram a try. We'd love to hear how it works for you.

---

## License

MIT
