// Engram — Enterprise-grade multi-agent collaborative memory system
// OpenClaw plugin entry point

// @ts-ignore - runtime module is provided by OpenClaw SDK during plugin execution
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig, resolveDbPath } from "./config.js";
import { EngramStore } from "./store.js";
import { OllamaEmbeddingProvider } from "./embedding.js";
import { OllamaLLMProvider, GeminiLLMProvider } from "./extraction.js";
import {
  createMemorySearchTool,
  createMemoryAddTool,
  createMemoryGetTool,
  createMemoryListTool,
  createMemoryUpdateTool,
  createMemoryDeleteTool,
  createDedupReviewTool,
} from "./tools.js";
import { registerAutoRecall, registerAutoCapture } from "./hooks.js";

// Module-level boot state — resets on module re-evaluation (gateway restart)
// NOTE: NOT reliable if Node ESM cache persists across restarts
// Actual dedup uses api instance marker below

const engramConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) return { success: true as const, data: undefined };
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { success: false as const, error: { message: "expected config object" } };
    return { success: true as const, data: value };
  },
  jsonSchema: {
    type: "object" as const,
    additionalProperties: true,
    properties: {
      userId: { type: "string", description: "Root user ID for scoping memories" },
      defaultOrgId: { type: "string", description: "Default org_id for memory operations when not explicitly specified" },
      defaultProjectId: { type: "string", description: "Default project_id for memory operations when not explicitly specified" },
      autoCapture: { type: "boolean", description: "Automatically extract and store memories from conversations after each agent turn" },
      autoRecall: { type: "boolean", description: "Automatically inject relevant memories into agent context before each turn" },
      extractionModel: { type: "string", description: "LLM model for memory extraction in auto-capture pipeline. Format: provider/model (e.g. ollama/qwen3.5:9b or gemini/gemini-2.0-flash)" },
      geminiApiKey: { type: "string", description: "Google Gemini API key. Can also be set via GEMINI_API_KEY env var or ~/.engram/gemini.key file" },
      embeddingModel: { type: "string", description: "Embedding model for vector search. Format: provider/model" },
      ollamaBaseUrl: { type: "string", description: "Base URL for Ollama API" },
      dbPath: { type: "string", description: "Path to SQLite database file" },
      searchThreshold: { type: "number", description: "Minimum similarity score for search results (0-1)" },
      topK: { type: "number", description: "Maximum number of memories to retrieve per search" },
      recallMaxResults: { type: "number", description: "Hard cap on recalled memories injected into context" },
      recallScoreGap: { type: "number", description: "Truncate recall results when score drops sharply between adjacent memories" },
      recallHighConfidence: { type: "number", description: "High-confidence recall score threshold" },
      recallShortMsgMaxResults: { type: "number", description: "Max recalled memories for short prompts" },
      recallStatsLog: { type: "boolean", description: "Log detailed recall experiment stats" },
      extractionWindowMessages: { type: "number", description: "How many recent messages full extraction inspects" },
      extractionWindowChars: { type: "number", description: "Character cap for standard full extraction window" },
      extractionPressureWindowMessages: { type: "number", description: "How many recent messages pressure-triggered extraction inspects" },
      extractionPressureWindowChars: { type: "number", description: "Character cap for pressure-triggered extraction window" },
      customInstructions: { type: "string", description: "Custom instructions for memory extraction LLM" },
      knownOrgs: { type: "array", items: { type: "string" }, description: "Known organization identifiers for LLM dimension inference" },
      knownProjects: { type: "array", items: { type: "string" }, description: "Known project identifiers for LLM dimension inference" },
    },
  },
  uiHints: {
    "userId": { label: "User ID", placeholder: "default" },
    "defaultOrgId": { label: "Default Organization ID", placeholder: "home" },
    "defaultProjectId": { label: "Default Project ID", placeholder: "bonbon" },
    "autoCapture": { label: "Auto-Capture" },
    "autoRecall": { label: "Auto-Recall" },
    "extractionModel": { label: "Extraction Model", placeholder: "gemini/gemini-2.0-flash" },
    "embeddingModel": { label: "Embedding Model", placeholder: "ollama/nomic-embed-text" },
    "ollamaBaseUrl": { label: "Ollama Base URL", placeholder: "http://localhost:11434" },
    "dbPath": { label: "Database Path", placeholder: "~/.engram/engram.db" },
    "searchThreshold": { label: "Search Threshold", placeholder: "0.5" },
    "topK": { label: "Top K Results", placeholder: "10" },
    "recallMaxResults": { label: "Recall Max Results", placeholder: "8" },
    "recallScoreGap": { label: "Recall Score Gap", placeholder: "0.08" },
    "recallHighConfidence": { label: "Recall High Confidence", placeholder: "0.75" },
    "recallShortMsgMaxResults": { label: "Recall Short Msg Max", placeholder: "3" },
    "recallStatsLog": { label: "Recall Stats Log" },
    "extractionWindowMessages": { label: "Extraction Window Messages", placeholder: "30" },
    "extractionWindowChars": { label: "Extraction Window Chars", placeholder: "8000" },
    "extractionPressureWindowMessages": { label: "Pressure Extraction Messages", placeholder: "50" },
    "extractionPressureWindowChars": { label: "Pressure Extraction Chars", placeholder: "16000" },
    "customInstructions": { label: "Custom Instructions" },
    "knownOrgs": { label: "Known Organizations", help: "Organization IDs the LLM can assign to memories" },
    "knownProjects": { label: "Known Projects", help: "Project IDs the LLM can assign to memories" },
  },
};

