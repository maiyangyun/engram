// Engram Hooks — autoCapture and autoRecall pipelines

import type { EngramStore, SearchResult } from "./store.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { LLMProvider } from "./extraction.js";
import { extractMemories } from "./extraction.js";
import type { EngramConfig } from "./config.js";
import { autoDiscoverDimensions } from "./config.js";

interface HookApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>): void;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}

interface HookDeps {
  api: HookApi;
  store: EngramStore;
  embedder: EmbeddingProvider;
  llm: LLMProvider;
  config: EngramConfig;
}

// --- Helpers ---

function isNonInteractiveTrigger(trigger?: string, _sessionId?: string): boolean {
  if (!trigger) return false;
  const nonInteractive = ["heartbeat", "cron", "system", "startup"];
  return nonInteractive.some((t) => trigger.toLowerCase().includes(t));
}

function isSubagentSession(sessionId?: string): boolean {
  return !!sessionId && sessionId.includes(":subagent:");
}

function isSystemPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("a new session was started") ||
    lower.includes("session startup sequence") ||
    lower.includes("/new or /reset") ||
    lower.startsWith("system:") ||
    lower.startsWith("run your session")
  );
}

/** v0.4: Detect noise content that should never be captured as memory */
function isNoiseContent(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // OpenClaw internal machinery
  if (lower.includes("generate a short 1-2 word filename slug")) return true;
  if (lower.includes("generate a short filename slug")) return true;
  if (lower.includes("conversation summary:")) return true;
  if (lower.startsWith("heartbeat_ok")) return true;
  if (lower.startsWith("no_reply")) return true;

  // Trivial responses with no informational value
  const trivialPatterns = /^(ok|好的?|收到|嗯|是的?|对|understood|got it|sure|yes|no|好吧|行|可以|明白|知道了|roger|ack)\.?$/i;
  if (trivialPatterns.test(lower)) return true;

  // Pure emoji or very short non-informational content
  const stripped = lower.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]/gu, "");
  if (stripped.length < 3) return true;

  return false;
}

function stripMetadata(text: string): string {
  return text
    .replace(/Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "")
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "")
    // v0.4: Strip OpenClaw inbound context blocks
    .replace(/## Inbound Context \(trusted metadata\)[\s\S]*?```\s*/gi, "")
    .replace(/\[message_id:[^\]]*\]/g, "")
    // v0.4: Strip timestamp prefixes from channel messages
    .replace(/^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/gm, "")
    // v0.4: Strip Current time metadata
    .replace(/Current time:.*?\(Asia\/Shanghai\).*?UTC\s*/gi, "")
    .trim();
}

function truncateMessages(
  messages: Array<{ role: string; content: string }>,
  maxChars: number,
): Array<{ role: string; content: string }> {
  let totalChars = 0;
  const result: Array<{ role: string; content: string }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (totalChars + msg.content.length > maxChars && result.length > 0) break;
    result.unshift(msg);
    totalChars += msg.content.length;
  }
  return result;
}

function resolveSessionContext(
  config: EngramConfig,
  sessionId?: string,
): { agent_id: string | null; org_id: string | null; project_id: string | null } {
  let agentId: string | null = null;
  if (sessionId) {
    const match = sessionId.match(/^agent:([^:]+)/);
    if (match) agentId = match[1];
  }

  return {
    agent_id: agentId,
    org_id: config.defaultOrgId,
    project_id: config.defaultProjectId,
  };
}

/**
 * v0.4: Resolve agent's full membership (all orgs/projects they belong to).
 * Used by autoRecall to determine cross-org visibility.
 */
