import * as fs from "fs";
import * as path from "path";
import { InstanceConfig, listInstanceIds, loadInstanceConfig } from "./instance-config";
import { MCClient } from "./mc-client";
import { logger } from "./logger";

const INSTANCES_DIR = path.resolve(__dirname, "../instances");

/**
 * Workspace Scaffold
 *
 * Creates the standard MC workspace files inside each ElevarusOS instance
 * directory. Mission Control's Files tab reads directly from the filesystem
 * workspace path, so these files must exist on disk to show up in the UI.
 *
 * Standard MC workspace files:
 *   agent.md    — agent role, workflow, and operating instructions
 *   identity.md — agent persona, voice, and audience
 *   soul.md     — SOUL content (same as what's sent to MC API)
 *   MISSION.md  — current mission and goals
 *   TOOLS.md    — available workflow stages and capabilities
 *   AGENTS.md   — other agents in the squad
 *   MEMORY.md   — persistent knowledge base (runtime notes go here)
 *   WORKING.md  — scratchpad for in-flight work context
 *   USER.md     — user/approver context
 *
 * These files are written once at scaffold time; WORKING.md and MEMORY.md
 * are intentionally left minimal so agents can write to them at runtime.
 */

// ─── Per-file generators ─────────────────────────────────────────────────────

function buildAgentMd(cfg: InstanceConfig): string {
  const isReporting = cfg.baseWorkflow === "ppc-campaign-report";
  return [
    `# ${cfg.name}`,
    ``,
    `**ID:** \`${cfg.id}\`  `,
    `**Workflow:** ${cfg.baseWorkflow}  `,
    `**Status:** ${cfg.enabled ? "Active" : "Disabled"}  `,
    `**Framework:** ElevarusOS`,
    ``,
    `## Role`,
    ``,
    isReporting
      ? `This agent produces structured performance reports for internal review. It collects campaign metrics, analyses trends vs. prior periods, and delivers a concise executive summary.`
      : `This agent produces high-quality blog content. It researches topics, generates outlines, drafts full articles, runs editorial passes, and routes for human approval before publishing.`,
    ``,
    `## Workflow Stages`,
    ``,
    ...(isReporting
      ? [
          `1. **data-collection** — Gather raw campaign metrics from available sources`,
          `2. **analysis** — Compare performance vs. targets and prior period`,
          `3. **summary** — Generate executive summary with Claude`,
          `4. **slack-publish** — Deliver report to configured Slack channel`,
        ]
      : [
          `1. **intake** — Validate and normalize the incoming request`,
          `2. **normalization** — Standardize fields and resolve gaps`,
          `3. **research** — Topic research via Claude`,
          `4. **outline** — Generate structured article outline`,
          `5. **drafting** — Write full draft`,
          `6. **editorial** — Polish and refine`,
          `7. **approval_notify** — Notify approver → task moves to Review in MC`,
          `8. **publish_placeholder** — Hand off to publish adapters`,
          `9. **completion** — Send completion notification`,
        ]),
    ``,
    `## Task Protocol`,
    ``,
    `Tasks arrive via Mission Control's Task Board (status: \`inbox\`).`,
    `ElevarusOS polls the MC queue and claims tasks automatically.`,
    `Update task status in MC as work progresses.`,
    ``,
    `## Approval`,
    ``,
    cfg.notify.approver
      ? `Approver: **${cfg.notify.approver}**  \nNotified at stage 7. Task moves to \`review\` in MC until approved.`
      : `No approver configured. Set \`notify.approver\` in instance.md to enable the approval gate.`,
  ].join("\n");
}

function buildIdentityMd(cfg: InstanceConfig): string {
  return [
    `# Identity — ${cfg.name}`,
    ``,
    `## Voice`,
    `${cfg.brand.voice}`,
    ``,
    `## Audience`,
    `${cfg.brand.audience}`,
    ``,
    `## Tone`,
    `${cfg.brand.tone}`,
    ``,
    ...(cfg.brand.industry ? [`## Industry`, `${cfg.brand.industry}`, ``] : []),
    `## Communication Style`,
    ``,
    `- Lead with the most important information`,
    `- Use concrete numbers and specifics over vague generalities`,
    `- Match tone to audience expertise level`,
    `- Be direct — no filler, no padding`,
    `- End with a clear next action when relevant`,
  ].join("\n");
}

