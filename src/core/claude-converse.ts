/**
 * Conversational Claude helper.
 *
 * Sibling of `claude-client.ts`. The structured-JSON helper there is designed
 * for single-shot, machine-readable stage output; this one is for natural
 * language replies and for the agentic tool-use loop used by the Q&A bot.
 *
 * - `claudeConverse`          → single turn, no tools (Phase 2 replies)
 * - `claudeConverseWithTools` → agentic loop, multi-turn with tool_result
 *                               feedback (Phase 3 live queries)
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { logger } from "./logger";
import { getClaudeClient } from "./claude-client";
import { QATool, QAToolContext, executeQATool } from "./qa-tools";

// ─── Single-turn (Phase 2) ────────────────────────────────────────────────────

export interface ClaudeConverseOptions {
  /** System prompt — bot personality + knowledge context. */
  system:      string;
  /** The user's message, verbatim. */
  userMessage: string;
  /** Correlation id for logs. Use the Slack event_id or job id. */
  traceId:     string;
  /** Max output tokens. Defaults to 1024 — Slack messages stay short. */
  maxTokens?:  number;
}

/**
 * Run a single conversational turn and return the assistant's plain-text reply.
 *
 * Throws on API errors. The caller decides how to surface failures.
 */
export async function claudeConverse(opts: ClaudeConverseOptions): Promise<string> {
  const client: Anthropic = getClaudeClient();

  logger.debug("claude-converse: sending request", {
    traceId:       opts.traceId,
    model:         config.anthropic.model,
    questionChars: opts.userMessage.length,
    systemChars:   opts.system.length,
  });

  const message = await client.messages.create({
    model:      config.anthropic.model,
    max_tokens: opts.maxTokens ?? 1024,
    system:     opts.system,
    messages:   [{ role: "user", content: opts.userMessage }],
  });

  const reply = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  logger.info("claude-converse: reply generated", {
    traceId:      opts.traceId,
    inputTokens:  message.usage?.input_tokens,
    outputTokens: message.usage?.output_tokens,
    replyChars:   reply.length,
  });

  return reply;
}

// ─── Tool-use loop (Phase 3) ──────────────────────────────────────────────────

export interface ClaudeConverseWithToolsOptions {
  system:          string;
  userMessage:     string;
  traceId:         string;
  /** Tool specs + executors Claude can call. */
  tools:           QATool[];
  /** Execution context passed to each tool on call. */
  toolContext:     QAToolContext;
  /** Hard cap on tool-use iterations. Default 6. */
  maxIterations?:  number;
  /** Max tokens per model call. Default 1500. */
  maxTokens?:      number;
}

export interface ClaudeConverseResult {
  /** Final plain-text reply. */
  text:         string;
  /** Ordered list of tool calls made during the loop. */
  toolCalls:    Array<{ name: string; input: unknown; result: unknown }>;
  /** True if we stopped because maxIterations was reached. */
  truncated:    boolean;
  /** Summed usage across every model call in the loop. */
  usage:        { inputTokens: number; outputTokens: number };
}

/**
 * Run the agentic tool-use loop.
 *
 * The loop alternates between model turns (which may request tool calls) and
 * tool-result turns (which feed local results back to the model). It ends
 * when the model produces a plain-text reply with no pending tool_use blocks,
 * or when maxIterations is reached.
 *
 * Tool execution is sequential — Claude may emit multiple tool_use blocks in
 * one turn, and we run them in the order they appear. Tool errors are
 * captured as JSON and fed back so the model can recover on the next turn.
 */
export async function claudeConverseWithTools(
  opts: ClaudeConverseWithToolsOptions,
): Promise<ClaudeConverseResult> {
  const client         = getClaudeClient();
  const maxIterations  = opts.maxIterations ?? 6;
  const maxTokens      = opts.maxTokens     ?? 1500;

  const toolSpecs = opts.tools.map((t) => t.spec);
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.userMessage },
  ];

  const toolCalls: ClaudeConverseResult["toolCalls"] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    logger.debug("claude-converse: tool loop iteration", {
      traceId:  opts.traceId,
      iteration,
    });

    const response = await client.messages.create({
      model:      config.anthropic.model,
      max_tokens: maxTokens,
      system:     opts.system,
      tools:      toolSpecs as Anthropic.Tool[],
      messages,
    });

    usage.inputTokens  += response.usage?.input_tokens  ?? 0;
    usage.outputTokens += response.usage?.output_tokens ?? 0;

    // Append the assistant turn verbatim so tool_use ids stay linked.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // End-of-loop — model produced text with no tool calls (or hit a stop).
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      logger.info("claude-converse: tool loop done", {
        traceId:      opts.traceId,
        iterations:   iteration + 1,
        toolCalls:    toolCalls.length,
        stopReason:   response.stop_reason,
        inputTokens:  usage.inputTokens,
        outputTokens: usage.outputTokens,
        replyChars:   text.length,
      });

      return { text, toolCalls, truncated: false, usage };
    }

    // Execute every tool_use block from this turn, collect tool_results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const result = await executeQATool(use.name, use.input, opts.toolContext);
      toolCalls.push({ name: use.name, input: use.input, result });

      logger.debug("claude-converse: tool executed", {
        traceId: opts.traceId,
        tool:    use.name,
      });

      toolResults.push({
        type:        "tool_result",
        tool_use_id: use.id,
        content:     JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Iteration cap reached — ask the model for a final summary with no tools.
  logger.warn("claude-converse: tool loop hit maxIterations", {
    traceId:    opts.traceId,
    iterations: maxIterations,
    toolCalls:  toolCalls.length,
  });

  const final = await client.messages.create({
    model:      config.anthropic.model,
    max_tokens: maxTokens,
    system:
      opts.system +
      "\n\n(Note: you've reached the tool-use iteration cap. Answer now using what you have.)",
    messages,
  });

  usage.inputTokens  += final.usage?.input_tokens  ?? 0;
  usage.outputTokens += final.usage?.output_tokens ?? 0;

  const text = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return { text, toolCalls, truncated: true, usage };
}
