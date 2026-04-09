// Engram Configuration

import type { MemoryType } from "./store.js";

export interface EngramConfig {
  userId: string;
  defaultOrgId: string | null;
  defaultProjectId: string | null;
  autoCapture: boolean;
  autoRecall: boolean;
  extractionModel: { provider: string; model: string };
  embeddingModel: { provider: string; model: string };
  ollamaBaseUrl: string;
  dbPath: string;
  searchThreshold: number;
  topK: number;
  customInstructions: string | null;
}

export function parseConfig(raw: Record<string, unknown>): EngramConfig {
  const parseModelRef = (val: unknown, fallback: { provider: string; model: string }) => {
    if (typeof val !== "string" || !val) return fallback;
    const parts = val.split("/");
    if (parts.length >= 2) return { provider: parts[0], model: parts.slice(1).join("/") };
    return fallback;
  };

  return {
    userId: (raw.userId as string) || "default",
    defaultOrgId: (raw.defaultOrgId as string) || null,
    defaultProjectId: (raw.defaultProjectId as string) || null,
    autoCapture: raw.autoCapture !== false,
    autoRecall: raw.autoRecall !== false,
    extractionModel: parseModelRef(raw.extractionModel, { provider: "ollama", model: "qwen3:8b" }),
    embeddingModel: parseModelRef(raw.embeddingModel, { provider: "ollama", model: "nomic-embed-text" }),
    ollamaBaseUrl: (raw.ollamaBaseUrl as string) || "http://localhost:11434",
    dbPath: (raw.dbPath as string) || "~/.engram/engram.db",
    searchThreshold: typeof raw.searchThreshold === "number" ? raw.searchThreshold : 0.5,
    topK: typeof raw.topK === "number" ? raw.topK : 10,
    customInstructions: (raw.customInstructions as string) || null,
  };
}

export function resolveDbPath(dbPath: string): string {
  if (dbPath.startsWith("~")) {
    return dbPath.replace(/^~/, process.env.HOME || "/tmp");
  }
  return dbPath;
}

export const VALID_MEMORY_TYPES: readonly MemoryType[] = ["semantic", "episodic", "procedural"] as const;
