#!/usr/bin/env node
// migrate-embeddings.mjs — Re-embed all memories with bge-m3
// Usage: node migrate-embeddings.mjs

import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";

const DB_PATH = join(homedir(), ".engram", "engram.db");
const MODEL = "bge-m3";
const OLLAMA_URL = "http://localhost:11434/api/embed";
const BATCH_SIZE = 10;

async function embed(texts) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embeddings;
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const rows = db.prepare("SELECT id, content FROM memories ORDER BY created_at").all();
  console.log(`Found ${rows.length} memories to re-embed`);

  const update = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => r.content);

    try {
      const embeddings = await embed(texts);
      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const blob = Buffer.from(new Float32Array(embeddings[j]).buffer);
          update.run(blob, batch[j].id);
        }
      });
      tx();
      done += batch.length;
      process.stdout.write(`\r  ${done}/${rows.length} re-embedded`);
    } catch (err) {
      console.error(`\nBatch ${i} failed: ${err.message}`);
      // Continue with next batch
    }
  }

  console.log(`\nDone. ${done}/${rows.length} memories migrated to ${MODEL}`);
  db.close();
}

main().catch(console.error);
