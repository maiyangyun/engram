# Changelog

All notable changes to Engram are documented here.

---

### v0.5.0-beta.1 (2026-04-22)

**Recall Precision (P0-1):**
- Raised `searchThreshold` from 0.50 to 0.62 based on baseline analysis of 1922 memories × 50 simulated queries
- New `applySmartTruncation()` — score gap truncation (0.08), hard cap (8), short-message limit (3), high-confidence filter (0.75)
- Six new tunable recall parameters: `recallMaxResults`, `recallScoreGap`, `recallHighConfidence`, `recallShortMsgMaxResults`, `recallStatsLog`
- Added `[recall-stats]` experiment logging for production observation

**Memory Deduplication (P0-2):**
- Incremental dedup: two-tier thresholds (cross-dimension 0.92, same-dimension 0.88)
- Gray zone (0.85-0.92) written to `pending_dedup` table for human review
- New `engram_dedup_review` tool (list / resolve) for interactive dedup confirmation
- Input normalization: `org_id`/`project_id` now `toLowerCase().trim()` at entry

**Agent Alias Mapping (P0-3):**
- New `agentAliases` config for automatic agent ID mapping (e.g. `"main"` → `"ben"`)
- Ensures consistent `agent_id` across sessions without manual data migration

**Extraction Window (P1-4):**
- Replaced fixed narrow extraction window (20 messages / 4000 chars) with configurable adaptive windows
- Standard full extraction: default 30 messages / 8000 chars
- Pressure-triggered extraction: default 50 messages / 16000 chars
- Four new config parameters: `extractionWindowMessages`, `extractionWindowChars`, `extractionPressureWindowMessages`, `extractionPressureWindowChars`

**Compatibility:**
- No schema breaking changes from v0.4.1
- All new config parameters have sensible defaults — zero-config upgrade

### v0.4.1 (2026-04-21)

**Fixes:**
- **Embedding queue bypass** — `embed()` and `embedBatch()` no longer go through the global Ollama serial queue. BERT-style embedding models such as `bge-m3` can handle concurrent requests natively, and queueing them caused `autoRecall` timeouts under multi-agent load
- **Runtime-only hook registration** — Engram hooks now register only in the runtime plugin load path. Gateway startup no longer binds `before_prompt_build` / capture hooks, eliminating duplicate hook registration risk across gateway boot + runtime registry load
- **Recall timing diagnostics** — added granular `embed/search/total` timing logs to make recall stalls and timeout sources directly observable in production logs

**Operational impact:**
- Fixes the main failure mode where Feishu / DM conversations could be received and dispatched but never reach reply sending because recall got stuck before prompt build completed
- Improves recall stability when multiple agents share the same OpenClaw process and the same Ollama backend

**Compatibility:**
- No schema changes
- No visibility-model changes
- No breaking changes from v0.4.0

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
