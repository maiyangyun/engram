// Engram Configuration
// v0.4: Auto-discovery of dimensions from LLM extraction

import type { MemoryType } from "./store.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// --- Dimension v2 types ---

export interface DimensionOrg {
  id: string;
  aliases: string[];
}

export interface DimensionProject {
  id: string;
  org: string | null;
  aliases: string[];
}

export interface AgentMembership {
  org: string;
  projects: string[];
  leads?: string[];
}

export interface AgentConfig {
  memberships: AgentMembership[];
}

export interface EngramConfig {
  userId: string;
  defaultOrgId: string | null;
  defaultProjectId: string | null;
  autoCapture: boolean;
  autoRecall: boolean;
  extractionModel: { provider: string; model: string };
  embeddingModel: { provider: string; model: string };
  geminiApiKey: string | null;
  ollamaBaseUrl: string;
  dbPath: string;
  searchThreshold: number;
  topK: number;
  customInstructions: string | null;
  // Flat string arrays (backward compat, used by extraction prompt)
  knownOrgs: string[];
  knownProjects: string[];
  // v2 structured dimensions
  dimensionOrgs: DimensionOrg[];
  dimensionProjects: DimensionProject[];
  projectOrgMap: Record<string, string>; // project_id → org_id
  agents: Record<string, AgentConfig>;
  // v2: Mutable request-scoped agent context (set by hooks, read by tools)
  _activeAgentId: string | null;
}

export function parseConfig(raw: Record<string, unknown>): EngramConfig {
  const parseModelRef = (val: unknown, fallback: { provider: string; model: string }) => {
    if (typeof val !== "string" || !val) return fallback;
    const parts = val.split("/");
    if (parts.length >= 2) return { provider: parts[0], model: parts.slice(1).join("/") };
    return fallback;
  };

  const dbPath = (raw.dbPath as string) || "~/.engram/engram.db";
  const dims = loadDimensions(dbPath);

  return {
    userId: (raw.userId as string) || "default",
    defaultOrgId: (raw.defaultOrgId as string) || null,
    defaultProjectId: (raw.defaultProjectId as string) || null,
    autoCapture: raw.autoCapture !== false,
    autoRecall: raw.autoRecall !== false,
    extractionModel: parseModelRef(raw.extractionModel, { provider: "ollama", model: "qwen3.5:9b" }),
    embeddingModel: parseModelRef(raw.embeddingModel, { provider: "ollama", model: "bge-m3" }),
    geminiApiKey: (raw.geminiApiKey as string) || resolveGeminiApiKey(dbPath),
    ollamaBaseUrl: (raw.ollamaBaseUrl as string) || "http://localhost:11434",
    dbPath,
    searchThreshold: typeof raw.searchThreshold === "number" ? raw.searchThreshold : 0.5,
    topK: typeof raw.topK === "number" ? raw.topK : 10,
    customInstructions: (raw.customInstructions as string) || null,
    knownOrgs: Array.isArray(raw.knownOrgs) ? raw.knownOrgs as string[] : dims.knownOrgs,
    knownProjects: Array.isArray(raw.knownProjects) ? raw.knownProjects as string[] : dims.knownProjects,
    dimensionOrgs: dims.dimensionOrgs,
    dimensionProjects: dims.dimensionProjects,
    projectOrgMap: dims.projectOrgMap,
    agents: dims.agents,
    _activeAgentId: null,
  };
}

export function resolveDbPath(dbPath: string): string {
  if (dbPath.startsWith("~")) {
    return dbPath.replace(/^~/, process.env.HOME || "/tmp");
  }
  return dbPath;
}

/**
 * Resolve Gemini API key: env var GEMINI_API_KEY > ~/.engram/gemini.key file > null
 */
function resolveGeminiApiKey(dbPath: string): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const resolvedDb = dbPath.startsWith("~") ? dbPath.replace(/^~/, process.env.HOME || "/tmp") : dbPath;
    const keyPath = join(dirname(resolvedDb), "gemini.key");
    const key = readFileSync(keyPath, "utf-8").trim();
    return key || null;
  } catch {
    return null;
  }
}

export const VALID_MEMORY_TYPES: readonly MemoryType[] = ["semantic", "episodic", "procedural"] as const;

interface DimensionsResult {
  knownOrgs: string[];
  knownProjects: string[];
  dimensionOrgs: DimensionOrg[];
  dimensionProjects: DimensionProject[];
  projectOrgMap: Record<string, string>;
  agents: Record<string, AgentConfig>;
}

