/**
 * End-to-end smoke test: simulate a 6-question flow then create a real ClickUp ticket.
 * Bypasses the running daemon (which has a stale env cache).
 */
import * as dotenv from "dotenv";
dotenv.config();

import {
  startOrResumeSession,
  submitAnswer,
  getSession,
  markSubmitted,
  renderPRD,
} from "../src/core/agent-builder";
import { ClickUpHttpClient } from "../src/integrations/clickup/client";

async function main() {
  const session = await startOrResumeSession({
    source:    "dashboard",
    createdBy: "shane@elevarus.com",
  });
  console.log(`Created session ${session.id}`);

  const answers = [
    "End-to-end smoke test for the Agent Builder pipeline. Shane is verifying the full Slack→ClickUp wiring before announcing the feature.",
    "On-demand only — this is a smoke-test agent, not something we'd schedule.",
    "1. Verify session lifecycle. 2. Render markdown PRD. 3. POST to ClickUp Agent Requests list. 4. Update session row with task ID + URL.",
    "Input: nothing (manual run). Output: a ClickUp ticket in the Agent Requests list with the smoke-test PRD body.",
    "No human approval needed. Failures should halt loudly and dump a trace.",
    "Voice: terse and technical. Format: markdown PRD per the standard 10-section template. NEVER: include real customer data. Success metric: this script completes and a ticket appears in https://app.clickup.com.",
  ];

  for (let i = 0; i < answers.length; i++) {
    const result = await submitAnswer({
      sessionId:     session.id,
      questionIndex: i + 1,
      answer:        answers[i],
    });
    console.log(`  Q${i + 1} accepted → next: ${result.readyToFinalize ? "FINALIZE" : `Q${result.nextIndex}`}`);
  }

  const finalized = await getSession(session.id);
  console.log(`\nFinalize check: current_question_index = ${finalized.current_question_index} (99 = ready)`);

  const listId = process.env.AGENT_BUILDER_CLICKUP_LIST_ID;
  if (!listId) throw new Error("AGENT_BUILDER_CLICKUP_LIST_ID not set");

  const rendered = renderPRD(finalized, {
    proposedName:  "Smoke Test — Agent Builder E2E",
    proposedSlug:  "smoke-test-agent-builder-e2e",
    verticalTag:   "vertical:internal",
    capabilityTag: "capability:smoke-test",
  });

  const client = new ClickUpHttpClient();
  const task = await client.createTask(listId, {
    name:        rendered.title,
    description: rendered.body,
    tags:        rendered.tags,
  });
  if (!task?.id) throw new Error("ClickUp createTask returned null");
  const url = task.url ?? `https://app.clickup.com/t/${task.id}`;

  await markSubmitted(session.id, task.id, url, {
    proposedName: "Smoke Test — Agent Builder E2E",
    proposedSlug: "smoke-test-agent-builder-e2e",
    verticalTag:  "vertical:internal",
    capabilityTag: "capability:smoke-test",
  });

  console.log(`\n✓ ClickUp ticket created: ${task.id}`);
  console.log(`  ${url}`);
  console.log(`  Tags: ${rendered.tags.join(", ")}`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
