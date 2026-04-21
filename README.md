[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

# Engram 🧠

**Your AI agents forget everything after each conversation. Engram fixes that.**

Engram gives your [OpenClaw](https://github.com/openclaw/openclaw) agents persistent memory — they remember what you've told them, what they've decided, and what they've learned, across every session and every channel. Multiple agents can even share knowledge with each other, automatically.

Everything runs locally on your machine. No cloud APIs. No data leaving your network. Part of the [Cortex](https://github.com/maiyangyun/engram#part-of-cortex) family.

---

## The Problem

AI agents are goldfish. Every conversation starts from zero.

You tell your agent you prefer PostgreSQL over MySQL. Next session, it suggests MySQL. You spend twenty minutes walking an agent through your deployment process. Tomorrow, it has no idea how you deploy. You make a critical architecture decision together — the reasoning, the tradeoffs, the conclusion — all gone the moment the conversation ends.

It gets worse with multiple agents. You have three agents working on different parts of your project. One of them learns something important — say, that the staging server moved to a new IP. The other two? Clueless. You end up being the messenger between your own agents, repeating yourself over and over.

This isn't a minor inconvenience. It fundamentally limits what agents can do. Without memory, every agent is a perpetual beginner.

---

## Why We Built Engram

OpenClaw already has memory capabilities — and they work. You can set `dmScope` to share conversation context across channels, and agents can write notes to Markdown files like `memory/YYYY-MM-DD.md`. For simple setups, that’s often enough.

But as we started running multiple agents on real projects, we hit walls.

**The token problem.** Sharing full conversation context across channels means your agent remembers everything — but at the cost of sending the entire history with every message. Token costs climb fast. What you really want is selective recall: only the relevant bits, injected precisely when needed.

**The “remember to remember” problem.** Markdown logging works, but it depends on someone — you or the agent — actively deciding to write things down. In practice, important decisions slip through. The agent makes a great architecture recommendation, you both move on, and nobody records it. Next week, it’s gone. Memory shouldn’t require manual effort. Agents should decide what’s worth remembering on their own.

**The multi-agent gap.** When you have multiple agents, the problem multiplies. Agent A learns your deployment process. Agent B has no idea. There’s no built-in way for agents to share knowledge while keeping their private memories separate.

We looked at existing solutions. [Mem0](https://github.com/mem0ai/mem0) was the most promising — a well-designed memory layer with LLM-powered extraction. We tried the OpenClaw plugin, learned a lot from it, and respect the work. But it didn’t quite fit our needs:

- **Cloud dependency.** Mem0’s platform sends your data to their servers. For teams working with sensitive project information, that’s a dealbreaker.
- **Single-agent focus.** Mem0 is built around one user and one agent. It doesn’t have a concept of organizations, projects, or multi-agent visibility rules.
- **Limited recall control.** We needed fine-grained control over what gets recalled and when — score thresholds, smart truncation, short-message handling — to keep token costs down without losing important context.

So we built Engram. It runs entirely on your machine, supports multiple agents with proper isolation and sharing, and handles memory automatically — capture, recall, dedup, all without you having to think about it.

We’re still iterating. Engram is young, and there’s plenty to improve. But it already solves the problems that drove us to build it, and we use it every day.

---

## What Engram Does

Engram runs quietly in the background and handles memory for you:

- **Agents remember.** Preferences, decisions, project context, technical details — once discussed, it sticks. Your agent builds up real expertise over time.
- **Agents share.** When one agent learns something, others in the same organization can access it too. No manual copying, no repeated explanations.
- **Your data stays yours.** Everything is stored in a local SQLite database. Embeddings run through Ollama on your machine. Nothing leaves your network unless you explicitly choose a cloud model.
- **Works everywhere.** Webchat, Feishu, Telegram, Discord — switch channels freely. Your agent's memory follows.

---

## See It In Action

**Without Engram:**
> **You:** Use PostgreSQL for this project, not MySQL.
> **Agent:** Got it, I'll use PostgreSQL.
>
> *(next session)*
>
> **You:** Set up the database.
> **Agent:** Sure! Which database would you prefer — MySQL, PostgreSQL, or SQLite?

**With Engram:**
> **You:** Set up the database.
> **Agent:** Setting up PostgreSQL, since that's your preference. Want me to use the same schema pattern from the Bonbon project?

---

**Without Engram:**
> **Agent A** *(learns):* The team decided to deploy via GitHub Actions, not manual SSH.
>
> *(later, different agent)*
>
> **Agent B:** How should I deploy this? Want me to SSH into the server?

**With Engram:**
> **Agent B:** I'll set up the GitHub Actions workflow — that's the deployment approach the team settled on.

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

Engram hooks into two moments of every conversation:

**Before your agent responds** — Engram takes your message, searches its memory database for anything relevant, and quietly injects matching memories into the agent's context. Your agent sees them as background knowledge, like recalling something it already knows.

**After your agent responds** — Engram looks at what just happened in the conversation and extracts important facts. Short exchanges (under 500 characters) get stored directly. Longer conversations go through an LLM that reads the full exchange and picks out the key points — preferences stated, decisions made, facts established.

Everything is stored locally in SQLite (WAL mode, crash-safe). Embeddings are generated by Ollama running on your machine, so memory search is fast and private.

### Memory Types

| Type | What It Stores | Example |
|------|---------------|---------|
| `semantic` | Stable facts, knowledge, preferences | "User prefers PostgreSQL" |
| `episodic` | Events, incidents, time-bound things | "Deployed v2.1 on 2026-04-09" |
| `procedural` | Processes, decisions, how-to knowledge | "Always run migrations before deploying" |

### What Gets Remembered

Engram captures both sides of the conversation:
- **What you say** — preferences, facts, requests, context
- **What your agent decides** — analysis, recommendations, commitments, plans

Each memory is tagged with a `source_role` (`user`, `assistant`, or `both`) so you always know where knowledge came from.

---

## Multi-Agent Memory

This is where Engram really shines.

By default, each agent's memories are private. Agent A can't see what Agent B remembers, and vice versa. This happens automatically — Engram reads the agent identity from the session.

But sometimes you want agents to share. Maybe Agent A figured out your deployment process, and you want Agent B to know it too. Maybe your whole team of agents should understand the project architecture.

Engram handles this through organizations and projects. When an agent stores a memory with an org or project tag, other agents in that same org or project can see it. Think of it like team channels — private by default, shared when it makes sense.

The best part: you usually don't have to do this manually. Engram's extraction LLM automatically figures out which org or project a conversation belongs to and tags memories accordingly. You just configure your known orgs and projects once, and Engram handles the rest.

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

### Visibility Rules

- **Has `project_id` + `org_id`** → visible to all agents in that project
- **Has `org_id` only** → visible to all agents in that organization
- **Neither** → visible only to the creating agent

To manually share a memory:
```
memory_add(text="Project deadline is March 15", visibility="shared")
```

---

## Configuration

These are the defaults. Most users won't need to change anything.

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
| `recallMaxResults` | `8` | Hard cap on injected recall memories |
| `recallScoreGap` | `0.08` | Truncate recalled memories when adjacent score gap is large |
| `recallHighConfidence` | `0.75` | High-confidence recall threshold |
| `recallShortMsgMaxResults` | `3` | Max recalled memories for short prompts (<20 chars) |
| `recallStatsLog` | `true` | Log recall experiment stats |
| `extractionWindowMessages` | `30` | Standard full extraction inspects the latest N messages |
| `extractionWindowChars` | `8000` | Character cap for standard full extraction window |
| `extractionPressureWindowMessages` | `50` | Pressure-triggered extraction inspects the latest N messages |
| `extractionPressureWindowChars` | `16000` | Character cap for pressure-triggered extraction window |

### Advanced Configuration

#### Extraction Window Tuning

Engram uses two extraction windows for `autoCapture` full extraction:

- **Standard full extraction** — used for normal longer conversations
- **Pressure-triggered extraction** — used when context pressure is high and Engram proactively captures before compaction risk grows

Defaults:

```json
{
  "extractionWindowMessages": 30,
  "extractionWindowChars": 8000,
  "extractionPressureWindowMessages": 50,
  "extractionPressureWindowChars": 16000
}
```

Raising these values improves capture completeness for long planning threads, at the cost of more extraction tokens and slightly slower capture.

#### Dimension Configuration (~/.engram/dimensions.json)

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
| [**Imprint**](https://github.com/maiyangyun/imprint) | Build expert-level agents from structured profile documents. *Helps agents know who they are.* |
| **Engram** | Multi-agent collaborative memory system. *Helps agents accumulate and share experience.* |
| **Synapse** | Agent-first human-agent collaboration workspace. *Helps agents work alongside humans.* |

**Imprint → Engram → Synapse**: Identity → Memory → Collaboration.

---

## Changelog

**v0.5.0-beta.1** (2026-04-22) — Recall precision overhaul with smart truncation, incremental memory deduplication with human review, agent alias mapping, and configurable extraction windows.

See [CHANGELOG.md](CHANGELOG.md) for full version history.

---

## Roadmap

- [ ] Recall timeout optimization under multi-agent concurrency
- [ ] Evaluate cloud extraction providers (Gemini API) for faster capture
- [ ] Web dashboard for memory inspection and management
- [ ] Memory abstraction — auto-distill specific experiences into transferable methodology

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