const engramPlugin = definePluginEntry({
  id: "engram",
  name: "Engram Memory",
  description: "Enterprise-grade multi-agent collaborative memory system with five-dimensional ownership",
  configSchema: engramConfigSchema,
  register(api: any) {
    const fullStack = new Error().stack ?? "";
    const stack = fullStack.split("\n").slice(1, 5).map((s) => s.trim()).join(" | ") || "no-stack";
    const isGatewayPluginLoad = fullStack.includes("loadGatewayPlugins");
    const isRuntimePluginLoad = fullStack.includes("ensureRuntimePluginsLoaded") || fullStack.includes("resolveRuntimePluginRegistry");
    api.logger.info(`engram: register called mode=${api.registrationMode} source=${api.source} root=${api.rootDir ?? "-"} gatewayLoad=${isGatewayPluginLoad} runtimeLoad=${isRuntimePluginLoad} stack=${stack}`);
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
    const llm = cfg.extractionModel.provider === "gemini"
      ? new GeminiLLMProvider({
          model: cfg.extractionModel.model,
          apiKey: cfg.geminiApiKey || "",
        })
      : new OllamaLLMProvider({
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
    api.registerTool(createDedupReviewTool(toolDeps));

    // Register hooks
    const hookDeps = { api: api as unknown as Parameters<typeof registerAutoRecall>[0]["api"], store, embedder, llm, config: cfg };

    // Register hooks only on runtime plugin load.
    // OpenClaw loads plugins twice: gateway boot and runtime plugin registry.
    // Hooks are global, so registering them in both paths causes duplicate recall/capture.
    // Tools/services can exist on both paths, but hooks must only bind once on runtime load.
    const shouldRegisterHooks = isRuntimePluginLoad || !isGatewayPluginLoad;
    if (shouldRegisterHooks) {
      if (cfg.autoRecall) {
        registerAutoRecall(hookDeps);
        api.logger.info("engram: autoRecall enabled");
      }

      if (cfg.autoCapture) {
        registerAutoCapture(hookDeps);
        api.logger.info("engram: autoCapture enabled");
      }
    } else {
      api.logger.info("engram: skipping hook registration during gateway plugin load");
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
