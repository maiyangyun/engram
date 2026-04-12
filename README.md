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
  ollama pull bge-m3
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
          "embeddingModel": "ollama/bge-m3",
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

Every memory has an `agent_id` — always. Agent A’s memories are invisible to Agent B by default. This happens automatically — Engram reads the agent identity from the session key.

### Visibility Model (v2)

Sharing is controlled by **org/project dimensions**, not by clearing `agent_id`. Every memory always has a creator (`agent_id` is never null). Visibility expands upward through dimensions:

- **Has `project_id` + `org_id`** → visible to all agents that are members of that project
- **Has `org_id` only** → visible to all agents in that organization
- **Neither** → visible only to the creating agent

Agents belong to at least one organization (default: `home`). Projects belong to organizations.

**Manual sharing:** Use `visibility: "shared"` to attach the agent’s default org (making it org-wide visible):
```
memory_add(text="Project deadline is March 15", visibility="shared")
```

**Automatic:** Engram’s LLM extraction automatically infers org/project dimensions from conversation context. Configure known dimensions in `~/.engram/dimensions.json` to guide inference (see [Dimension Configuration](#dimension-configuration)). New orgs/projects discovered by the LLM are auto-registered in `dimensions.json`.

**Backward compatibility:** Legacy records with `agent_id=NULL` (from pre-v0.4) are still visible to all agents, preserving existing shared memories.

### Four-Dimensional Ownership

Every memory carries four parallel ownership dimensions:

| Dimension | What It Represents | Example |
|-----------|-------------------|--------|
| `user_id` | The human identity — personal info shared across all agents | `"soren"` |
| `agent_id` | The agent that created the memory (always set, never null) | `"main"`, `"lion"` |
| `org_id` | Organization scope — expands visibility to org members | `"pumpkin-global"` |
| `project_id` | Project scope — expands visibility to project members | `"engram"`, `"bonbon"` |

These dimensions are **parallel, not hierarchical**. A search matches memories where all specified dimensions align — unspecified dimensions are treated as wildcards.

For example, searching with `orgId="pumpkin-global"` returns all memories in that org regardless of project. Adding `projectId="engram"` narrows it further. Memories without org/project dimensions are private to the creating agent.

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
- `visibility` — `agent` (private, default) or `shared` (attaches default org_id, making it visible to org members)
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
| `embeddingModel` | `ollama/bge-m3` | Embedding model |
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

The LLM uses these known dimensions to automatically infer `org_id` and `project_id` during memory extraction. No manual tagging needed — just configure your orgs and projects once, and Engram figures out where each memory belongs. New dimensions discovered by the LLM are auto-registered here.

---

## Tech Stack

- **Storage:** SQLite with WAL mode (crash-safe, concurrent reads)
- **Embeddings:** Ollama + bge-m3 (1024-dim, local, excellent CJK support)
- **Extraction:** Ollama + qwen3.5:9b (local LLM) or Gemini API (cloud option)
- **Runtime:** Node.js, TypeScript, tsup
- **Framework:** OpenClaw plugin SDK

Local-first by default. Gemini API available as an optional cloud extraction provider.

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

### v0.4.0 (2026-04-13)

**v2 Visibility Model (breaking):**
- `agent_id` is now **always set** — every memory has an explicit creator. Sharing no longer works by setting `agent_id=null`
- Visibility expands through `org_id`/`project_id` dimensions: project+org → project members; org only → org members; neither → agent-private
- Agents belong to at least one organization (default: `home`); projects belong to organizations
- Backward compatible with legacy `agent_id=NULL` records from earlier versions

**New Features:**
- **Memory decay** — `last_recalled_at` tracking with time-weighted scoring (`DECAY_RATE=0.03`, `DECAY_FLOOR=0.1`). Frequently recalled memories stay relevant; forgotten ones fade
- **Noise filtering** — skips greetings, system mechanism chatter, and trivial replies during capture
- **Ollama global queue** — serializes all Ollama requests through a single queue, preventing model-switching thrash
- **Gemini API provider** — cloud-based extraction alternative to local Ollama
- **dimensions.json auto-discovery** — new orgs/projects found by LLM extraction are automatically registered
- **Context pressure tracking** — proactively triggers full capture under high context load
- **Emergency capture** — SIGTERM/SIGUSR1/SIGUSR2 signals save pending memories synchronously
- **Capture queue** — serialized with independent timeouts, isolated from main conversation abort signals
- **Fast-path keyword dimension inference** — infers org/project from keywords without LLM calls
- **Salvage capture** — preserves content when LLM or embedding fails

**Improvements:**
- Embedding model upgraded to `bge-m3` — significantly better Chinese search quality
- `searchWithVisibility` rewritten for v2 visibility model
- Extraction prompt: language preservation + agent membership injection for better dimension inference
- Configurable search threshold (default 0.5, removed hardcoded 0.6 floor)

**Breaking Changes:**
- `agent_id` is never null in new records. Shared visibility is determined by `org_id`/`project_id` presence
- `searchWithVisibility()` rewritten for v2 dimension-based visibility

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
- [x] Memory importance decay over time ✅
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