function resolveAgentMembership(
  config: EngramConfig,
  agentId: string | null,
): { memberOrgs: string[]; memberProjects: string[] } {
  const orgs = new Set<string>();
  const projects = new Set<string>();

  // Always include default org/project
  if (config.defaultOrgId) orgs.add(config.defaultOrgId);
  if (config.defaultProjectId) projects.add(config.defaultProjectId);

  // Add agent-specific memberships from dimensions.json
  if (agentId) {
    const agentConfig = config.agents[agentId.toLowerCase()];
    if (agentConfig) {
      for (const m of agentConfig.memberships) {
        orgs.add(m.org);
        for (const p of m.projects) projects.add(p);
      }
    }
  }

  return { memberOrgs: [...orgs], memberProjects: [...projects] };
}

/** T5: Lightweight keyword match for fast-path shared detection (no LLM needed) */
function inferSharedFromKeywords(
  content: string,
  config: EngramConfig,
): { org_id: string | null; project_id: string | null } | null {
  const lower = content.toLowerCase();
  // Match against v2 structured projects (with aliases)
  for (const proj of config.dimensionProjects) {
    const allNames = [proj.id, ...proj.aliases];
    if (allNames.some(name => lower.includes(name.toLowerCase()))) {
      // Auto-resolve org from project→org mapping
      const orgId = proj.org ?? config.projectOrgMap[proj.id] ?? null;
      return { org_id: orgId, project_id: proj.id };
    }
  }
  // Fallback: match flat project strings (v1 compat)
  if (config.dimensionProjects.length === 0) {
    for (const proj of config.knownProjects) {
      if (lower.includes(proj.toLowerCase())) {
        const orgId = config.projectOrgMap[proj] ?? null;
        return { org_id: orgId, project_id: proj };
      }
    }
  }
  // Match against orgs
  for (const org of config.dimensionOrgs) {
    const allNames = [org.id, ...org.aliases];
    if (org.id !== config.defaultOrgId && allNames.some(name => lower.includes(name.toLowerCase()))) {
      return { org_id: org.id, project_id: null };
    }
  }
  return null;
}

// --- Emergency capture state (T8) ---

interface PendingCapture {
  messages: Array<{ role: string; content: string }>;
  ctx: { agent_id: string | null; org_id: string | null; project_id: string | null };
  timestamp: number;
}

let pendingCapture: PendingCapture | null = null;
let emergencyHandlerRegistered = false;

// --- T9: Context pressure tracking ---

interface SessionPressure {
  msgCount: number;
  totalChars: number;
  lastFullCaptureAt: number; // msgCount at last full extraction
}

const sessionPressure = new Map<string, SessionPressure>();

// Thresholds: trigger proactive full capture when context is likely getting large
const PRESSURE_MSG_THRESHOLD = 30;       // messages since last full capture
const PRESSURE_CHAR_THRESHOLD = 80_000;  // chars accumulated
const PRESSURE_CAPTURE_INTERVAL = 15;    // min messages between proactive captures

function clearPending(): void {
  pendingCapture = null;
}

function registerEmergencyHandler(deps: HookDeps): void {
  if (emergencyHandlerRegistered) return;
  emergencyHandlerRegistered = true;

  const emergencyFlush = (signal: string) => {
    if (!pendingCapture) return;
    try {
      const { messages, ctx } = pendingCapture;
      const summary = messages
        .slice(-6)
        .map((m) => `${m.role === "user" ? "U" : "A"}: ${m.content.slice(0, 150)}`)
        .join(" | ");
      const content = summary.length > 300 ? summary.slice(0, 297) + "..." : summary;

      // Sync write — no embedding (better-sqlite3 is synchronous)
      deps.store.add({
        user_id: deps.config.userId,
        agent_id: ctx.agent_id,
        org_id: ctx.org_id,
        project_id: ctx.project_id,
        memory_type: "episodic",
        content: `[emergency-${signal}] ${content}`,
        metadata: { importance: 0.7, source: "emergency_capture", signal },
      });
      deps.api.logger.info(`engram: emergency capture on ${signal} — saved 1 memory (no embedding)`);
      pendingCapture = null;
    } catch (err) {
      // Last resort — can't do much here
      try { deps.api.logger.warn(`engram: emergency capture failed: ${String(err)}`); } catch { /* noop */ }
    }
  };

  process.on("SIGTERM", () => emergencyFlush("SIGTERM"));
  process.on("SIGUSR1", () => emergencyFlush("SIGUSR1"));
  // SIGUSR2 is used by OpenClaw for reload
  process.on("SIGUSR2", () => emergencyFlush("SIGUSR2"));
}

