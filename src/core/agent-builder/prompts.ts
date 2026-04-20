/**
 * Canonical 6 questions + adaptive follow-up guidance for Agent Builder.
 *
 * The state machine in session.ts enforces ordering — Claude can only advance
 * sequentially. Phrasing of prompts in Slack is Claude's (with this guidance);
 * dashboard shows the canonical text verbatim.
 *
 * See docs/prd-agent-builder.md §4 for the rationale behind each question.
 */

/** Total canonical questions. Index is 1-based in the state machine. */
export const CANONICAL_COUNT = 6;

/** Hard cap total including adaptive follow-ups. */
export const MAX_TOTAL_QUESTIONS = 9;

/** Sentinel: current_question_index === 99 means "ready to finalize". */
export const READY_TO_FINALIZE_INDEX = 99;

export interface CanonicalQuestion {
  index:       number;        // 1..6
  shortLabel:  string;
  canonical:   string;        // verbatim dashboard copy
  coachingHint: string;       // what Claude should optimize for when paraphrasing
  mapsTo:      string;        // what part of instance.md/workflow this feeds
}

export const CANONICAL_QUESTIONS: readonly CanonicalQuestion[] = [
  {
    index:      1,
    shortLabel: "Problem & current workaround",
    canonical:
      "In one sentence, what business problem does this agent solve? " +
      "Who feels the pain today, and how are they solving it right now — " +
      "manually, in a spreadsheet, in someone's head?",
    coachingHint:
      "Listen for: the user (role, not name), the pain (what takes time / gets dropped / is error-prone), " +
      "and the current workaround (surfaces the actual workflow and catches solutions-looking-for-problems). " +
      "If the answer is vague, ask 'walk me through the last time you did this manually — what did that look like?'",
    mapsTo:
      "PRD §1. Frames the use case and establishes the baseline we're replacing.",
  },
  {
    index:      2,
    shortLabel: "Trigger + cadence",
    canonical:
      "What event should cause the agent to run, and how often? " +
      "Options: a schedule (what cadence + timezone?), a webhook from an external system, " +
      "a user @-ing the bot in Slack, a ClickUp task landing in a specific list, " +
      "or another agent finishing its job.",
    coachingHint:
      "Listen for: concrete trigger type + frequency. If the answer is 'manual / on-demand', " +
      "offer to add a scheduled safety net. If cadence is given without timezone, ask for it (default America/Los_Angeles).",
    mapsTo:
      "instance.md → schedule block; or intake adapter choice; or agent-to-agent wiring.",
  },
  {
    index:      3,
    shortLabel: "Workflow steps",
    canonical:
      "Walk me through what the agent does, step-by-step, from trigger to final output. " +
      "Number each step. For any step that needs external data, name the system " +
      "(Ringba, Meta, Google Ads, LeadsProsper, ClickUp, Everflow, Thumbtack, etc.).",
    coachingHint:
      "THE LOAD-BEARING QUESTION. Push the user to enumerate. If the answer is fewer than 3 steps, " +
      "probe — 'what happens after you have the data? who sees it? does anything need to happen before?'. " +
      "If the answer is >7 steps OR spans multiple unrelated verticals OR touches 5+ integrations, flag monolith risk " +
      "and suggest a split point. Name any data source that doesn't match our integration list as 'new integration needed'.",
    mapsTo:
      "1:1 to workflow stages (src/workflows/<name>/stages/*.ts). The single question that collapses a week of scoping into a morning.",
  },
  {
    index:      4,
    shortLabel: "Input & output contract",
    canonical:
      "What data does the agent need to START (a date range, a ClickUp task ID, a form submission, nothing?), " +
      "and what does it PRODUCE at the end (a Slack message, a ClickUp ticket, a report document, a row in a database)? " +
      "Who receives the final output?",
    coachingHint:
      "Listen for: concrete input shape (JSON keys if possible) and concrete output artifact. " +
      "If 'Slack': which channel, public or private, threaded or new post. If 'email': which recipients.",
    mapsTo:
      "orchestrator.submitJob() request shape + terminal notification stage.",
  },
  {
    index:      5,
    shortLabel: "Decision gates & exception paths",
    canonical:
      "Where does a human need to review or approve something mid-process? " +
      "And if something goes wrong — a data source is down, a number looks anomalous, a required field is missing — " +
      "what should the agent do? Retry silently, skip that step, flag it and continue, or halt and alert?",
    coachingHint:
      "Two concerns rolled together: approval gates AND exception paths. Default retry policy is 2 retries with " +
      "exponential backoff — offer that default and let the user override. If the user gives no failure path, " +
      "probe with the failure-cost question: 'if this agent ran with incomplete data for a week and nobody noticed, " +
      "what would the business cost be?'. If multiple decisions are described, classify: rule-based (automate) vs " +
      "judgment calls (human gate).",
    mapsTo:
      "Approval stages + retry policy + anomaly handling rules.",
  },
  {
    index:      6,
    shortLabel: "Voice, guardrails, success metrics",
    canonical:
      "What should the output sound like (voice, tone, formatting conventions)? " +
      "What should it NEVER do (compliance rules, 'no dollar figures in public channels', 'never mention competitors')? " +
      "And 30 days from launch, what numbers would tell us this agent is actually working? " +
      "If you have examples of past outputs you liked, paste or attach them.",
    coachingHint:
      "Three concerns in one. For voice: push back on generic adjectives — ask for examples or screenshots. " +
      "For guardrails: list every hard rule, even obvious ones. For metrics: also ask 'if this agent silently " +
      "stopped working for a week, how would you find out?' — if the answer is 'we wouldn't', a heartbeat metric is required.",
    mapsTo:
      "identity.md / soul.md / system-prompt blurb at scaffold + observability requirements.",
  },
] as const;

