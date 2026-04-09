// Engram — Enterprise-grade multi-agent collaborative memory system
// OpenClaw plugin entry point

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig, resolveDbPath } from "./config.js";
import { EngramStore } from "./store.js";
import { OllamaEmbeddingProvider } from "./embedding.js";
import { OllamaLLMProvider } from "./extraction.js";
import {
  createMemorySearchTool,
  createMemoryAddTool,
  createMemoryGetTool,
  createMemoryListTool,
  createMemoryUpdateTool,
  createMemoryDeleteTool,
} from "./tools.js";
import { registerAutoRecall, registerAutoCapture } from "./hooks.js";

const engramConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) return { success: true as const, data: undefined };
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { success: false as const, error: { message: "expected config object" } };
    return { success: true as const, data: value };
  },
  jsonSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      userId: { type: "string", description: "Root user ID for scoping memories" },
      defaultOrgId: { type: "string", description: "Default org_id for memory operations when not explicitly specified" },
      defaultProjectId: { type: "string", description: "Default project_id for memory operations when not explicitly specified" },
      autoCapture: { type: "boolean", description: "Automatically extract and store memories from conversations after each agent turn" },
      autoRecall: { type: "boolean", description: "Automatically inject relevant memories into agent context before each turn" },
      extractionModel: { type: "string", description: "LLM model for memory extraction in auto-capture pipeline. Format: provider/model" },
      embeddingModel: { type: "string", description: "Embedding model for vector search. Format: provider/model" },
      ollamaBaseUrl: { type: "string", description: "Base URL for Ollama API" },
      dbPath: { type: "string", description: "Path to SQLite database file" },
      searchThreshold: { type: "number", description: "Minimum similarity score for search results (0-1)" },
      topK: { type: "number", description: "Maximum number of memories to retrieve per search" },
      customInstructions: { type: "string", description: "Custom instructions for memory extraction LLM" },
      sharedKeywords: { type: "array", items: { type: "string" }, description: "Keywords that trigger shared visibility (agent_id=null) for auto-captured memories" },
    },
  },
  uiHints: {
    "userId": { label: "User ID", placeholder: "default" },
    "defaultOrgId": { label: "Default Organization ID", placeholder: "home" },
    "defaultProjectId": { label: "Default Project ID", placeholder: "bonbon" },
    "autoCapture": { label: "Auto-Capture" },
    "autoRecall": { label: "Auto-Recall" },
    "extractionModel": { label: "Extraction Model", placeholder: "ollama/qwen3:8b" },
    "embeddingModel": { label: "Embedding Model", placeholder: "ollama/nomic-embed-text" },
    "ollamaBaseUrl": { label: "Ollama Base URL", placeholder: "http://localhost:11434" },
    "dbPath": { label: "Database Path", placeholder: "~/.engram/engram.db" },
    "searchThreshold": { label: "Search Threshold", placeholder: "0.5" },
    "topK": { label: "Top K Results", placeholder: "10" },
    "customInstructions": { label: "Custom Instructions" },
    "sharedKeywords": { label: "Shared Keywords", help: "Keywords that auto-promote memories to shared visibility" },
  },
};

const engramPlugin = definePluginEntry({
  id: "engram",
  name: "Engram Memory",
  description: "Enterprise-grade multi-agent collaborative memory system with five-dimensional ownership",
  configSchema: engramConfigSchema,
  register(api) {
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown>);
    const dbPath = resolveDbPath(cfg.dbPath);

    // Initialize storage
    const store = new EngramStore(dbPath);

    // Initialize embedding provider
    const embedder = new OllamaEmbeddingProvider({
      model: cfg.embeddingModel.model,
      baseUrl: cfg.ollamaBaseUrl,
    });

    // Initialize LLM provider (for extraction pipeline)
    const llm = new OllamaLLMProvider({
      model: cfg.extractionModel.model,
      baseUrl: cfg.ollamaBaseUrl,
    });

    const toolDeps = { store, embedder, config: cfg, logger: api.logger };

    // Register tools (drop-in compatible with openclaw-mem0)
    api.registerTool(createMemorySearchTool(toolDeps));
    api.registerTool(createMemoryAddTool(toolDeps));
    api.registerTool(createMemoryGetTool(toolDeps));
    api.registerTool(createMemoryListTool(toolDeps));
    api.registerTool(createMemoryUpdateTool(toolDeps));
    api.registerTool(createMemoryDeleteTool(toolDeps));

    // Register hooks
    const hookDeps = { api: api as unknown as Parameters<typeof registerAutoRecall>[0]["api"], store, embedder, llm, config: cfg };

    if (cfg.autoRecall) {
      registerAutoRecall(hookDeps);
      api.logger.info("engram: autoRecall enabled");
    }

    if (cfg.autoCapture) {
      registerAutoCapture(hookDeps);
      api.logger.info("engram: autoCapture enabled");
    }

    // Register background service
    api.registerService({
      id: "engram",
      start: () => {
        api.logger.info(
          `engram: initialized (db: ${dbPath}, user: ${cfg.userId}, org: ${cfg.defaultOrgId ?? "none"}, project: ${cfg.defaultProjectId ?? "none"}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
        );
      },
      stop: () => {
        store.close();
        api.logger.info("engram: stopped");
      },
    });
  },
});

export default engramPlugin;