// --- T10: Capture queue (serialize, isolate from main dialog abort) ---

const CAPTURE_TIMEOUT_MS = 300_000; // v0.4: aligned with extraction LLM timeout (300s for local qwen3.5)

let captureQueue: Promise<void> = Promise.resolve();

function enqueueCapture(label: string, fn: () => Promise<void>, logger: HookApi["logger"]): void {
  captureQueue = captureQueue.then(() => {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(`engram: [queue] ${label} timed out after ${CAPTURE_TIMEOUT_MS}ms`);
        resolve();
      }, CAPTURE_TIMEOUT_MS);

      fn()
        .catch((err) => logger.warn(`engram: [queue] ${label} failed: ${String(err)}`))
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  });
}

// --- autoRecall ---

const RECALL_TIMEOUT_MS = 15000;

export function registerAutoRecall(deps: HookDeps): void {
  deps.api.on("before_prompt_build", async (event, ctx) => {
    const prompt = event.prompt as string | undefined;
    if (!prompt || prompt.length < 5) return;

    const trigger = ctx?.trigger as string | undefined;
    const sessionId = ctx?.sessionKey as string | undefined;

    if (isNonInteractiveTrigger(trigger, sessionId)) return;
    if (isSystemPrompt(prompt)) return;

    const isSubagent = isSubagentSession(sessionId);
    const cleanPrompt = stripMetadata(prompt);
    if (cleanPrompt.length < 5) return;
    // v0.4: Skip recall for noise content
    if (isNoiseContent(cleanPrompt)) return;

    const sessionCtx = resolveSessionContext(deps.config, sessionId);

    // v2: Set active agent context for tools to read as fallback
    if (sessionCtx.agent_id) {
      deps.config._activeAgentId = sessionCtx.agent_id;
    }

    const recallWork = async (): Promise<{ prependContext: string } | undefined> => {
      const embedding = await deps.embedder.embed(cleanPrompt);

      let results: SearchResult[];

      if (sessionCtx.agent_id) {
        const membership = resolveAgentMembership(deps.config, sessionCtx.agent_id);
        results = deps.store.searchWithVisibility(
          {
            user_id: deps.config.userId,
            agent_id: sessionCtx.agent_id,
            org_id: sessionCtx.org_id,
            project_id: sessionCtx.project_id,
            memberOrgs: membership.memberOrgs,
            memberProjects: membership.memberProjects,
          },
          embedding,
          undefined,
          deps.config.topK,
          deps.config.searchThreshold,
        );
      } else {
        results = deps.store.vectorSearch({
          user_id: deps.config.userId,
          embedding,
          top_k: deps.config.topK,
          threshold: deps.config.searchThreshold,
        });
      }

      if (results.length === 0) return undefined;

      const memoryContext = results
        .map((r) => {
          const tags: string[] = [];
          if (r.memory_type) tags.push(r.memory_type);
          if (r.agent_id) tags.push(`agent:${r.agent_id}`);
          if (r.org_id) tags.push(`org:${r.org_id}`);
          if (r.project_id) tags.push(`project:${r.project_id}`);
          const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
          return `- ${r.content}${tagStr}`;
        })
        .join("\n");

      // v0.4: Touch recalled memories to reset their decay clock
      deps.store.touchRecalled(results.map((r) => r.id));

      deps.api.logger.info(`engram: injecting ${results.length} memories into context`);

      const preamble = isSubagent
        ? `The following are stored memories for user "${deps.config.userId}". You are a subagent — use these memories for context but do not assume you are this user.`
        : `The following are stored memories for user "${deps.config.userId}". Use them to personalize your response:`;

      return {
        prependContext: `<relevant-memories>\n${preamble}\n${memoryContext}\n</relevant-memories>`,
      };
    };

    try {
      const timeout = new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), RECALL_TIMEOUT_MS);
      });
      const result = await Promise.race([
        recallWork(),
        timeout.then(() => {
          deps.api.logger.warn(`engram: recall timed out after ${RECALL_TIMEOUT_MS}ms`);
          return undefined;
        }),
      ]);
      return result;
    } catch (err) {
      deps.api.logger.warn(`engram: recall failed: ${String(err)}`);
    }
  });
}