function loadDimensions(dbPath: string): DimensionsResult {
  const empty: DimensionsResult = {
    knownOrgs: [], knownProjects: [],
    dimensionOrgs: [], dimensionProjects: [],
    projectOrgMap: {}, agents: {},
  };

  try {
    const resolvedDb = dbPath.startsWith("~") ? dbPath.replace(/^~/, process.env.HOME || "/tmp") : dbPath;
    const dir = dirname(resolvedDb);
    const dimsPath = join(dir, "dimensions.json");
    const raw = readFileSync(dimsPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Parse orgs: support both v1 (string[]) and v2 ({ id, aliases }[])
    const dimensionOrgs: DimensionOrg[] = [];
    const knownOrgs: string[] = [];
    if (Array.isArray(parsed.knownOrgs)) {
      for (const item of parsed.knownOrgs) {
        if (typeof item === "string") {
          // v1 format
          dimensionOrgs.push({ id: item, aliases: [] });
          knownOrgs.push(item);
        } else if (item && typeof item.id === "string") {
          // v2 format
          dimensionOrgs.push({ id: item.id, aliases: Array.isArray(item.aliases) ? item.aliases : [] });
          knownOrgs.push(item.id);
        }
      }
    }

    // Parse projects: support both v1 (string[]) and v2 ({ id, org, aliases }[])
    const dimensionProjects: DimensionProject[] = [];
    const knownProjects: string[] = [];
    const projectOrgMap: Record<string, string> = {};
    if (Array.isArray(parsed.knownProjects)) {
      for (const item of parsed.knownProjects) {
        if (typeof item === "string") {
          dimensionProjects.push({ id: item, org: null, aliases: [] });
          knownProjects.push(item);
        } else if (item && typeof item.id === "string") {
          const org = typeof item.org === "string" ? item.org : null;
          dimensionProjects.push({ id: item.id, org, aliases: Array.isArray(item.aliases) ? item.aliases : [] });
          knownProjects.push(item.id);
          if (org) projectOrgMap[item.id] = org;
        }
      }
    }

    // Parse agents
    const agents: Record<string, AgentConfig> = {};
    if (parsed.agents && typeof parsed.agents === "object") {
      for (const [agentId, agentRaw] of Object.entries(parsed.agents)) {
        const a = agentRaw as Record<string, unknown>;
        if (Array.isArray(a.memberships)) {
          agents[agentId] = {
            memberships: (a.memberships as Array<Record<string, unknown>>).map((m) => ({
              org: String(m.org ?? ""),
              projects: Array.isArray(m.projects) ? m.projects.map(String) : [],
              leads: Array.isArray(m.leads) ? m.leads.map(String) : undefined,
            })),
          };
        }
      }
    }

    return { knownOrgs, knownProjects, dimensionOrgs, dimensionProjects, projectOrgMap, agents };
  } catch {
    return empty;
  }
}

/**
 * v0.4: Resolve the dimensions.json file path from dbPath.
 */
function getDimensionsPath(dbPath: string): string {
  const resolvedDb = dbPath.startsWith("~") ? dbPath.replace(/^~/, process.env.HOME || "/tmp") : dbPath;
  return join(dirname(resolvedDb), "dimensions.json");
}

/**
 * v0.4: Auto-discover new dimensions from LLM extraction results.
 * If a new org_id or project_id is found that's not in the known lists,
 * append it to dimensions.json automatically.
 * Returns true if dimensions.json was updated.
 */
export function autoDiscoverDimensions(
  config: EngramConfig,
  facts: Array<{ org_id: string | null; project_id: string | null }>,
): boolean {
  const newOrgs = new Set<string>();
  const newProjects = new Map<string, string | null>(); // project_id → org_id

  for (const fact of facts) {
    if (fact.org_id && !config.knownOrgs.includes(fact.org_id)) {
      newOrgs.add(fact.org_id);
    }
    if (fact.project_id && !config.knownProjects.includes(fact.project_id)) {
      newProjects.set(fact.project_id, fact.org_id);
    }
  }

  if (newOrgs.size === 0 && newProjects.size === 0) return false;

  try {
    const dimsPath = getDimensionsPath(config.dbPath);
    let parsed: Record<string, unknown> = {};
    if (existsSync(dimsPath)) {
      parsed = JSON.parse(readFileSync(dimsPath, "utf-8"));
    }

    // Ensure arrays exist
    if (!Array.isArray(parsed.knownOrgs)) parsed.knownOrgs = [];
    if (!Array.isArray(parsed.knownProjects)) parsed.knownProjects = [];

    const orgsArr = parsed.knownOrgs as Array<Record<string, unknown> | string>;
    const projsArr = parsed.knownProjects as Array<Record<string, unknown> | string>;

    // Collect existing ids for dedup
    const existingOrgIds = new Set(orgsArr.map((o) => typeof o === "string" ? o : o.id as string));
    const existingProjIds = new Set(projsArr.map((p) => typeof p === "string" ? p : p.id as string));

    let changed = false;

    for (const orgId of newOrgs) {
      if (!existingOrgIds.has(orgId)) {
        orgsArr.push({ id: orgId, aliases: [] });
        existingOrgIds.add(orgId);
        changed = true;
      }
    }

    for (const [projId, orgId] of newProjects) {
      if (!existingProjIds.has(projId)) {
        const entry: Record<string, unknown> = { id: projId, aliases: [] };
        if (orgId) entry.org = orgId;
        projsArr.push(entry);
        existingProjIds.add(projId);
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(dimsPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");

      // Update in-memory config
      for (const orgId of newOrgs) {
        if (!config.knownOrgs.includes(orgId)) {
          config.knownOrgs.push(orgId);
          config.dimensionOrgs.push({ id: orgId, aliases: [] });
        }
      }
      for (const [projId, orgId] of newProjects) {
        if (!config.knownProjects.includes(projId)) {
          config.knownProjects.push(projId);
          config.dimensionProjects.push({ id: projId, org: orgId, aliases: [] });
          if (orgId) config.projectOrgMap[projId] = orgId;
        }
      }
    }

    return changed;
  } catch {
    return false;
  }
}
