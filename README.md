[English](README.md) | [繁體中文](README.zh-TW.md)

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

**Automatic:** Engram's LLM extraction automatically infers org/project dimensions from conversation context. Configure known dimensions in `~/.engram/dimensions.json` to guide inference (see [Dimension Configuration](#dimension-configuration)).

### Four-Dimensional Ownership

Every memory carries four parallel ownership dimensions:

| Dimension | What It Represents | Example |
|-----------|-------------------|---------|
| `user_id` | The human identity — personal info shared across all agents | `"soren"` |
| `agent_id` | The agent that created/owns the memory | `"main"`, `null` (shared) |
| `org_id` | Organization scope | `"pumpkin-global"` |
| `project_id` | Project scope | `"engram"`, `"bonbon"` |

These dimensions are **parallel, not hierarchical**. A search matches memories where all specified dimensions align — unspecified dimensions are treated as wildcards. This replaces the old five-layer visibility stack with a simpler, more flexible model.

For example, searching with `orgId="pumpkin-global"` returns all memories in that org regardless of project. Adding `projectId="engram"` narrows it further. Agent-private memories (`agent_id` set) are only visible to that agent; shared memories (`agent_id=null`) are visible to everyone.

---

## Tools Reference

Engram registers six tools, compatible with the OpenClaw memory interface:

| Tool | Description |
|------|-------------|
| `memory_search` | Vector search with four-dimensional filtering and visibility merge |
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
| `extractionModel` | `ollama/qwen3.5:9b` | LLM for fact extraction |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama API endpoint |
| `dbPath` | `~/.engram/engram.db` | SQLite database path |
| `searchThreshold` | `0.5` | Minimum similarity score (0-1) |
| `topK` | `10` | Max memories per search |

### Dimension Configuration (~/.engram/dimensions.json)

```json
{
  "knownOrgs": [
    { "id": "pumpkin-global", "aliases": ["pumpkin", "PGL"] }
  ],
  "knownProjects": [
    { "id": "engram", "aliases": ["memory system"] },
    { "id": "bonbon", "aliases": ["dating app"] }
  ]
}
```

The LLM uses these known dimensions to automatically infer `org_id` and `project_id` during memory extraction. No manual tagging needed — just configure your orgs and projects once, and Engram figures out where each memory belongs.

---

## Tech Stack

- **Storage:** SQLite with WAL mode (crash-safe, concurrent reads)
- **Embeddings:** Ollama + nomic-embed-text (768-dim, local)
- **Extraction:** Ollama + qwen3.5:9b (local LLM, no cloud calls)
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

### v0.3 (2026-04-11)

**New Features:**
- **Four-dimensional ownership** — memories now carry `user_id`, `agent_id`, `org_id`, `project_id` with parallel dimension matching (replaces the old five-layer visibility hierarchy)
- **Automatic dimension inference** — LLM extracts org/project dimensions from conversation context using configurable known dimensions (`dimensions.json`)
- **Memory deduplication** — cosine similarity threshold (0.92) detects near-duplicate memories and updates existing ones instead of inserting duplicates. `memory_add` returns `dedupAction: "added" | "updated"`
- **Context pressure capture** — proactively triggers full memory extraction when conversation grows long (30+ messages or 80K+ characters), preventing data loss from context overflow

**Resilience (crash/failure protection):**
- **Failed turn salvage** — `success=false` turns no longer skip capture; a fast-path salvage preserves the last 6 messages
- **LLM failure fallback** — if extraction or embedding fails (timeout/abort), automatically degrades to fast-path capture instead of losing data
- **Emergency signal capture** — SIGTERM/SIGUSR1/SIGUSR2 triggers synchronous SQLite write of pending capture data (no embedding, but content is preserved)
- **Capture queue serialization** — all captures run through a serial queue with independent 60s timeouts, isolated from main conversation abort signals

**Improvements:**
- Extraction model upgraded to `qwen3.5:9b` (better multilingual support)
- Extraction prompt rewritten with language-following rule at highest priority (Chinese conversations produce Chinese memories)
- Search threshold respects config value (default 0.5) instead of hardcoded 0.6 floor — fixes poor Chinese recall
- Fast-path captures include lightweight keyword matching for shared detection (`inferSharedFromKeywords`)
- Parallel dimension search via single SQL query (replaces sequential five-layer scan)

**Breaking Changes:**
- `shared-rules.json` keyword-based sharing replaced by `dimensions.json` with `knownOrgs`/`knownProjects` — LLM handles dimension assignment automatically
- `searchWithVisibility()` API changed: flat dimension filter instead of layer-based hierarchy
- `store.add()` now returns `AddMemoryResult` with `dedupAction` field

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

- [x] Project-scoped sharing (shared within a project, not globally) ✅
- [x] Memory deduplication ✅
- [x] Multilingual extraction ✅
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