// --- autoCapture ---

export function registerAutoCapture(deps: HookDeps): void {
  // T8: Register emergency signal handlers on first load
  registerEmergencyHandler(deps);

  deps.api.on("agent_end", async (event, ctx) => {
    const messages = event.messages as Array<{ role: string; content: unknown }> | undefined;
    const trigger = ctx?.trigger as string | undefined;
    const sessionId = ctx?.sessionKey as string | undefined;

    const success = !!event.success;
    deps.api.logger.info(`engram: [capture-debug] agent_end fired — session=${sessionId ?? "none"} trigger=${trigger ?? "none"} success=${success} msgCount=${messages?.length ?? 0}`);

    if (!messages || messages.length === 0) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: no messages`);
      return;
    }

    if (isNonInteractiveTrigger(trigger, sessionId)) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: non-interactive trigger`);
      return;
    }
    if (isSubagentSession(sessionId)) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: subagent session`);
      return;
    }

    const MEMORY_TOOLS = new Set(["memory_add", "memory_update", "memory_delete"]);
    const agentUsedMemoryTool = messages.some((msg) => {
      if (msg?.role !== "assistant" || !Array.isArray(msg?.content)) return false;
      return (msg.content as Array<Record<string, unknown>>).some(
        (block) => block?.type === "tool_use" && MEMORY_TOOLS.has(block.name as string),
      );
    });
    if (agentUsedMemoryTool) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: agent used memory tools`);
      return;
    }

    const parsed: Array<{ role: string; content: string }> = [];
    for (const msg of messages) {
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block && typeof block.text === "string") {
            text += (text ? "\n" : "") + block.text;
          }
        }
      }
      if (!text) continue;

      text = stripMetadata(text);
      if (!text) continue;

      // v0.4: Skip noise content (system machinery, trivial replies)
      if (isNoiseContent(text)) continue;

      parsed.push({ role, content: text });
    }

    deps.api.logger.info(`engram: [capture-debug] parsed ${parsed.length} messages, roles: ${parsed.map(m => m.role).join(",")}`);

    if (parsed.length === 0) return;
    if (!parsed.some((m) => m.role === "user")) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: no user messages in parsed`);
      return;
    }

    const userContent = parsed.filter((m) => m.role === "user").map((m) => m.content).join(" ");
    const assistantContent = parsed.filter((m) => m.role === "assistant").map((m) => m.content).join(" ");
    const totalContent = userContent + " " + assistantContent;
    deps.api.logger.info(`engram: [capture-debug] userContent length=${userContent.length}, assistantContent length=${assistantContent.length}`);
    if (totalContent.trim().length < 10) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: totalContent too short (${totalContent.trim().length})`);
      return;
    }

    const sessionCtx = resolveSessionContext(deps.config, sessionId);

    // T8: Set pending capture so emergency handler can flush if process is killed
    pendingCapture = { messages: parsed, ctx: sessionCtx, timestamp: Date.now() };

    // T9: Track context pressure per session
    const sessKey = sessionId ?? "unknown";
    let pressure = sessionPressure.get(sessKey);
    if (!pressure) {
      pressure = { msgCount: 0, totalChars: 0, lastFullCaptureAt: 0 };
      sessionPressure.set(sessKey, pressure);
    }
    pressure.msgCount += parsed.length;
    pressure.totalChars += totalContent.length;

    const msgSinceLastFull = pressure.msgCount - pressure.lastFullCaptureAt;
    const underPressure = msgSinceLastFull >= PRESSURE_MSG_THRESHOLD || pressure.totalChars >= PRESSURE_CHAR_THRESHOLD;
    const enoughInterval = msgSinceLastFull >= PRESSURE_CAPTURE_INTERVAL;

    deps.api.logger.info(`engram: [capture-debug] PROCEEDING — agent=${sessionCtx.agent_id} path=${!success ? "salvage-fast" : underPressure && enoughInterval ? "pressure-full" : totalContent.length < 500 ? "fast" : "full"}`);

    // Failed rounds: force fast-path salvage capture (no LLM, just save what we have)
    if (!success) {
      enqueueCapture("salvage", () => fastCapture(deps, parsed, sessionCtx, "salvage"), deps.api.logger);
      return;
    }

    // T9: Under context pressure, force full extraction even for short content
    if (underPressure && enoughInterval) {
      deps.api.logger.info(`engram: [T9] context pressure detected (msgs=${pressure.msgCount}, chars=${pressure.totalChars}, sinceLastFull=${msgSinceLastFull}) — forcing full extraction`);
      const recentWindow = parsed.slice(-20);
      const truncated = truncateMessages(recentWindow, 4000);
      enqueueCapture("pressure-full", async () => {
        await extractAndStore(deps, truncated, sessionCtx);
        const p = sessionPressure.get(sessKey);
        if (p) {
          p.lastFullCaptureAt = p.msgCount;
          p.totalChars = 0;
        }
      }, deps.api.logger);
      return;
    }

    if (totalContent.length < 500) {
      enqueueCapture("fast", () => fastCapture(deps, parsed, sessionCtx, "fast"), deps.api.logger);
      return;
    }

    const recentWindow = parsed.slice(-20);
    const truncated = truncateMessages(recentWindow, 4000);

    enqueueCapture("full", async () => {
      await extractAndStore(deps, truncated, sessionCtx);
      const p = sessionPressure.get(sessKey);
      if (p) {
        p.lastFullCaptureAt = p.msgCount;
        p.totalChars = 0;
      }
    }, deps.api.logger);
  });
}

