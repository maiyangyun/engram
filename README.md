# Engram

Enterprise-grade multi-agent collaborative memory system for [OpenClaw](https://github.com/openclaw/openclaw).

Zero cloud cost. Fully local. Built on SQLite + Ollama.

## Why Engram?

Most AI memory solutions rely on cloud APIs with opaque data handling. Engram keeps everything on your machine:

- **SQLite** for persistent storage (WAL mode — crash-safe)
- **Ollama** for local embeddings (`nomic-embed-text`) and LLM extraction (`qwen3:8b`)
- **Zero API calls** to external memory services

## Features

- **Five-dimensional ownership** — `user_id`, `agent_id`, `org_id`, `project_id`, `run_id` on every memory
- **Five-layer visibility** — memories merge from personal → agent → org → project → shared scopes
- **Three memory types** — `semantic` (facts), `episodic` (events), `procedural` (how-to)
- **Cross-channel capture** — works across webchat, Feishu, Telegram, Discord, etc.
- **autoCapture** — automatically extracts facts from conversations via local LLM
- **autoRecall** — injects relevant memories into context before each response
- **Fast-capture path** — short conversations skip LLM, embed directly for near-zero latency
- **Full CRUD** — `memory_add`, `memory_search`, `memory_get`, `memory_list`, `memory_update`, `memory_delete`

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) `>= 2026.3.24-beta.2`
- [Ollama](https://ollama.com) running locally with:
  - `ollama pull nomic-embed-text`
  - `ollama pull qwen3:8b` (or any extraction model)

## Install

```bash
# Clone
git clone https://github.com/anthropic-lab/engram.git
cd engram

# Install & build
npm install
npm run build

# Link to OpenClaw
ln -s "$(pwd)" ~/.openclaw/extensions/engram
```

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/engram/dist/index.js"]
    },
    "slots": {
      "memory": "engram"
    },
    "entries": {
      "engram": {
        "enabled": true,
        "config": {
          "userId": "your_user_id",
          "defaultOrgId": "home",
          "ollamaBaseUrl": "http://localhost:11434",
          "embeddingModel": "ollama/nomic-embed-text",
          "extractionModel": "ollama/qwen3:8b",
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

## Architecture

```
User message → autoRecall (vector search → inject context)
                                ↓
                          Agent responds
                                ↓
                    autoCapture (agent_end hook)
                                ↓
              ┌─────────────────┴─────────────────┐
              │ short (<200 chars)                 │ long (≥200 chars)
              │ fast-capture: embed → store        │ LLM extraction → embed → store
              └───────────────────────────────────┘
                                ↓
                     SQLite (WAL mode)
```

## Memory Visibility

Memories are scoped by five dimensions and merged in layers:

| Layer | Scope | Example |
|-------|-------|---------|
| 1 | `user_id` only (shared) | Facts visible to all agents |
| 2 | `+ agent_id` | Agent-specific knowledge |
| 3 | `+ org_id` | Organization context |
| 4 | `+ project_id` | Project-scoped memories |
| 5 | `+ run_id` | Single-run ephemeral data |

An agent sees all memories from its layer and above. Agent A cannot see Agent B's memories.

## Part of Cortex

Engram is one of three products under the **Cortex** umbrella:

- **Imprint** — Build expert-level agents from profile documents
- **Engram** — Multi-agent collaborative memory (this project)
- **Synapse** — Agent-first human-agent collaboration workspace

## License

MIT
