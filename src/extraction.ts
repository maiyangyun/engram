// Engram Extraction Layer — LLM-driven memory extraction from conversations

export interface ExtractionResult {
  facts: Array<{
    content: string;
    memory_type: "semantic" | "episodic" | "procedural";
    importance: number; // 0-1
    source: "user" | "assistant" | "both";
    org_id: string | null;
    project_id: string | null;
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
    const timeoutId = setTimeout(() => controller.abort(), 120_000);

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

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction engine for a multi-agent collaborative system. Extract durable, reusable facts from conversations.

## LANGUAGE RULE (MANDATORY)
Output each fact in the SAME language as the source content. Chinese conversation → Chinese facts. English → English. NEVER translate. This is critical for downstream vector search quality.

## What to extract
Extract from BOTH User and Assistant messages:
- User: facts, preferences, requests, decisions, context
- Assistant: analysis conclusions, recommendations, commitments, architecture decisions, plans

## Classification
- "semantic": Stable facts, knowledge, preferences, rules
- "episodic": Time-bound events, incidents, milestones
- "procedural": Processes, workflows, decisions, how-to knowledge

## Source attribution
- "user": stated by User
- "assistant": decided/analyzed by Assistant
- "both": co-established through discussion

## Dimensional ownership (IMPORTANT)
For each fact, infer which organization and project it belongs to:
- "org_id": the team/organization this fact is relevant to. Use null if not organization-specific or uncertain.
- "project_id": the specific project this fact belongs to. Use null if not project-specific or uncertain.

Assign dimensions based on the CONTENT of the fact, not just keyword presence. A fact about team processes belongs to that team's org. A fact about a specific product belongs to that product's project. Personal preferences or general knowledge should have null for both.

## Importance (0.0-1.0)
- 1.0: Critical decisions, architecture choices
- 0.7: Useful preferences, project context
- 0.4: Minor details
- Below 0.4: Skip — not worth storing

## Rules
- Be concise — one clear sentence per fact
- Include dates when available for episodic memories
- Skip greetings, filler, acknowledgments
- Skip vague or context-dependent information
- If nothing worth remembering, return empty array
- When uncertain about org_id/project_id, use null — do NOT guess

## Output format (STRICT JSON, no markdown)
{"facts": [{"content": "...", "memory_type": "semantic|episodic|procedural", "importance": 0.0-1.0, "source": "user|assistant|both", "org_id": "string|null", "project_id": "string|null"}]}`;

export interface ExtractionOptions {
  customInstructions?: string;
  knownOrgs?: string[];
  knownProjects?: string[];
  agentId?: string;
  agentMemberships?: Array<{ org: string; projects: string[]; leads?: string[] }>;
  projectOrgMap?: Record<string, string>;
}

export async function extractMemories(
  llm: LLMProvider,
  messages: Array<{ role: string; content: string }>,
  customInstructionsOrOpts?: string | ExtractionOptions,
): Promise<ExtractionResult> {
  const opts: ExtractionOptions = typeof customInstructionsOrOpts === "string"
    ? { customInstructions: customInstructionsOrOpts }
    : customInstructionsOrOpts ?? {};

  let systemPrompt = EXTRACTION_SYSTEM_PROMPT;

  // Inject known orgs/projects so LLM can map to correct identifiers
  const contextParts: string[] = [];
  if (opts.knownOrgs && opts.knownOrgs.length > 0) {
    contextParts.push(`Known organizations: ${opts.knownOrgs.join(", ")}`);
  }
  if (opts.knownProjects && opts.knownProjects.length > 0) {
    contextParts.push(`Known projects: ${opts.knownProjects.join(", ")}`);
  }
  if (opts.agentId && opts.agentMemberships && opts.agentMemberships.length > 0) {
    const membershipDesc = opts.agentMemberships.map((m) => {
      const parts = [`org: ${m.org}`, `projects: ${m.projects.join(", ")}`];
      if (m.leads && m.leads.length > 0) parts.push(`leads: ${m.leads.join(", ")}`);
      return `  - ${parts.join(", ")}`;
    }).join("\n");
    contextParts.push(`Current agent: ${opts.agentId}\nAgent memberships:\n${membershipDesc}\nConstrain org_id/project_id to this agent's memberships when the content clearly relates to their work. If content is about a project, automatically set org_id to that project's parent org.`);
  }
  if (opts.projectOrgMap && Object.keys(opts.projectOrgMap).length > 0) {
    const mappings = Object.entries(opts.projectOrgMap).map(([p, o]) => `${p} → ${o}`).join(", ");
    contextParts.push(`Project-to-org mapping: ${mappings}. When you assign a project_id, automatically set org_id to its parent org.`);
  }
  if (contextParts.length > 0) {
    systemPrompt += `\n\nAvailable dimensions:\n${contextParts.join("\n")}\nOnly use these exact identifiers for org_id/project_id. Use null for anything that doesn't clearly match.`;
  }

  if (opts.customInstructions) {
    systemPrompt += `\n\nAdditional instructions:\n${opts.customInstructions}`;
  }

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
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
    const jsonStr = (jsonMatch[1] ?? response).trim();
    const parsed = JSON.parse(jsonStr);

    if (!parsed.facts || !Array.isArray(parsed.facts)) {
      return { facts: [] };
    }

    const validTypes = new Set(["semantic", "episodic", "procedural"]);
    const validSources = new Set(["user", "assistant", "both"]);
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
          source: validSources.has(f.source as string) ? (f.source as "user" | "assistant" | "both") : "user",
          org_id: typeof f.org_id === "string" && f.org_id !== "null" ? f.org_id : null,
          project_id: typeof f.project_id === "string" && f.project_id !== "null" ? f.project_id : null,
        })),
    };
  } catch {
    return { facts: [] };
  }
}