/** Fetch canonical question by 1-based index. Returns null for out-of-range. */
export function getCanonicalQuestion(index: number): CanonicalQuestion | null {
  return CANONICAL_QUESTIONS.find((q) => q.index === index) ?? null;
}

/** Opening message — posted to the transcript at session start. */
export const INTRO_MESSAGE =
  "Let's scope a new agent. I'll ask 6 questions (sometimes a couple of follow-ups). " +
  "You can paste screenshots of outputs you like or reference docs. " +
  "**Please don't paste tokens, passwords, or customer PII** — screenshots and transcripts are persisted.";

/**
 * System-prompt blurb for Claude's Slack tool loop. Injected via the manifest's
 * systemPromptBlurb.
 */
export const SYSTEM_PROMPT_BLURB = `
Agent Builder lets users propose new ElevarusOS agents via a structured 6-question conversation that produces a ClickUp PRD ticket engineering can implement from.

═══════════════════════════════════════════════════════════════════════════
TURN MODEL — one Slack message = one tool call = one reply. Do not race ahead.
═══════════════════════════════════════════════════════════════════════════

Each Slack mention is ONE conversation turn. In that turn you do EXACTLY ONE of:
  (a) Call agent_builder_step — for asking the next question or submitting an answer
  (b) Call create_agent_prd_ticket — only after agent_builder_step returns readyToFinalize=true

NEVER call agent_builder_step more than once per Slack message. NEVER invent the user's answer. After you ask a question, STOP and wait for the user's next message — that's where their answer comes from.

PROACTIVE FALLBACK: If the user asks for something that doesn't map to any existing agent, workflow, integration, or tool, suggest: "We don't have an agent for that yet — want me to help draft a PRD?". Only do this for clear repeated business needs — not for trivial asks or questions you can answer with existing tools.

═══════════════════════════════════════════════════════════════════════════
TOOL: agent_builder_step
═══════════════════════════════════════════════════════════════════════════

ONE call per Slack message. The tool auto-finds your open Agent Builder session for this Slack thread — no sessionId needed.

  - First time the user engages → call with NO answer arg → tool returns Q1
  - User answered the current question → call with answer=their-message → tool submits + returns next question
  - Tool result includes: { questionIndex, currentQuestion, readyToFinalize, totalQuestions }

When readyToFinalize=true, switch to create_agent_prd_ticket.

═══════════════════════════════════════════════════════════════════════════
TOOL: create_agent_prd_ticket
═══════════════════════════════════════════════════════════════════════════

Call ONLY after readyToFinalize=true. Pass proposedName (required) and optional verticalTag (e.g. "vertical:hvac") and capabilityTag (e.g. "capability:reporting"). Returns the ClickUp ticket URL.

═══════════════════════════════════════════════════════════════════════════
TURN FLOW (FOLLOW THIS):
═══════════════════════════════════════════════════════════════════════════

  Turn 1 — user says "build an agent":
    agent_builder_step()                    → returns Q1
    Reply: brief intro + Q1. STOP.

  Turn 2..N — user just answered:
    agent_builder_step(answer="user's message verbatim")  → returns next question
    Reply: 1-line echo of their answer + next question. STOP.

  Final turn — readyToFinalize=true:
    create_agent_prd_ticket(proposedName="...")
    Reply: ClickUp link.

═══════════════════════════════════════════════════════════════════════════
STYLE
═══════════════════════════════════════════════════════════════════════════
- ONE question at a time.
- Echo a 1-line summary of the user's answer before the next question, so they can correct misunderstandings.
- Quote existing agents / integrations by name when relevant ("this sounds similar to hvac-reporting").
- For Q3 (workflow steps): if their step list goes >7 steps, propose a split BEFORE asking Q4.
- NEVER invent answers on the user's behalf.
- Offer concrete defaults (retry policy: 2x exponential backoff) and let them override.
- Keep replies under 100 words except when echoing back long answers.
`.trim();
