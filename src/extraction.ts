// Engram Extraction Layer — LLM-driven memory extraction from conversations

export interface ExtractionResult {
  facts: Array<{
    content: string;
    memory_type: "semantic" | "episodic" | "procedural";
    importance: number; // 0-1
  }>;
}

export interface LLMProvider {
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

export class OllamaLLMProvider implements LLMProvider {
  private model: string;
  private baseUrl: string;

  constructor(config: { model: string; baseUrl: string }) {
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 120s timeout for long extractions

    try {
      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          options: { temperature: 0.1 },
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Ollama chat failed (${resp.status}): ${body}`);
      }

      const data = (await resp.json()) as { message: { content: string } };
      return data.message.content;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction engine. Your job is to extract durable, reusable facts from conversations.

For each fact, classify it into one of three types:
- "semantic": Stable facts, rules, knowledge, preferences (e.g., "User prefers PostgreSQL", "Project uses React 19")
- "episodic": Events, incidents, time-bound occurrences (e.g., "Deployed v2.1 on 2026-04-09", "Database crashed due to connection pool overflow")
- "procedural": Processes, workflows, how-to knowledge (e.g., "Always run migration check before deploying", "Use trunk-based development for Bonbon")

Rate importance from 0.0 to 1.0:
- 1.0: Critical decisions, architecture choices, recurring issues
- 0.7: Useful preferences, project context
- 0.4: Minor details, one-off observations
- 0.1: Trivial, likely not needed again

Rules:
- Extract ONLY facts worth remembering long-term
- Be concise — each fact should be one clear sentence
- Include dates/times for episodic memories when available
- Skip greetings, acknowledgments, and filler
- Skip information that is too vague or context-dependent to be useful standalone
- If nothing worth remembering, return an empty array

Respond with ONLY valid JSON in this exact format:
{"facts": [{"content": "...", "memory_type": "semantic|episodic|procedural", "importance": 0.0-1.0}]}`;

export async function extractMemories(
  llm: LLMProvider,
  messages: Array<{ role: string; content: string }>,
  customInstructions?: string,
): Promise<ExtractionResult> {
  const systemPrompt = customInstructions
    ? `${EXTRACTION_SYSTEM_PROMPT}\n\nAdditional instructions:\n${customInstructions}`
    : EXTRACTION_SYSTEM_PROMPT;

  // Format conversation for extraction
  const conversationText = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  const response = await llm.chat([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Extract memories from this conversation:\n\n${conversationText}` },
  ]);

  return parseExtractionResponse(response);
}

function parseExtractionResponse(response: string): ExtractionResult {
  try {
    // Try to extract JSON from the response (handle markdown code blocks)
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
    const jsonStr = (jsonMatch[1] ?? response).trim();
    const parsed = JSON.parse(jsonStr);

    if (!parsed.facts || !Array.isArray(parsed.facts)) {
      return { facts: [] };
    }

    const validTypes = new Set(["semantic", "episodic", "procedural"]);
    return {
      facts: parsed.facts
        .filter(
          (f: Record<string, unknown>) =>
            typeof f.content === "string" &&
            f.content.length > 0 &&
            validTypes.has(f.memory_type as string),
        )
        .map((f: Record<string, unknown>) => ({
          content: f.content as string,
          memory_type: f.memory_type as "semantic" | "episodic" | "procedural",
          importance: typeof f.importance === "number" ? Math.max(0, Math.min(1, f.importance)) : 0.5,
        })),
    };
  } catch {
    return { facts: [] };
  }
}
