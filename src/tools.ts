// Engram Agent Tools — OpenClaw tool registrations
// Drop-in replacement for openclaw-mem0 tool interface

import { Type, type Static } from "@sinclair/typebox";
import type { EngramStore, MemoryType, SearchResult, MemoryRecord, AddMemoryResult } from "./store.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { EngramConfig } from "./config.js";
import { VALID_MEMORY_TYPES } from "./config.js";

export interface ToolDeps {
  store: EngramStore;
  embedder: EmbeddingProvider;
  config: EngramConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}

// --- Tool result helpers ---

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

// --- Resolve five-dimensional context ---

function resolveContext(
  config: EngramConfig,
  opts: { agentId?: string; orgId?: string; projectId?: string },
) {
  return {
    // v2: agent_id priority: explicit param > active agent from hooks > null
    agent_id: opts.agentId || config._activeAgentId || null,
    org_id: opts.orgId || config.defaultOrgId,
    project_id: opts.projectId || config.defaultProjectId,
  };
}

function formatMemory(r: MemoryRecord | SearchResult) {
  const dims: string[] = [];
  if (r.agent_id) dims.push(`agent:${r.agent_id}`);
  if (r.org_id) dims.push(`org:${r.org_id}`);
  if (r.project_id) dims.push(`project:${r.project_id}`);
  const dimStr = dims.length > 0 ? ` [${dims.join(", ")}]` : "";
  const score = "score" in r ? ` (score: ${(r as SearchResult).score.toFixed(3)})` : "";
  return {
    id: r.id,
    memory: r.content,
    memory_type: r.memory_type,
    user_id: r.user_id,
    agent_id: r.agent_id,
    org_id: r.org_id,
    project_id: r.project_id,
    ...("score" in r ? { score: (r as SearchResult).score } : {}),
    metadata: r.metadata,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// --- Tool definitions ---

export function createMemorySearchTool(deps: ToolDeps) {
  return {
    name: "memory_search",
    description: "Search through long-term memories stored in Engram. Supports five-dimensional filtering (user, agent, org, project) and memory type filtering.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      agentId: Type.Optional(Type.String({ description: "Agent ID to search a specific agent's memories" })),
      orgId: Type.Optional(Type.String({ description: "Organization ID filter" })),
      projectId: Type.Optional(Type.String({ description: "Project ID filter" })),
      memory_type: Type.Optional(Type.Union([
        Type.Literal("semantic"),
        Type.Literal("episodic"),
        Type.Literal("procedural"),
      ], { description: "Filter by memory type" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      scope: Type.Optional(Type.Union([
        Type.Literal("personal"),
        Type.Literal("shared"),
        Type.Literal("all"),
      ], { description: "Search scope: personal (agent-only), shared (org/project-visible), all (visibility merge)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = params.query as string;
      const ctx = resolveContext(deps.config, params as { agentId?: string; orgId?: string; projectId?: string });
      const memoryType = params.memory_type as MemoryType | undefined;
      const limit = (params.limit as number) ?? deps.config.topK;
      const scope = (params.scope as string) ?? "all";

      try {
        const embedding = await deps.embedder.embed(query);
        let results: SearchResult[];

        if (scope === "all") {
          // v0.4: Always use visibility-aware search for "all" scope.
          // This matches autoRecall behavior: sees shared (NULL) + own dimension memories.
          // For sessions without agent_id, pass "__none__" as sentinel to still use
          // the (agent_id IS NULL OR agent_id = ?) logic.
          results = deps.store.searchWithVisibility(
            {
              user_id: deps.config.userId,
              agent_id: ctx.agent_id ?? "__none__",
              org_id: ctx.org_id,
              project_id: ctx.project_id,
            },
            embedding,
            memoryType,
            limit,
            deps.config.searchThreshold,
            true, // v0.4: broadScope — search across all orgs/projects
          );
        } else {
          // v2: personal scope = only this agent's memories; shared scope = org/project visible
          if (scope === "shared") {
            // Search for memories visible via org/project membership (exclude agent-only)
            results = deps.store.vectorSearch({
              user_id: deps.config.userId,
              org_id: ctx.org_id,
              project_id: ctx.project_id,
              memory_type: memoryType,
              embedding,
              top_k: limit,
              threshold: deps.config.searchThreshold,
            });
          } else {
            // personal: only this agent's own memories
            results = deps.store.vectorSearch({
              user_id: deps.config.userId,
              agent_id: ctx.agent_id,
              org_id: ctx.org_id,
              project_id: ctx.project_id,
              memory_type: memoryType,
              embedding,
              top_k: limit,
              threshold: deps.config.searchThreshold,
            });
          }
        }

        if (results.length === 0) {
          return textResult("No matching memories found.");
        }

        return jsonResult(results.map(formatMemory));
      } catch (err) {
        return textResult(`Memory search failed: ${String(err)}`);
      }
    },
  };
}

export function createMemoryAddTool(deps: ToolDeps) {
  return {
    name: "memory_add",
    description: "Save information in long-term memory via Engram. Supports five-dimensional ownership and memory type classification.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Single fact to remember" })),
      facts: Type.Optional(Type.Array(Type.String(), { description: "Array of facts to store" })),
      memory_type: Type.Optional(Type.Union([
        Type.Literal("semantic"),
        Type.Literal("episodic"),
        Type.Literal("procedural"),
      ], { description: "Memory type (default: semantic)" })),
      agentId: Type.Optional(Type.String({ description: "Agent ID namespace" })),
      orgId: Type.Optional(Type.String({ description: "Organization ID" })),
      projectId: Type.Optional(Type.String({ description: "Project ID" })),
      visibility: Type.Optional(Type.Union([
        Type.Literal("agent"),
        Type.Literal("shared"),
      ], { description: "Visibility: agent (default, only this agent) or shared (visible to all agents)" })),
      metadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Additional metadata" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const texts: string[] = [];
      if (params.text) texts.push(params.text as string);
      if (params.facts && Array.isArray(params.facts)) texts.push(...(params.facts as string[]));
      if (texts.length === 0) return textResult("No facts provided.");

      const ctx = resolveContext(deps.config, params as { agentId?: string; orgId?: string; projectId?: string });
      // v2: visibility=shared no longer clears agent_id; sharing is via org_id/project_id
      // Ensure org_id is set for shared visibility
      if (params.visibility === "shared" && !ctx.org_id) {
        ctx.org_id = deps.config.defaultOrgId;
      }
      const memoryType = (params.memory_type as MemoryType) ?? "semantic";
      const metadata = params.metadata as Record<string, unknown> | undefined;

      if (!VALID_MEMORY_TYPES.includes(memoryType)) {
        return textResult(`Invalid memory_type: ${memoryType}. Must be one of: ${VALID_MEMORY_TYPES.join(", ")}`);
      }

      try {
        const embeddings = await deps.embedder.embedBatch(texts);
        const results = texts.map((text, i) =>
          deps.store.add({
            user_id: deps.config.userId,
            agent_id: ctx.agent_id,
            org_id: ctx.org_id,
            project_id: ctx.project_id,
            memory_type: memoryType,
            content: text,
            embedding: embeddings[i],
            metadata,
          }),
        );

        deps.logger.info(`engram: stored ${results.length} memories (type: ${memoryType}, agent: ${ctx.agent_id ?? "shared"})`);

        const added = results.filter(r => r.dedupAction === "added").length;
        const updated = results.filter(r => r.dedupAction === "updated").length;
        const pending = results.filter(r => r.dedupAction === "pending").length;
        const parts: string[] = [];
        if (added > 0) parts.push(`${added} added`);
        if (updated > 0) parts.push(`${updated} updated`);
        if (pending > 0) parts.push(`${pending} pending-review`);
        const dedupInfo = parts.length > 0 ? ` (${parts.join(", ")})` : "";

        return jsonResult({
          results: results.map((r) => ({
            id: r.id,
            memory: r.content,
            memory_type: r.memory_type,
            event: r.dedupAction === "updated" ? "UPDATE" : r.dedupAction === "pending" ? "PENDING_REVIEW" : "ADD",
            dedupAction: r.dedupAction,
          })),
          summary: `${results.length} memories processed${dedupInfo}`,
        });
      } catch (err) {
        return textResult(`Memory add failed: ${String(err)}`);
      }
    },
  };
}

export function createMemoryGetTool(deps: ToolDeps) {
  return {
    name: "memory_get",
    description: "Retrieve a specific memory by its ID from Engram.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "The memory ID to retrieve" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const memoryId = params.memoryId as string;
      const record = deps.store.get(memoryId);
      if (!record) return textResult(`Memory not found: ${memoryId}`);
      return jsonResult(formatMemory(record));
    },
  };
}

export function createMemoryListTool(deps: ToolDeps) {
  return {
    name: "memory_list",
    description: "List all stored memories with optional filters.",
    parameters: Type.Object({
      agentId: Type.Optional(Type.String({ description: "Agent ID filter" })),
      orgId: Type.Optional(Type.String({ description: "Organization ID filter" })),
      projectId: Type.Optional(Type.String({ description: "Project ID filter" })),
      memory_type: Type.Optional(Type.Union([
        Type.Literal("semantic"),
        Type.Literal("episodic"),
        Type.Literal("procedural"),
      ])),
      limit: Type.Optional(Type.Number({ description: "Max results" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const ctx = resolveContext(deps.config, params as { agentId?: string; orgId?: string; projectId?: string });
      const records = deps.store.list({
        user_id: deps.config.userId,
        agent_id: ctx.agent_id !== null ? ctx.agent_id : undefined,
        org_id: ctx.org_id !== null ? ctx.org_id : undefined,
        project_id: ctx.project_id !== null ? ctx.project_id : undefined,
        memory_type: params.memory_type as MemoryType | undefined,
        limit: (params.limit as number) ?? 100,
      });

      if (records.length === 0) return textResult("No memories found.");
      return jsonResult(records.map(formatMemory));
    },
  };
}

export function createMemoryUpdateTool(deps: ToolDeps) {
  return {
    name: "memory_update",
    description: "Update an existing memory's text in place.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "The memory ID to update" }),
      text: Type.String({ description: "The new text (replaces old)" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const memoryId = params.memoryId as string;
      const text = params.text as string;

      try {
        const embedding = await deps.embedder.embed(text);
        const updated = deps.store.update(memoryId, text, embedding);
        if (!updated) return textResult(`Memory not found: ${memoryId}`);
        deps.logger.info(`engram: updated memory ${memoryId}`);
        return textResult(`Memory ${memoryId} updated successfully.`);
      } catch (err) {
        return textResult(`Memory update failed: ${String(err)}`);
      }
    },
  };
}

export function createMemoryDeleteTool(deps: ToolDeps) {
  return {
    name: "memory_delete",
    description: "Delete a memory by ID, or delete all memories for a user/agent.",
    parameters: Type.Object({
      memoryId: Type.Optional(Type.String({ description: "Specific memory ID to delete" })),
      all: Type.Optional(Type.Boolean({ description: "Delete ALL memories. Requires confirm: true." })),
      confirm: Type.Optional(Type.Boolean({ description: "Safety gate for bulk operations" })),
      agentId: Type.Optional(Type.String({ description: "Agent ID to scope deletion" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      if (params.memoryId) {
        const deleted = deps.store.delete(params.memoryId as string);
        if (!deleted) return textResult(`Memory not found: ${params.memoryId}`);
        deps.logger.info(`engram: deleted memory ${params.memoryId}`);
        return textResult(`Memory ${params.memoryId} deleted.`);
      }

      if (params.all) {
        if (!params.confirm) {
          return textResult("Bulk delete requires confirm: true as a safety gate.");
        }
        const count = deps.store.deleteAll(deps.config.userId, params.agentId as string | undefined);
        deps.logger.info(`engram: bulk deleted ${count} memories`);
        return textResult(`Deleted ${count} memories.`);
      }

      return textResult("Provide memoryId or all: true to delete memories.");
    },
  };
}

export function createDedupReviewTool(deps: ToolDeps) {
  return {
    name: "engram_dedup_review",
    description: "Fetch pending memory dedup pairs for user review. Present each pair and ask the user whether they refer to the same thing. Use 'resolve' action to confirm the user's decision.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("resolve"),
      ], { description: "'list' to fetch pending pairs, 'resolve' to act on user decision" }),
      pendingId: Type.Optional(Type.String({ description: "Pending dedup record ID (for resolve)" })),
      decision: Type.Optional(Type.Union([
        Type.Literal("duplicate"),
        Type.Literal("distinct"),
      ], { description: "User's decision: 'duplicate' to merge, 'distinct' to keep both" })),
      limit: Type.Optional(Type.Number({ description: "Max pairs to fetch (default 5)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const action = params.action as string;

      if (action === "list") {
        const limit = (params.limit as number) || 5;
        const pendings = deps.store.getPendingDedups(limit);
        if (pendings.length === 0) {
          return textResult("No pending dedup reviews.");
        }

        const pairs = pendings.map((p) => {
          const newMem = deps.store.get(p.new_memory_id);
          const existMem = deps.store.get(p.existing_memory_id);
          return {
            pending_id: p.id,
            similarity: p.similarity.toFixed(3),
            memory_a: existMem ? { id: existMem.id, content: existMem.content, agent_id: existMem.agent_id, org_id: existMem.org_id, project_id: existMem.project_id, type: existMem.memory_type } : { id: p.existing_memory_id, content: "[deleted]" },
            memory_b: newMem ? { id: newMem.id, content: newMem.content, agent_id: newMem.agent_id, org_id: newMem.org_id, project_id: newMem.project_id, type: newMem.memory_type } : { id: p.new_memory_id, content: "[deleted]" },
          };
        });

        const total = deps.store.getPendingDedupCount();
        return jsonResult({ total_pending: total, showing: pairs.length, pairs });
      }

      if (action === "resolve") {
        const pendingId = params.pendingId as string;
        const decision = params.decision as string;
        if (!pendingId || !decision) {
          return textResult("resolve requires pendingId and decision.");
        }
        const status = decision === "duplicate" ? "confirmed_dup" : "confirmed_distinct";
        const ok = deps.store.resolvePendingDedup(pendingId, status as "confirmed_dup" | "confirmed_distinct");
        if (!ok) return textResult(`Pending dedup record not found: ${pendingId}`);
        deps.logger.info(`engram: dedup resolved ${pendingId} as ${status}`);
        return textResult(`Resolved as ${decision}. ${decision === "duplicate" ? "Memories merged." : "Kept both memories."}`);
      }

      return textResult("Unknown action. Use 'list' or 'resolve'.");
    },
  };
}
