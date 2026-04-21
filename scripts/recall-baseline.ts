/**
 * Engram v0.5 Recall Precision Experiment — Baseline Data Collection
 * 
 * Samples N random memories as simulated queries, runs them through
 * the current recall pipeline, and records score distributions.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const DB_PATH = process.env.HOME + "/.engram/engram.db";
const db = new Database(DB_PATH, { readonly: true });

// Get all memories with embeddings
const allRows = db.prepare(`
  SELECT id, content, embedding, agent_id, org_id, project_id, memory_type,
         LENGTH(content) as content_len
  FROM memories WHERE embedding IS NOT NULL
`).all() as Array<{
  id: string; content: string; embedding: Buffer;
  agent_id: string | null; org_id: string | null; project_id: string | null;
  memory_type: string; content_len: number;
}>;

console.log(`Total memories with embeddings: ${allRows.length}`);

// Sample 50 random memories as "queries"
const sampleSize = Math.min(50, allRows.length);
const shuffled = allRows.sort(() => Math.random() - 0.5);
const samples = shuffled.slice(0, sampleSize);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

const stats = {
  queriesRun: 0,
  avgResultsAt05: 0,   // threshold 0.5
  avgResultsAt06: 0,   // threshold 0.6
  avgResultsAt065: 0,  // threshold 0.65
  avgTopScore: 0,
  avgBottomScore05: 0,
  scoreGaps: [] as number[],  // gaps between consecutive results
  totalTokensAt05: 0,
  totalTokensAt06: 0,
};

for (const sample of samples) {
  const queryEmb = new Float32Array(
    sample.embedding.buffer,
    sample.embedding.byteOffset,
    sample.embedding.byteLength / 4,
  );

  // Score all other memories
  const scored: Array<{ score: number; len: number }> = [];
  for (const row of allRows) {
    if (row.id === sample.id) continue;
    const rowEmb = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    const score = cosine(queryEmb, rowEmb);
    scored.push({ score, len: row.content_len });
  }
  scored.sort((a, b) => b.score - a.score);

  const top10 = scored.slice(0, 10);
  const at05 = scored.filter(s => s.score >= 0.5);
  const at06 = scored.filter(s => s.score >= 0.6);
  const at065 = scored.filter(s => s.score >= 0.65);

  stats.queriesRun++;
  stats.avgResultsAt05 += Math.min(at05.length, 10);
  stats.avgResultsAt06 += Math.min(at06.length, 10);
  stats.avgResultsAt065 += Math.min(at065.length, 10);
  stats.avgTopScore += top10[0]?.score ?? 0;
  stats.avgBottomScore05 += top10[Math.min(top10.length, at05.length) - 1]?.score ?? 0;
  stats.totalTokensAt05 += at05.slice(0, 10).reduce((s, r) => s + r.len / 3.5, 0);
  stats.totalTokensAt06 += at06.slice(0, 10).reduce((s, r) => s + r.len / 3.5, 0);

  // Record score gaps in top 10
  for (let i = 0; i < top10.length - 1; i++) {
    stats.scoreGaps.push(top10[i].score - top10[i + 1].score);
  }
}

const n = stats.queriesRun;
console.log(`\n=== BASELINE RECALL STATS (${n} queries) ===`);
console.log(`Avg results @ threshold 0.50: ${(stats.avgResultsAt05 / n).toFixed(1)}`);
console.log(`Avg results @ threshold 0.60: ${(stats.avgResultsAt06 / n).toFixed(1)}`);
console.log(`Avg results @ threshold 0.65: ${(stats.avgResultsAt065 / n).toFixed(1)}`);
console.log(`Avg top score: ${(stats.avgTopScore / n).toFixed(3)}`);
console.log(`Avg bottom score (top10 @ 0.5): ${(stats.avgBottomScore05 / n).toFixed(3)}`);
console.log(`Avg tokens/query @ 0.50: ${Math.round(stats.totalTokensAt05 / n)}`);
console.log(`Avg tokens/query @ 0.60: ${Math.round(stats.totalTokensAt06 / n)}`);

// Score gap analysis
const gaps = stats.scoreGaps;
gaps.sort((a, b) => a - b);
console.log(`\nScore gap distribution (between consecutive results):`);
console.log(`  p25: ${gaps[Math.floor(gaps.length * 0.25)]?.toFixed(4)}`);
console.log(`  p50: ${gaps[Math.floor(gaps.length * 0.5)]?.toFixed(4)}`);
console.log(`  p75: ${gaps[Math.floor(gaps.length * 0.75)]?.toFixed(4)}`);
console.log(`  p90: ${gaps[Math.floor(gaps.length * 0.9)]?.toFixed(4)}`);
console.log(`  p95: ${gaps[Math.floor(gaps.length * 0.95)]?.toFixed(4)}`);
console.log(`  max: ${gaps[gaps.length - 1]?.toFixed(4)}`);

db.close();
