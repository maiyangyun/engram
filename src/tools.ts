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
    agent_id: opts.agentId || null,
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
      ], { description: "Search scope: personal (agent-only), shared (agent=NULL), all (visibility merge)" })),
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

        if (scope === "all" && ctx.agent_id) {
          // Use five-layer visibility merge
          results = deps.store.searchWithVisibility(
            { user_id: deps.config.userId, agent_id: ctx.agent_id, org_id: ctx.org_id, project_id: ctx.project_id },
            embedding,
            memoryType,
            limit,
            deps.config.searchThreshold,
          );
        } else {
          // Direct search with explicit filters
          results = deps.store.vectorSearch({
            user_id: deps.config.userId,
            agent_id: scope === "shared" ? null : ctx.agent_id,
            org_id: ctx.org_id,
            project_id: ctx.project_id,
            memory_type: memoryType,
            embedding,
            top_k: limit,
            threshold: deps.config.searchThreshold,
          });
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
      // If visibility=shared, clear agent_id so all agents can see it
      if (params.visibility === "shared") {
        ctx.agent_id = null;
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
        const dedupInfo = updated > 0 ? ` (${added} added, ${updated} updated)` : "";

        return jsonResult({
          results: results.map((r) => ({
            id: r.id,
            memory: r.content,
            memory_type: r.memory_type,
            event: r.dedupAction === "updated" ? "UPDATE" : "ADD",
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
