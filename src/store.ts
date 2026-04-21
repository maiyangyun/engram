// Engram Storage Layer — SQLite + sqlite-vec
// Five-dimensional ownership: user_id, agent_id, org_id, project_id, memory_type
// v0.4: Memory decay — last_recalled_at tracking + time-weighted scoring

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type MemoryType = "semantic" | "episodic" | "procedural";

export interface MemoryRecord {
  id: string;
  user_id: string;
  agent_id: string | null;
  org_id: string | null;
  project_id: string | null;
  memory_type: MemoryType;
  content: string;
  embedding: Float32Array | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  last_recalled_at: string | null;
}

export interface AddMemoryInput {
  user_id: string;
  agent_id?: string | null;
  org_id?: string | null;
  project_id?: string | null;
  memory_type: MemoryType;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  user_id: string;
  agent_id?: string | null;
  org_id?: string | null;
  project_id?: string | null;
  memory_type?: MemoryType;
  embedding: number[];
  top_k?: number;
  threshold?: number;
}

export interface VisibilityContext {
  user_id: string;
  agent_id: string;
  org_id?: string | null;
  project_id?: string | null;
  // v0.4: Agent's full membership for cross-org visibility
  memberOrgs?: string[];     // all orgs this agent belongs to
  memberProjects?: string[]; // all projects this agent belongs to
}

export interface SearchResult extends MemoryRecord {
  score: number;
}

export interface ListOptions {
  user_id: string;
  agent_id?: string | null;
  org_id?: string | null;
  project_id?: string | null;
  memory_type?: MemoryType;
  limit?: number;
  offset?: number;
}

export interface AddMemoryResult extends MemoryRecord {
  dedupAction: "added" | "updated" | "pending";
}

export interface PendingDedup {
  id: string;
  new_memory_id: string;
  existing_memory_id: string;
  similarity: number;
  status: "pending" | "confirmed_dup" | "confirmed_distinct";
  created_at: string;
  resolved_at: string | null;
}

const DEDUP_THRESHOLD_SAME_SCOPE = 0.88;
const DEDUP_THRESHOLD_CROSS_SCOPE = 0.92;
const DEDUP_GRAY_ZONE_LOW = 0.85;
// Gray zone: DEDUP_GRAY_ZONE_LOW (0.85) to DEDUP_THRESHOLD_CROSS_SCOPE (0.92)

// v0.4: Memory decay constants
// Memories lose relevance over time unless recalled. The decay function is:
//   decayFactor = 1 / (1 + daysSinceLastActive * DECAY_RATE)
// where lastActive = max(last_recalled_at, updated_at, created_at)
const DECAY_RATE = 0.03;           // Gentle decay: 50% weight at ~33 days idle
const DECAY_FLOOR = 0.1;           // Never decay below 10% weight
const DECAY_BLEND = 0.3;           // 30% decay influence on final score (70% pure similarity)

