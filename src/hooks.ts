// Engram Hooks — autoCapture and autoRecall pipelines

import type { EngramStore, SearchResult } from "./store.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { LLMProvider } from "./extraction.js";
import { extractMemories } from "./extraction.js";
import type { EngramConfig } from "./config.js";

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

function isNonInteractiveTrigger(trigger?: string, sessionId?: string): boolean {
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

function stripMetadata(text: string): string {
  return text
    .replace(/Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "")
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "")
    .trim();
}

function truncateMessages(
  messages: Array<{ role: string; content: string }>,
  maxChars: number,
): Array<{ role: string; content: string }> {
  let totalChars = 0;
  const result: Array<{ role: string; content: string }> = [];
  // Walk from end (most recent) to start
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
  // Extract agent_id from session key pattern: "agent:<agentId>:..."
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

// --- autoRecall ---

const RECALL_TIMEOUT_MS = 8000;

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

    const sessionCtx = resolveSessionContext(deps.config, sessionId);

    const recallWork = async (): Promise<{ prependContext: string } | undefined> => {
      const embedding = await deps.embedder.embed(cleanPrompt);

      let results: SearchResult[];

      if (sessionCtx.agent_id) {
        // Use five-layer visibility merge
        results = deps.store.searchWithVisibility(
          {
            user_id: deps.config.userId,
            agent_id: sessionCtx.agent_id,
            org_id: sessionCtx.org_id,
            project_id: sessionCtx.project_id,
          },
          embedding,
          undefined,
          deps.config.topK,
          Math.max(deps.config.searchThreshold, 0.6),
        );
      } else {
        // No agent context — search all user memories
        results = deps.store.vectorSearch({
          user_id: deps.config.userId,
          embedding,
          top_k: deps.config.topK,
          threshold: Math.max(deps.config.searchThreshold, 0.6),
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
  deps.api.on("agent_end", async (event, ctx) => {
    const messages = event.messages as Array<{ role: string; content: unknown }> | undefined;
    const trigger = ctx?.trigger as string | undefined;
    const sessionId = ctx?.sessionKey as string | undefined;

    deps.api.logger.info(`engram: [capture-debug] agent_end fired — session=${sessionId ?? "none"} trigger=${trigger ?? "none"} success=${event.success} msgCount=${messages?.length ?? 0}`);

    if (!event.success || !messages || messages.length === 0) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: success=${event.success} msgs=${messages?.length ?? 0}`);
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

    // Skip if agent already used memory tools this turn
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

    // Extract text from messages
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

      parsed.push({ role, content: text });
    }

    deps.api.logger.info(`engram: [capture-debug] parsed ${parsed.length} messages, roles: ${parsed.map(m => m.role).join(",")}`);

    if (parsed.length === 0) return;
    if (!parsed.some((m) => m.role === "user")) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: no user messages in parsed`);
      return;
    }

    const userContent = parsed.filter((m) => m.role === "user").map((m) => m.content).join(" ");
    deps.api.logger.info(`engram: [capture-debug] userContent length=${userContent.length}`);
    if (userContent.length < 10) {
      deps.api.logger.info(`engram: [capture-debug] SKIP: userContent too short (${userContent.length})`);
      return;
    }

    const sessionCtx = resolveSessionContext(deps.config, sessionId);
    deps.api.logger.info(`engram: [capture-debug] PROCEEDING — agent=${sessionCtx.agent_id} path=${userContent.length < 200 ? "fast" : "full"}`);

    // Fast path: short/medium conversations — store user message directly as episodic memory
    // without LLM extraction (saves ~5-30s Ollama round-trip)
    if (userContent.length < 200) {
      fastCapture(deps, parsed, sessionCtx).catch((err) => {
        deps.api.logger.warn(`engram: fast-capture failed: ${String(err)}`);
      });
      return;
    }

    // Full path: LLM-driven extraction for substantial conversations
    // Truncate to last 10 messages to keep Ollama extraction fast (<30s)
    const recentWindow = parsed.slice(-10);
    // Also cap total text to ~3000 chars to avoid Ollama timeout
    const truncated = truncateMessages(recentWindow, 3000);

    extractAndStore(deps, truncated, sessionCtx).catch((err) => {
      deps.api.logger.warn(`engram: capture failed: ${String(err)}`);
    });
  });
}

async function fastCapture(
  deps: HookDeps,
  messages: Array<{ role: string; content: string }>,
  ctx: { agent_id: string | null; org_id: string | null; project_id: string | null },
): Promise<void> {
  // For short conversations, store the full exchange as a single episodic memory
  // This avoids the ~5-10s Ollama LLM round-trip
  const summary = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)
    .join(" | ");

  const content = summary.length > 300 ? summary.slice(0, 297) + "..." : summary;
  const embedding = await deps.embedder.embed(content);

  deps.store.add({
    user_id: deps.config.userId,
    agent_id: ctx.agent_id,
    org_id: ctx.org_id,
    project_id: ctx.project_id,
    memory_type: "episodic",
    content,
    embedding,
    metadata: { importance: 0.5, source: "fast_capture" },
  });

  deps.api.logger.info(`engram: fast-captured 1 episodic memory (short conversation)`);
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

  const extraction = await extractMemories(deps.llm, messagesWithDate, deps.config.customInstructions ?? undefined);

  if (extraction.facts.length === 0) return;

  // Filter by importance threshold
  const worthKeeping = extraction.facts.filter((f) => f.importance >= 0.4);
  if (worthKeeping.length === 0) return;

  // Embed and store
  const contents = worthKeeping.map((f) => f.content);
  const embeddings = await deps.embedder.embedBatch(contents);

  for (let i = 0; i < worthKeeping.length; i++) {
    const fact = worthKeeping[i];
    deps.store.add({
      user_id: deps.config.userId,
      agent_id: ctx.agent_id,
      org_id: ctx.org_id,
      project_id: ctx.project_id,
      memory_type: fact.memory_type,
      content: fact.content,
      embedding: embeddings[i],
      metadata: { importance: fact.importance, source: "auto_capture" },
    });
  }

  deps.api.logger.info(
    `engram: auto-captured ${worthKeeping.length} memories (${worthKeeping.map((f) => f.memory_type).join(", ")})`
  );
}