function buildSoulMd(cfg: InstanceConfig): string {
  return MCClient.buildSoulContent(cfg);
}

function buildMissionMd(cfg: InstanceConfig): string {
  const isReporting = cfg.baseWorkflow === "ppc-campaign-report";
  return [
    `# Mission — ${cfg.name}`,
    ``,
    isReporting
      ? `Deliver accurate, timely campaign performance reports that help the Elevarus team make data-driven decisions quickly.`
      : `Produce high-quality, SEO-optimized blog content that reflects the Elevarus brand voice and drives meaningful engagement.`,
    ``,
    `## Success Criteria`,
    ``,
    isReporting
      ? [
          `- Report delivered on schedule`,
          `- All key metrics present and accurate`,
          `- Trends vs prior period clearly highlighted`,
          `- Recommendations are specific and actionable`,
        ].join("\n")
      : [
          `- Content is accurate, original, and reflects brand voice`,
          `- Target keyword naturally integrated`,
          `- Approved by designated approver before publish`,
          `- Published to the correct channel/platform`,
        ].join("\n"),
    ``,
    `## Constraints`,
    ``,
    `- Never fabricate data or metrics`,
    `- Always respect approval gates before publishing`,
    `- Flag ambiguous inputs rather than assuming`,
    cfg.notify.approver ? `- Route all content to ${cfg.notify.approver} for review` : ``,
  ].filter((l) => l !== undefined).join("\n");
}

function buildToolsMd(cfg: InstanceConfig): string {
  const isReporting = cfg.baseWorkflow === "ppc-campaign-report";
  return [
    `# Tools — ${cfg.name}`,
    ``,
    `## Available Capabilities`,
    ``,
    `### Claude API (via ElevarusOS)`,
    `- Model: \`claude-opus-4-7\``,
    `- Used for: research, outlining, drafting, analysis, summarisation`,
    ``,
    isReporting
      ? [
          `### Reporting Stages`,
          `- \`data-collection\` — raw metric ingestion`,
          `- \`analysis\` — trend analysis and benchmarking`,
          `- \`summary\` — Claude-generated executive summary`,
          `- \`slack-publish\` — Slack delivery`,
        ].join("\n")
      : [
          `### Blog Stages`,
          `- \`research\` — topic and keyword research`,
          `- \`outline\` — structure generation`,
          `- \`drafting\` — full article draft`,
          `- \`editorial\` — polish and fact-check`,
          `- \`publish_placeholder\` — delivery to publish adapters`,
        ].join("\n"),
    ``,
    `### Notifications`,
    cfg.notify.slackChannel
      ? `- Slack: \`${cfg.notify.slackChannel}\``
      : `- Slack: not configured (set \`notify.slackChannel\` in instance.md)`,
    `- Email: via Microsoft Graph adapter`,
    ``,
    `### Mission Control Integration`,
    `- Tasks polled from MC queue automatically`,
    `- Status updates pushed to MC in real time`,
    `- Approval gate: task moves to \`review\` awaiting human sign-off`,
  ].join("\n");
}

function buildAgentsMd(): string {
  return [
    `# Agent Squad`,
    ``,
    `ElevarusOS bot instances registered in Mission Control:`,
    ``,
    `## Blog Bots`,
    `| Agent | Description |`,
    `|-------|-------------|`,
    `| \`elevarus-blog\` | Elevarus brand blog content |`,
    `| \`nes-blog\` | NES brand blog content |`,
    `| \`blog\` | Default fallback blog bot |`,
    ``,
    `## Reporting Bots`,
    `| Agent | Description |`,
    `|-------|-------------|`,
    `| \`u65-reporting\` | U65 insurance campaign reports |`,
    `| \`final-expense-reporting\` | Final Expense campaign reports |`,
    `| \`hvac-reporting\` | HVAC campaign reports |`,
    ``,
    `## Orchestration`,
    ``,
    `All agents are coordinated via Mission Control's Task Board.`,
    `Tasks flow: \`inbox → in_progress → review → done\``,
    ``,
    `## Communication`,
    ``,
    `Agents do not communicate directly. All coordination happens through MC tasks:`,
    `- Create a sub-task in MC assigned to another agent`,
    `- MC routes it via queue polling`,
    `- Results posted back as task updates or comments`,
  ].join("\n");
}