export class EngramStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT,
        org_id TEXT,
        project_id TEXT,
        memory_type TEXT NOT NULL CHECK(memory_type IN ('semantic', 'episodic', 'procedural')),
        content TEXT NOT NULL,
        embedding BLOB,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
      CREATE INDEX IF NOT EXISTS idx_memories_org ON memories(org_id);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_five_dim ON memories(user_id, agent_id, org_id, project_id);
    `);

    // v0.4: Add last_recalled_at column (migration-safe)
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN last_recalled_at TEXT`);
    } catch {
      // Column already exists — expected on subsequent runs
    }

    // v0.5: Pending dedup table for gray-zone review
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_dedup (
        id TEXT PRIMARY KEY,
        new_memory_id TEXT NOT NULL,
        existing_memory_id TEXT NOT NULL,
        similarity REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed_dup', 'confirmed_distinct')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_dedup_status ON pending_dedup(status);
    `);
  }

  add(input: AddMemoryInput): AddMemoryResult {
    // v0.5: Normalize dimensions at entry point
    const normOrgId = input.org_id ? input.org_id.toLowerCase().trim() : null;
    const normProjectId = input.project_id ? input.project_id.toLowerCase().trim() : null;
    const normAgentId = input.agent_id ?? null;

    if (input.embedding) {
      // Layer 1: Cross-scope dedup — search by user_id only, high threshold
      const globalSimilar = this.findSimilarGlobal(input.embedding, DEDUP_GRAY_ZONE_LOW, input.user_id);

      if (globalSimilar.length > 0) {
        const best = globalSimilar[0];

        if (best.score >= DEDUP_THRESHOLD_CROSS_SCOPE) {
          // High confidence duplicate across any scope → update existing
          this.update(best.id, input.content, input.embedding);
          const updated = this.get(best.id)!;
          return { ...updated, dedupAction: "updated" };
        }

        if (best.score >= DEDUP_GRAY_ZONE_LOW) {
          // Gray zone — write the new memory but record pending dedup for user review
          const newId = this._insertMemory(input.user_id, normAgentId, normOrgId, normProjectId, input.memory_type, input.content, input.embedding, input.metadata);
          this._addPendingDedup(newId, best.id, best.score);
          const record = this.get(newId)!;
          return { ...record, dedupAction: "pending" };
        }
      }

      // Layer 2: Same-scope dedup — existing logic with normalized dimensions
      const scopedSimilar = this.findSimilar(input.embedding, DEDUP_THRESHOLD_SAME_SCOPE, {
        user_id: input.user_id,
        agent_id: normAgentId,
        org_id: normOrgId,
        project_id: normProjectId,
      });

      if (scopedSimilar.length > 0) {
        const existing = scopedSimilar[0];
        this.update(existing.id, input.content, input.embedding);
        const updated = this.get(existing.id)!;
        return { ...updated, dedupAction: "updated" };
      }
    }

    const newId = this._insertMemory(input.user_id, normAgentId, normOrgId, normProjectId, input.memory_type, input.content, input.embedding, input.metadata);
    const record = this.get(newId)!;
    return { ...record, dedupAction: "added" };
  }

  private _insertMemory(
    userId: string, agentId: string | null, orgId: string | null, projectId: string | null,
    memoryType: MemoryType, content: string, embedding?: number[], metadata?: Record<string, unknown>,
  ): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const embeddingBlob = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    this.db.prepare(`
      INSERT INTO memories (id, user_id, agent_id, org_id, project_id, memory_type, content, embedding, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, agentId, orgId, projectId, memoryType, content, embeddingBlob, metadataJson, now, now);

    return id;
  }

  private _addPendingDedup(newMemoryId: string, existingMemoryId: string, similarity: number): void {
    // Skip if this pair already has a resolved record (confirmed_distinct)
    const existing = this.db.prepare(
      `SELECT id FROM pending_dedup WHERE
        ((new_memory_id = ? AND existing_memory_id = ?) OR (new_memory_id = ? AND existing_memory_id = ?))
        AND status = 'confirmed_distinct'`
    ).get(existingMemoryId, newMemoryId, newMemoryId, existingMemoryId) as { id: string } | undefined;
    if (existing) return;

    this.db.prepare(`
      INSERT INTO pending_dedup (id, new_memory_id, existing_memory_id, similarity, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(crypto.randomUUID(), newMemoryId, existingMemoryId, similarity);
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as RawRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  update(id: string, content: string, embedding?: number[]): boolean {
    const now = new Date().toISOString();
    const embeddingBlob = embedding
      ? Buffer.from(new Float32Array(embedding).buffer)
      : undefined;

    let result;
    if (embeddingBlob !== undefined) {
      result = this.db.prepare(
        "UPDATE memories SET content = ?, embedding = ?, updated_at = ? WHERE id = ?"
      ).run(content, embeddingBlob, now, id);
    } else {
      result = this.db.prepare(
        "UPDATE memories SET content = ?, updated_at = ? WHERE id = ?"
      ).run(content, now, id);
    }
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * v2 visibility model: A memory is visible to an agent if:
   * 1. agent_id matches (own memories, always visible), OR
   * 2. Memory has org_id in agent's member orgs AND (no project_id OR project_id in agent's member projects)
   * 3. Legacy: agent_id IS NULL memories are visible if org/project matches (backward compat)
   */
  searchWithVisibility(ctx: VisibilityContext, queryEmbedding: number[], memoryType?: MemoryType, topK = 10, threshold = 0.0, broadScope = false): SearchResult[] {
    const queryEmb = new Float32Array(queryEmbedding);

    const conditions: string[] = [
      "user_id = ?",
      "embedding IS NOT NULL",
    ];
    const params: unknown[] = [
      ctx.user_id,
    ];

    // v2: broadScope skips org/project filtering (for manual search "all" scope)
    if (!broadScope) {
      const orgList = ctx.memberOrgs && ctx.memberOrgs.length > 0
        ? ctx.memberOrgs
        : ctx.org_id ? [ctx.org_id] : [];
      const projList = ctx.memberProjects && ctx.memberProjects.length > 0
        ? ctx.memberProjects
        : ctx.project_id ? [ctx.project_id] : [];

      // v2 visibility: own memories OR org/project-shared memories
      const visibilityParts: string[] = [];

      // 1. Own memories (agent_id matches)
      visibilityParts.push("agent_id = ?");
      params.push(ctx.agent_id);

      // 2. Org/project-shared memories (org_id in member orgs, project_id null or in member projects)
      if (orgList.length > 0) {
        const orgPlaceholders = orgList.map(() => "?").join(", ");
        if (projList.length > 0) {
          const projPlaceholders = projList.map(() => "?").join(", ");
          visibilityParts.push(`(org_id IN (${orgPlaceholders}) AND (project_id IS NULL OR project_id IN (${projPlaceholders})))`);
          params.push(...orgList, ...projList);
        } else {
          visibilityParts.push(`(org_id IN (${orgPlaceholders}) AND project_id IS NULL)`);
          params.push(...orgList);
        }
      }

      // 3. Legacy backward compat: agent_id IS NULL with matching org/project
      if (orgList.length > 0) {
        const orgPlaceholders = orgList.map(() => "?").join(", ");
        if (projList.length > 0) {
          const projPlaceholders = projList.map(() => "?").join(", ");
          visibilityParts.push(`(agent_id IS NULL AND org_id IN (${orgPlaceholders}) AND (project_id IS NULL OR project_id IN (${projPlaceholders})))`);
          params.push(...orgList, ...projList);
        } else {
          visibilityParts.push(`(agent_id IS NULL AND org_id IN (${orgPlaceholders}))`);
          params.push(...orgList);
        }
      } else {
        // No org membership: only see own + legacy null-agent with null-org
        visibilityParts.push("(agent_id IS NULL AND org_id IS NULL)");
      }

      conditions.push(`(${visibilityParts.join(" OR ")})`);
    }

    if (memoryType) {
      conditions.push("memory_type = ?");
      params.push(memoryType);
    }

    const sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")}`;
    const rows = this.db.prepare(sql).all(...params) as RawRow[];

    // Compute cosine similarity with decay weighting, filter, sort, take top_k
    const now = Date.now();
    const scored: SearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const rowEmbedding = new Float32Array(
        (row.embedding as Buffer).buffer,
        (row.embedding as Buffer).byteOffset,
        (row.embedding as Buffer).byteLength / 4,
      );
      const similarity = cosineSimilarity(queryEmb, rowEmbedding);
      if (similarity < threshold) continue;
      const decay = computeDecay(row, now);
      const score = similarity * (1 - DECAY_BLEND) + similarity * decay * DECAY_BLEND;
      scored.push({ ...this.rowToRecord(row), score });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Direct vector search with explicit filters (for manual tool calls).
   */
  vectorSearch(opts: SearchOptions): SearchResult[] {
    const queryEmbedding = new Float32Array(opts.embedding);
    const topK = opts.top_k ?? 10;
    const threshold = opts.threshold ?? 0.0;

    // Get all candidate rows matching the dimensional filters
    const { sql, params } = this.buildFilterQuery(opts);
    const rows = this.db.prepare(sql).all(...params) as RawRow[];

    // Compute cosine similarity with decay weighting
    const now = Date.now();
    const scored: SearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const rowEmbedding = new Float32Array(
        (row.embedding as Buffer).buffer,
        (row.embedding as Buffer).byteOffset,
        (row.embedding as Buffer).byteLength / 4,
      );
      const similarity = cosineSimilarity(queryEmbedding, rowEmbedding);
      if (similarity < threshold) continue;
      const decay = computeDecay(row, now);
      const score = similarity * (1 - DECAY_BLEND) + similarity * decay * DECAY_BLEND;
      scored.push({ ...this.rowToRecord(row), score });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  list(opts: ListOptions): MemoryRecord[] {
    const conditions: string[] = ["user_id = ?"];
    const params: unknown[] = [opts.user_id];

    if (opts.agent_id !== undefined) {
      if (opts.agent_id === null) {
        conditions.push("agent_id IS NULL");
      } else {
        conditions.push("agent_id = ?");
        params.push(opts.agent_id);
      }
    }
    if (opts.org_id !== undefined) {
      if (opts.org_id === null) {
        conditions.push("org_id IS NULL");
      } else {
        conditions.push("org_id = ?");
        params.push(opts.org_id);
      }
    }
    if (opts.project_id !== undefined) {
      if (opts.project_id === null) {
        conditions.push("project_id IS NULL");
      } else {
        conditions.push("project_id = ?");
        params.push(opts.project_id);
      }
    }
    if (opts.memory_type) {
      conditions.push("memory_type = ?");
      params.push(opts.memory_type);
    }

    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  deleteAll(userId: string, agentId?: string): number {
    if (agentId) {
      const result = this.db.prepare("DELETE FROM memories WHERE user_id = ? AND agent_id = ?").run(userId, agentId);
      return result.changes;
    }
    const result = this.db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
    return result.changes;
  }

  /**
   * v0.4: Mark memories as recently recalled, resetting their decay clock.
   */
  touchRecalled(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE memories SET last_recalled_at = ? WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    });
    tx();
  }

  // --- Pending dedup methods ---

  getPendingDedups(limit = 10): PendingDedup[] {
    const rows = this.db.prepare(
      `SELECT * FROM pending_dedup WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
    ).all(limit) as PendingDedup[];
    return rows;
  }

  getPendingDedupCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM pending_dedup WHERE status = 'pending'`
    ).get() as { cnt: number };
    return row.cnt;
  }

  resolvePendingDedup(id: string, action: "confirmed_dup" | "confirmed_distinct"): boolean {
    const now = new Date().toISOString();
    const pending = this.db.prepare(`SELECT * FROM pending_dedup WHERE id = ?`).get(id) as PendingDedup | undefined;
    if (!pending) return false;

    if (action === "confirmed_dup") {
      // Merge: keep the existing (older) memory, delete the newer one
      // But first update existing with newer content if it's longer/better
      const newMem = this.get(pending.new_memory_id);
      const existingMem = this.get(pending.existing_memory_id);
      if (newMem && existingMem && newMem.content.length > existingMem.content.length) {
        this.update(existingMem.id, newMem.content, newMem.embedding ? Array.from(newMem.embedding) : undefined);
      }
      if (newMem) this.delete(pending.new_memory_id);
    }

    this.db.prepare(
      `UPDATE pending_dedup SET status = ?, resolved_at = ? WHERE id = ?`
    ).run(action, now, id);
    return true;
  }

  close(): void {
    this.db.close();
  }

  /**
   * v0.5: Global similarity search — only filters by user_id, ignores all dimensional scopes.
   * Used for cross-scope dedup detection.
   */
  findSimilarGlobal(embedding: number[], threshold: number, userId: string): SearchResult[] {
    const queryEmbedding = new Float32Array(embedding);
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND embedding IS NOT NULL`
    ).all(userId) as RawRow[];

    const scored: SearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const rowEmbedding = new Float32Array(
        (row.embedding as Buffer).buffer,
        (row.embedding as Buffer).byteOffset,
        (row.embedding as Buffer).byteLength / 4,
      );
      const score = cosineSimilarity(queryEmbedding, rowEmbedding);
      if (score >= threshold) {
        scored.push({ ...this.rowToRecord(row), score });
      }
    }

    return scored.sort((a, b) => b.score - a.score);
  }

  findSimilar(
    embedding: number[],
    threshold: number,
    filters: {
      user_id: string;
      agent_id?: string | null;
      org_id?: string | null;
      project_id?: string | null;
    },
  ): SearchResult[] {
    const queryEmbedding = new Float32Array(embedding);

    const { sql, params } = this.buildFilterQuery({
      user_id: filters.user_id,
      agent_id: filters.agent_id,
      org_id: filters.org_id,
      project_id: filters.project_id,
      embedding,
    });
    const rows = this.db.prepare(sql).all(...params) as RawRow[];

    const scored: SearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const rowEmbedding = new Float32Array(
        (row.embedding as Buffer).buffer,
        (row.embedding as Buffer).byteOffset,
        (row.embedding as Buffer).byteLength / 4,
      );
      const score = cosineSimilarity(queryEmbedding, rowEmbedding);
      if (score >= threshold) {
        scored.push({ ...this.rowToRecord(row), score });
      }
    }

    return scored.sort((a, b) => b.score - a.score);
  }

  // --- Private helpers ---

  private buildFilterQuery(opts: SearchOptions): { sql: string; params: unknown[] } {
    const conditions: string[] = ["user_id = ?", "embedding IS NOT NULL"];
    const params: unknown[] = [opts.user_id];

    if (opts.agent_id !== undefined) {
      if (opts.agent_id === null) {
        conditions.push("agent_id IS NULL");
      } else {
        conditions.push("agent_id = ?");
        params.push(opts.agent_id);
      }
    }
    if (opts.org_id !== undefined) {
      if (opts.org_id === null) {
        conditions.push("org_id IS NULL");
      } else {
        conditions.push("org_id = ?");
        params.push(opts.org_id);
      }
    }
    if (opts.project_id !== undefined) {
      if (opts.project_id === null) {
        conditions.push("project_id IS NULL");
      } else {
        conditions.push("project_id = ?");
        params.push(opts.project_id);
      }
    }
    if (opts.memory_type) {
      conditions.push("memory_type = ?");
      params.push(opts.memory_type);
    }

    return {
      sql: `SELECT * FROM memories WHERE ${conditions.join(" AND ")}`,
      params,
    };
  }

  private rowToRecord(row: RawRow): MemoryRecord {
    return {
      id: row.id,
      user_id: row.user_id,
      agent_id: row.agent_id,
      org_id: row.org_id,
      project_id: row.project_id,
      memory_type: row.memory_type as MemoryType,
      content: row.content,
      embedding: row.embedding
        ? new Float32Array(
            (row.embedding as Buffer).buffer,
            (row.embedding as Buffer).byteOffset,
            (row.embedding as Buffer).byteLength / 4,
          )
        : null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_recalled_at: row.last_recalled_at,
    };
  }
}

interface RawRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  org_id: string | null;
  project_id: string | null;
  memory_type: string;
  content: string;
  embedding: Buffer | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  last_recalled_at: string | null;
}

/**
 * v0.4: Compute decay factor for a memory based on how recently it was active.
 * Returns a value between DECAY_FLOOR and 1.0.
 * lastActive = max(last_recalled_at, updated_at, created_at)
 */
function computeDecay(row: RawRow, nowMs: number): number {
  const lastActive = row.last_recalled_at ?? row.updated_at ?? row.created_at;
  const lastActiveMs = new Date(lastActive).getTime();
  const daysSince = Math.max(0, (nowMs - lastActiveMs) / (1000 * 60 * 60 * 24));
  const factor = 1 / (1 + daysSince * DECAY_RATE);
  return Math.max(DECAY_FLOOR, factor);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
