/**
 * Ask Elevarus — CLI harness for the Q&A bot.
 *
 * Runs the same tool-use loop the Slack webhook runs, but from the terminal
 * so you can test answers without Slack. Prints the final reply plus the
 * ordered list of tools Claude called.
 *
 * Usage:
 *   npx ts-node scripts/ask.ts "What was our spend on the final expense campaign on meta today?"
 *
 * Needs ANTHROPIC_API_KEY in .env. Live-data tools (Ringba, Meta) only return
 * real numbers if their respective integration env vars are set.
 */

import "../src/config";
import { createJobStore } from "../src/core/job-store";
import { WorkflowRegistry } from "../src/core/workflow-registry";
import { claudeConverseWithTools } from "../src/core/claude-converse";
import { QA_TOOLS } from "../src/core/qa-tools";
import { buildKnowledgeCatalog } from "../src/core/knowledge-catalog";

// Notifiers are not called in QA — we just need the registry populated.
import { SlackNotifyAdapter } from "../src/adapters/notify/slack.adapter";
import { EmailNotifyAdapter } from "../src/adapters/notify/email.adapter";
import { buildBlogWorkflowDefinition }        from "../src/workflows/blog/blog.workflow";
import { buildFinalExpenseReportingWorkflow } from "../src/workflows/final-expense-reporting/final-expense-reporting.workflow";
import { buildU65ReportingWorkflow }          from "../src/workflows/u65-reporting/u65-reporting.workflow";
import { buildHvacReportingWorkflow }         from "../src/workflows/hvac-reporting/hvac-reporting.workflow";

function buildRegistry(): WorkflowRegistry {
  const notifiers = [new SlackNotifyAdapter(), new EmailNotifyAdapter()];
  const registry  = new WorkflowRegistry();
  registry.register(buildBlogWorkflowDefinition(notifiers, "blog"));
  registry.register(buildBlogWorkflowDefinition(notifiers, "elevarus-blog"));
  registry.register(buildBlogWorkflowDefinition(notifiers, "nes-blog"));
  registry.register(buildFinalExpenseReportingWorkflow(notifiers));
  registry.register(buildU65ReportingWorkflow(notifiers));
  registry.register(buildHvacReportingWorkflow(notifiers));
  return registry;
}

function buildSystemPrompt(catalog: string): string {
  return [
    "You are **Ask Elevarus**, the in-channel assistant for ElevarusOS — an internal AI agent orchestration system built at Elevarus.",
    "",
    "## Your job",
    "Answer questions from the Elevarus team about the bots running on the platform. Be specific and grounded: cite the exact instance name, workflow, job id, or integration involved.",
    "",
    "## Orientation catalog (static snapshot)",
    catalog,
    "",
    "## Tools available",
    "Prefer calling a tool over relying on the static catalog. Tools: list_instances, get_instance_detail, list_workflows, list_integrations, query_jobs, get_job_output, get_ringba_revenue, get_meta_spend.",
    "",
    "If a tool returns `{ error: ... }`, tell the user what's missing rather than guessing.",
    "",
    "Reply style: short, Slack-friendly, cite ids verbatim.",
  ].join("\n");
}

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error("Usage: ts-node scripts/ask.ts \"<question>\"");
    process.exit(1);
  }

  console.error("─── Question ─────────────────────────────────────────────");
  console.error(question);
  console.error("");

  const registry = buildRegistry();
  const jobStore = createJobStore();
  const catalog  = buildKnowledgeCatalog({ registry });

  const result = await claudeConverseWithTools({
    system:      buildSystemPrompt(catalog),
    userMessage: question,
    traceId:     "cli-" + Date.now(),
    tools:       QA_TOOLS,
    toolContext: { jobStore, registry },
  });

  console.error("─── Tool calls ───────────────────────────────────────────");
  if (result.toolCalls.length === 0) {
    console.error("(none)");
  } else {
    for (const [i, call] of result.toolCalls.entries()) {
      const input  = JSON.stringify(call.input);
      const result = JSON.stringify(call.result);
      const resultPreview = result.length > 400 ? result.slice(0, 400) + "…" : result;
      console.error(`${i + 1}. ${call.name}(${input})`);
      console.error(`   → ${resultPreview}`);
    }
  }

  console.error("");
  console.error("─── Usage ────────────────────────────────────────────────");
  console.error(`input=${result.usage.inputTokens}  output=${result.usage.outputTokens}  truncated=${result.truncated}`);
  console.error("");
  console.error("─── Answer ───────────────────────────────────────────────");
  console.log(result.text);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