async function fastCapture(
  deps: HookDeps,
  messages: Array<{ role: string; content: string }>,
  ctx: { agent_id: string | null; org_id: string | null; project_id: string | null },
  mode: "fast" | "salvage" = "fast",
): Promise<void> {
  const summary = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)
    .join(" | ");

  const content = summary.length > 300 ? summary.slice(0, 297) + "..." : summary;
  const embedding = await deps.embedder.embed(content);

  // T5: Lightweight keyword match for dimension detection on fast path
  const sharedMatch = inferSharedFromKeywords(content, deps.config);
  const effectiveOrgId = sharedMatch?.org_id ?? ctx.org_id;
  const effectiveProjectId = sharedMatch?.project_id ?? ctx.project_id;

  // Fast path: no LLM inference, use session context defaults
  // v2: agent_id always set — sharing is via org_id/project_id dimensions
  const result = deps.store.add({
    user_id: deps.config.userId,
    agent_id: ctx.agent_id,
    org_id: effectiveOrgId,
    project_id: effectiveProjectId,
    memory_type: "episodic",
    content,
    embedding,
    metadata: { importance: mode === "salvage" ? 0.6 : 0.5, source: mode === "salvage" ? "salvage_capture" : "fast_capture" },
  });

  deps.api.logger.info(`engram: ${mode}-captured 1 episodic memory (${result.dedupAction})`);
  clearPending(); // T8: capture succeeded, no need for emergency flush
}

