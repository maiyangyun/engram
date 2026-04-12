// Engram Embedding Layer — Ollama-based embedding provider
// v0.4: All requests routed through global Ollama queue to prevent model thrashing

import { ollamaEnqueue } from "./ollama-queue.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions(): number;
}

export interface OllamaEmbeddingConfig {
  model: string;
  baseUrl: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private baseUrl: string;
  private _dimensions: number | null = null;

  constructor(config: OllamaEmbeddingConfig) {
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async embed(text: string): Promise<number[]> {
    return ollamaEnqueue(async (signal) => {
      const resp = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
        signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Ollama embed failed (${resp.status}): ${body}`);
      }

      const data = (await resp.json()) as { embeddings: number[][] };
      const embedding = data.embeddings[0];
      if (!embedding) throw new Error("Ollama returned empty embedding");

      if (this._dimensions === null) this._dimensions = embedding.length;
      return embedding;
    }, { timeoutMs: 30_000 });
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return ollamaEnqueue(async (signal) => {
      const resp = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Ollama embed batch failed (${resp.status}): ${body}`);
      }

      const data = (await resp.json()) as { embeddings: number[][] };
      if (this._dimensions === null && data.embeddings[0]) {
        this._dimensions = data.embeddings[0].length;
      }
      return data.embeddings;
    }, { timeoutMs: 60_000 });
  }

  dimensions(): number {
    return this._dimensions ?? 1024; // bge-m3 default
  }
}
