// Engram Storage Layer — SQLite + sqlite-vec
// Five-dimensional ownership: user_id, agent_id, org_id, project_id, memory_type

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
  }

  add(input: AddMemoryInput): MemoryRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const embeddingBlob = input.embedding
      ? Buffer.from(new Float32Array(input.embedding).buffer)
      : null;
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    this.db.prepare(`
      INSERT INTO memories (id, user_id, agent_id, org_id, project_id, memory_type, content, embedding, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.user_id,
      input.agent_id ?? null,
      input.org_id ?? null,
      input.project_id ?? null,
      input.memory_type,
      input.content,
      embeddingBlob,
      metadataJson,
      now,
      now,
    );

    return {
      id,
      user_id: input.user_id,
      agent_id: input.agent_id ?? null,
      org_id: input.org_id ?? null,
      project_id: input.project_id ?? null,
      memory_type: input.memory_type,
      content: input.content,
      embedding: input.embedding ? new Float32Array(input.embedding) : null,
      metadata: input.metadata ?? null,
      created_at: now,
      updated_at: now,
    };
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
   * Five-layer visibility search with vector similarity.
   * Merges results from all visible layers, deduplicates, and ranks by score.
   */
  searchWithVisibility(ctx: VisibilityContext, queryEmbedding: number[], memoryType?: MemoryType, topK = 10, threshold = 0.0): SearchResult[] {
    // Build the five visibility layers
    const layers = this.buildVisibilityLayers(ctx);
    const allResults: SearchResult[] = [];

    for (const layer of layers) {
      const results = this.vectorSearch({
        ...layer,
        user_id: ctx.user_id,
        memory_type: memoryType,
        embedding: queryEmbedding,
        top_k: topK * 2, // fetch more per layer, then merge
        threshold,
      });
      allResults.push(...results);
    }

    // Deduplicate by id, keep highest score
    const seen = new Map<string, SearchResult>();
    for (const r of allResults) {
      const existing = seen.get(r.id);
      if (!existing || r.score > existing.score) {
        seen.set(r.id, r);
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
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

    // Compute cosine similarity in JS (no sqlite-vec dependency for v1)
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

  close(): void {
    this.db.close();
  }

  // --- Private helpers ---

  private buildVisibilityLayers(ctx: VisibilityContext): Array<{ agent_id?: string | null; org_id?: string | null; project_id?: string | null }> {
    const layers: Array<{ agent_id?: string | null; org_id?: string | null; project_id?: string | null }> = [];

    // Layer 1: Agent's project-private memory (agent=X, org=O, project=P)
    if (ctx.org_id && ctx.project_id) {
      layers.push({ agent_id: ctx.agent_id, org_id: ctx.org_id, project_id: ctx.project_id });
    }
    // Layer 2: Project shared memory (agent=NULL, org=O, project=P)
    if (ctx.org_id && ctx.project_id) {
      layers.push({ agent_id: null, org_id: ctx.org_id, project_id: ctx.project_id });
    }
    // Layer 3: Agent's org-level memory (agent=X, org=O, project=NULL)
    if (ctx.org_id) {
      layers.push({ agent_id: ctx.agent_id, org_id: ctx.org_id, project_id: null });
    }
    // Layer 4: Org shared memory (agent=NULL, org=O, project=NULL)
    if (ctx.org_id) {
      layers.push({ agent_id: null, org_id: ctx.org_id, project_id: null });
    }
    // Layer 5: Agent's pure personal memory (agent=X, org=NULL, project=NULL)
    layers.push({ agent_id: ctx.agent_id, org_id: null, project_id: null });

    return layers;
  }

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
