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

const engramPlugin = definePluginEntry({
  id: "engram",
  name: "Engram Memory",
  description: "Enterprise-grade multi-agent collaborative memory system with five-dimensional ownership",
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