function buildMemoryMd(cfg: InstanceConfig): string {
  return [
    `# Memory — ${cfg.name}`,
    ``,
    `> This file is the agent's persistent knowledge base.`,
    `> Add key learnings, patterns, and context that should persist across runs.`,
    ``,
    `## Brand Context`,
    ``,
    `- **Voice:** ${cfg.brand.voice}`,
    `- **Audience:** ${cfg.brand.audience}`,
    `- **Tone:** ${cfg.brand.tone}`,
    cfg.brand.industry ? `- **Industry:** ${cfg.brand.industry}` : ``,
    ``,
    `## Workflow Notes`,
    ``,
    `_(Empty — add notes here as they emerge)_`,
    ``,
    `## Common Patterns`,
    ``,
    `_(Empty — record recurring patterns and solutions here)_`,
  ].filter((l) => l !== undefined).join("\n");
}

function buildWorkingMd(cfg: InstanceConfig): string {
  return [
    `# Working — ${cfg.name}`,
    ``,
    `> Scratchpad for in-flight work context.`,
    `> Cleared between runs. Not persisted long-term.`,
    ``,
    `## Current Task`,
    ``,
    `_(None — updated by MCWorker during workflow execution)_`,
    ``,
    `## Stage Progress`,
    ``,
    `_(Stage outputs and intermediate results written here during execution)_`,
  ].join("\n");
}

function buildUserMd(cfg: InstanceConfig): string {
  return [
    `# User Context — ${cfg.name}`,
    ``,
    `## Approver`,
    cfg.notify.approver
      ? `**${cfg.notify.approver}**`
      : `_(Not configured — set \`notify.approver\` in instance.md)_`,
    ``,
    `## Audience`,
    `${cfg.brand.audience}`,
    ``,
    `## Preferences`,
    ``,
    `- Prefer concise outputs over exhaustive ones`,
    `- Flag uncertainty rather than assuming`,
    `- Always cite the keyword / brief when relevant`,
  ].join("\n");
}

// ─── Scaffold function ────────────────────────────────────────────────────────

/**
 * Write all standard MC workspace files for a single instance.
 * Skips any file that already has content (won't overwrite WORKING.md / MEMORY.md
 * if an agent has written notes into them).
 */
export function scaffoldInstanceWorkspace(cfg: InstanceConfig, force = false): void {
  const dir = path.join(INSTANCES_DIR, cfg.id);
  if (!fs.existsSync(dir)) {
    logger.warn("workspace-scaffold: instance directory missing", { id: cfg.id, dir });
    return;
  }

  const files: Record<string, () => string> = {
    "agent.md":    () => buildAgentMd(cfg),
    "identity.md": () => buildIdentityMd(cfg),
    "soul.md":     () => buildSoulMd(cfg),
    "MISSION.md":  () => buildMissionMd(cfg),
    "TOOLS.md":    () => buildToolsMd(cfg),
    "AGENTS.md":   () => buildAgentsMd(),
    "MEMORY.md":   () => buildMemoryMd(cfg),
    "WORKING.md":  () => buildWorkingMd(cfg),
    "USER.md":     () => buildUserMd(cfg),
  };

  let written = 0;
  for (const [filename, generate] of Object.entries(files)) {
    const filePath = path.join(dir, filename);
    const exists   = fs.existsSync(filePath);
    const isEmpty  = exists && fs.statSync(filePath).size === 0;

    // Skip if file has content and we're not forcing a refresh
    if (exists && !isEmpty && !force) continue;

    fs.writeFileSync(filePath, generate(), "utf8");
    written++;
  }

  if (written > 0) {
    logger.info("workspace-scaffold: files written", { id: cfg.id, written });
  }
}

/**
 * Scaffold workspace files for all registered instances.
 * Called at startup by MCWorker after agent registration.
 */
export function scaffoldAllWorkspaces(force = false): void {
  const ids = listInstanceIds(true);
  let total = 0;

  for (const id of ids) {
    try {
      const cfg = loadInstanceConfig(id);
      scaffoldInstanceWorkspace(cfg, force);
      total++;
    } catch (err) {
      logger.warn("workspace-scaffold: could not scaffold instance", { id, error: String(err) });
    }
  }

  logger.info("workspace-scaffold: complete", { instances: total });
}
