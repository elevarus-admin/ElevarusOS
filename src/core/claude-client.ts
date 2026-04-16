import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { logger } from "./logger";

let _client: Anthropic | undefined;

export function getClaudeClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return _client;
}

/**
 * Send a single user prompt and parse the response as JSON.
 * Throws a descriptive error if the response cannot be parsed.
 */
export async function claudeJSON<T>(
  systemPrompt: string,
  userPrompt: string,
  jobId: string
): Promise<T> {
  const client = getClaudeClient();

  logger.debug("Sending Claude request", {
    jobId,
    model: config.anthropic.model,
    promptPreview: userPrompt.slice(0, 120),
  });

  const message = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  const raw = textBlock.text.trim();

  try {
    return JSON.parse(raw) as T;
  } catch {
    logger.error("Failed to parse Claude response as JSON", {
      jobId,
      raw: raw.slice(0, 500),
    });
    throw new Error(
      `Claude response was not valid JSON. Raw text (first 500 chars): ${raw.slice(0, 500)}`
    );
  }
}