async function extractAndStore(
  deps: HookDeps,
  messages: Array<{ role: string; content: string }>,
  ctx: { agent_id: string | null; org_id: string | null; project_id: string | null },
): Promise<void> {
  const timestamp = new Date().toISOString().split("T")[0];
  const messagesWithDate = [
    { role: "system", content: `Current date: ${timestamp}. Extract durable facts from this conversation.` },
    ...messages,
  ];

  // Pass known orgs/projects + agent memberships for LLM dimension inference
  const knownOrgs = deps.config.knownOrgs.length > 0 ? deps.config.knownOrgs : undefined;
  const knownProjects = deps.config.knownProjects.length > 0 ? deps.config.knownProjects : undefined;

  // Resolve agent memberships for the current agent
  const agentName = ctx.agent_id?.toLowerCase();
  const agentConfig = agentName ? deps.config.agents[agentName] : undefined;

  let extraction;
  try {
    extraction = await extractMemories(deps.llm, messagesWithDate, {
      customInstructions: deps.config.customInstructions ?? undefined,
      knownOrgs,
      knownProjects,
      agentId: ctx.agent_id ?? undefined,
      agentMemberships: agentConfig?.memberships,
      projectOrgMap: Object.keys(deps.config.projectOrgMap).length > 0 ? deps.config.projectOrgMap : undefined,
    });
  } catch (err) {
    // T7: LLM extraction failed — fallback to fast-path instead of losing everything
    deps.api.logger.warn(`engram: LLM extraction failed (${String(err)}), falling back to fast-path`);
    await fastCapture(deps, messages, ctx, "salvage");
    return;
  }

  if (extraction.facts.length === 0) return;

  const worthKeeping = extraction.facts.filter((f) => f.importance >= 0.4);
  if (worthKeeping.length === 0) return;

  // v0.4: Auto-discover new dimensions from LLM extraction results
  const discovered = autoDiscoverDimensions(deps.config, worthKeeping);
  if (discovered) {
    deps.api.logger.info(`engram: [dimensions] auto-discovered new org/project dimensions from extraction`);
  }

  let contents: string[];
  let embeddings: number[][];
  try {
    contents = worthKeeping.map((f) => f.content);
    embeddings = await deps.embedder.embedBatch(contents);
  } catch (err) {
    // Embedding failed after successful extraction — still salvage
    deps.api.logger.warn(`engram: embedding failed (${String(err)}), falling back to fast-path`);
    await fastCapture(deps, messages, ctx, "salvage");
    return;
  }

  let addedCount = 0;
  let updatedCount = 0;

  for (let i = 0; i < worthKeeping.length; i++) {
    const fact = worthKeeping[i];

    // LLM-inferred dimensions, fall back to session context
    let effectiveOrgId = fact.org_id ?? ctx.org_id;
    const effectiveProjectId = fact.project_id ?? ctx.project_id;
    // Auto-fill org from project→org mapping if LLM set project but not org
    if (effectiveProjectId && !effectiveOrgId && deps.config.projectOrgMap[effectiveProjectId]) {
      effectiveOrgId = deps.config.projectOrgMap[effectiveProjectId];
    }
    // v2: agent_id always set — sharing is determined by org_id/project_id dimensions
    const result = deps.store.add({
      user_id: deps.config.userId,
      agent_id: ctx.agent_id,
      org_id: effectiveOrgId,
      project_id: effectiveProjectId,
      memory_type: fact.memory_type,
      content: fact.content,
      embedding: embeddings[i],
      metadata: { importance: fact.importance, source_role: fact.source, source: "auto_capture" },
    });

    if (result.dedupAction === "added") addedCount++;
    else updatedCount++;
  }

  const dedupStats = updatedCount > 0 ? ` (${addedCount} added, ${updatedCount} updated)` : "";
  deps.api.logger.info(
    `engram: auto-captured ${worthKeeping.length} memories (${worthKeeping.map((f) => f.memory_type).join(", ")})${dedupStats}`
  );
  clearPending(); // T8: capture succeeded, no need for emergency flush
}
