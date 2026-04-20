# PRD: Agent Builder

**Status:** Draft v1
**Author:** Shane McIntyre
**Date:** 2026-04-20
**Audience:** ElevarusOS engineering team

---

## Quick Reference

| Item | Value |
|---|---|
| Feature dir | `src/core/agent-builder/` |
| Slack tools | `propose_agent`, `refine_agent_spec`, `create_agent_prd_ticket` |
| Dashboard route | `/agents/new` (multi-step wizard) |
| API endpoints | `POST /api/agent-builder/session`, `POST /api/agent-builder/ticket` |
| Storage | Ephemeral sessions in `agent_builder_sessions` (Supabase); finalized PRDs in ClickUp |
| ClickUp list | New: "Agent Requests" — single shared list (no per-vertical split) |
| Scaffold integration | Reuses existing `scaffoldInstanceWorkspace()` + `POST /api/instances` post-approval |
| Question minimum | 6 probing questions; Claude adds up to 3 more if clarity is missing (hard cap 9) |
| Dashboard chat UI | [`shadcn-chat`](https://github.com/jakobhoeg/shadcn-chat) + `react-markdown` + Supabase Storage for attachments |
| Entry triggers | Dashboard button, Slack explicit `@Elevarus I want to build an agent...`, Slack fallback ("I can't do X — want to spin up an agent for this?") |

---

## Decisions Locked In

1. **NOT a standalone agent instance — it's a shared feature exposed through three surfaces.** See §3 for the full argument. The short version: ElevarusOS agents are workflow runners (stages → output). Agent Builder is conversational Q&A that doesn't fit the stage model. Putting the logic in `src/core/agent-builder/` lets both the Slack bot (via tools) and the dashboard (via API) consume the same code — one implementation, one prompt, one ClickUp ticket schema.
2. **The user-facing framing can still be "the Agent Builder agent."** It shows up on `/agents` as a pinned, always-enabled pseudo-agent with its own avatar and description. Clicking it opens `/agents/new`. This gives users the mental model they expect without forcing the implementation into the workflow pipeline.
3. **Ask 6 questions minimum, cap at 9 — shaped as a BPA decomposition.** The six are ordered trigger → steps → contracts → gates → exceptions → style+success, so the ticket renders as an implementation spec the dev can walk top-to-bottom. Claude adds up to 3 adaptive follow-ups when answers leave ambiguity. Hard cap prevents runaway. Content-wise, Q3 ("walk me through the steps") is the load-bearing one — a good answer there collapses a week of scoping into a morning. See §4 for full coaching guidance.
4. **Output is a ClickUp ticket, not an instantiated agent.** The ticket is a PRD draft; an engineer reviews and implements. Future phases may add self-serve scaffolding for well-scoped requests, but v1 is human-approved only. This avoids the "unchecked agent proliferation" failure mode.
5. **Slack bot fallback detection is intent-based, not error-based.** When Claude determines the user's ask falls outside current agent/tool capabilities, it proactively asks: "Sounds like we don't have an agent for this yet. Want me to help draft a PRD for a new one?" No regex on error strings.
6. **One shared ClickUp list, not per-vertical.** A single "Agent Requests" list in the existing Elevarus space. Tags on the ticket (`vertical:hvac`, `capability:reporting`, etc.) handle filtering. Matches the ClickUp PRD's simplicity ethos.
7. **Dashboard wizard is a chat UI, not a form.** Built on [`shadcn-chat`](https://github.com/jakobhoeg/shadcn-chat) (shadcn-compatible, drop-in, matches the rest of the dashboard's primitives). Supports markdown in messages, paste-from-clipboard screenshot handling, file drag/drop, copy buttons on code blocks. Attachments stored in Supabase Storage. See §8.
8. **Server-side enforcement of question order — not Claude's self-discipline.** The state machine in `session.ts` tracks `current_question_index` and rejects any `refine_agent_spec` call that would skip ahead (returns `{ error: 'out_of_order', expected: N, got: M }`). This is load-bearing because (a) Claude is optimized for helpfulness and will occasionally short-circuit a 6-question flow if it thinks it has enough information, (b) Slack's thread history is the only conversational state Claude sees today and the 20-message window means long sessions can drop prior questions off the tail. Server state + enforced ordering = the 6 questions actually get asked, every time. Claude can still be flexible on *phrasing* and *adaptive follow-ups* — it just can't skip canonical questions.

---

## 1. Problem

Creating a new ElevarusOS agent today is a multi-step engineering task: write `instance.md`, pick a workflow, configure integrations, add it to the registry in `src/index.ts`, scaffold workspace files, restart the daemon. There's no path for a non-engineer to **propose** an agent without a Slack DM to Shane or a loosely-worded ClickUp ticket. Three problems fall out:

- **Lost context.** Requests arrive in chat as "hey can we make a bot that does X?" with no scoping, no integration list, no success criteria. Engineering re-asks the same questions every time.
- **Slack bot dead ends.** When a user asks `@Elevarus` something the current agents can't answer ("what's our LinkedIn spend trend"), the bot says it can't help and the conversation dies. The right response is: "We don't have that yet — should we build it?"
- **No discovery surface.** The dashboard's `/agents` page lists what exists but has no affordance for "I want a new one." Users don't know agent creation is even possible.

This PRD introduces a thin capture-and-scope layer that turns "I want X" into a concrete, reviewable ClickUp ticket with enough detail for an engineer to implement.

---

## 2. Goals & Non-Goals

### Goals

- **Same flow, three entry points.** Dashboard button, Slack explicit ask, Slack fallback — all route through the same prompt + ticket-generation logic.
- **Conversational, not form-driven.** Even the dashboard version is a chat-style wizard, because natural-language answers surface nuance that checkboxes miss.
- **Minimum 6 probing questions, ordered as a business-process decomposition.** Trigger → workflow steps → input/output contracts → decision & approval gates → exception paths → voice/guardrails/success. Claude adds 1–3 adaptive follow-ups when answers leave ambiguity. See §4.
- **Output is an implementation-ready PRD, not a conversation transcript.** Every ticket has the same 10-section schema keyed to what a dev actually needs to scaffold the agent: instance.md draft, workflow stage list, retry/failure policy, voice & guardrails, success metrics. Engineering should be able to review 10 tickets in a morning and start implementation without a kickoff call.
- **Reuse, don't reinvent.** The existing `scaffoldInstanceWorkspace()`, `POST /api/instances`, `clickup_create_task` tool, and `InstanceConfig` type cover 80% of the machinery.
- **Slack bot recommends proactively** when a user asks for something outside current capabilities.

### Non-Goals (v1)

- **Auto-creating agents.** The output is a ticket. A human engineer reviews and runs the scaffold — no autonomous agent instantiation.
- **Multi-user session handoff.** One user, one session. If Shane and another user both start a session for the same agent, they produce two tickets — engineering dedupes at review time.
- **Rich requirement validation.** We don't validate "does this integration exist" or "is this workflow feasible" at capture time. The PRD ticket is what reviewers check.
- **Agent-to-agent communication protocol.** Shane mentioned agents could theoretically talk to each other. True — but it's a separate design problem (message bus, routing, identity). Out of scope here; the ticket schema will include a "Needs to coordinate with" field so future wiring has the answer captured.
- **Templating / agent marketplace.** No "clone HVAC reporting for Solar" button in v1. Reviewers can manually fork existing instance.md files.

---

## 3. "Is this itself an agent?" — The Recommendation

**Recommendation: No. Build it as a shared feature. Brand it as an agent in the UI if that's useful.**

### Why it's tempting to call it an agent

ElevarusOS already has the concept of agents with `instance.md`, workspace files, schedules. A "meta-agent that creates agents" has conceptual symmetry and gives users a concrete thing to point at in `/agents`. It also suggests a future where the agent really does self-serve scaffold the new instance, closing the loop.

### Why it shouldn't actually BE an agent

Four concrete reasons against:

1. **Stage model mismatch.** Every existing agent runs a workflow (stages → output → approval → completion). Agent Builder is a multi-turn conversation that branches based on user answers. Stages are linear; conversations aren't. Forcing Agent Builder into the stage model would require a "conversational stage" primitive we don't have and don't need elsewhere.
2. **No schedule, no job.** Agent Builder fires on user action, not cron. It wouldn't populate `/api/jobs` in any useful way. The audit surface is the ClickUp ticket + `agent_builder_sessions` table, not `job_store`.
3. **State lives outside `instance.md`.** Agents today have a fixed config. Agent Builder's "state" is the conversation transcript — ephemeral, session-scoped, with binary attachments. Shoehorning it into an agent instance means either storing transcripts in `MEMORY.md` (wrong) or bypassing the instance model (also wrong).
4. **Shared logic across surfaces.** The dashboard and Slack both need to call the same "ask the 5 questions" logic. If it's an agent, the dashboard wizard would have to *talk to* the agent (either by submitting a job and polling, or via the Slack bot's tool loop). If it's a shared module, the dashboard imports it directly.

### The compromise: pseudo-agent in the UI

The `/agents` page can render a card for "Agent Builder" with the same visual treatment as real agents:

- Pinned to the top of the grid
- Avatar, description, "New agent" CTA instead of job history
- Clicking it opens `/agents/new` instead of the job timeline

This gives users the right mental model — "agents are things, and one of those things creates more agents" — without the implementation debt of making it an actual workflow-running instance. The manifest-driven integration cards on `/integrations` already set this precedent (Slack is a pseudo-integration without its own manifest file).

### What this looks like in code

```
src/core/agent-builder/
  prompts.ts           The 5 canonical questions + adaptive follow-up guidance
  session.ts           Session lifecycle, transcript storage, state machine
  prd-renderer.ts      Transcript → ClickUp task body (markdown PRD)
  slack-tools.ts       propose_agent, refine_agent_spec, create_agent_prd_ticket
  index.ts
```

The Slack bot's `claude-converse.ts` loop picks up `slack-tools.ts` via the manifest registry (same path as every other integration). The dashboard hits `POST /api/agent-builder/session` and `POST /api/agent-builder/ticket` which delegate to the same `session.ts` + `prd-renderer.ts`.

---

## 4. The 6+ Probing Questions

Designed through a **business-process-automation lens**: each question maps to a specific part of the `instance.md` / workflow scaffold the dev will write, so the ticket becomes a near-complete implementation spec rather than a conversation. The order matters — we walk down the process pipeline (trigger → steps → contracts → decisions → exceptions → style/success), which is how a dev actually builds.

Claude asks all six, in order, and adds up to three follow-ups when answers leave ambiguity. Hard cap 9.

| # | Question | Maps to (what the dev uses it for) |
|---|----------|------------------------------------|
| 1 | **"In one sentence, what business problem does this agent solve? Who feels the pain today, and how are they solving it right now (manually, in a spreadsheet, in someone's head)?"** | Frames the use case AND the baseline we're replacing. "How are they solving it now" is the critical add — it surfaces the real workflow and catches "solutions looking for a problem." |
| 2 | **"What event should cause the agent to run, and how often? Options: a schedule (what cadence + timezone?), a webhook from an external system, a user @-ing the bot in Slack, a ClickUp task landing in a specific list, or another agent finishing its job."** | Directly maps to `instance.md` → `schedule` block, or to an intake adapter (ClickUp/email/Slack events), or to agent-to-agent wiring. Tells the dev which trigger mechanism to configure. |
| 3 | **"Walk me through what the agent does, step-by-step, from trigger to final output. Number each step. For any step that needs external data, name the system (Ringba, Meta, Google Ads, LeadsProsper, ClickUp, Everflow, Thumbtack, etc.)."** | **The load-bearing question.** Maps 1:1 to the workflow's stage sequence (`src/workflows/<name>/<name>.workflow.ts`). Example answer: "1. Pull Ringba revenue for last 7 days for the HVAC campaign. 2. Pull Meta + Google Ads spend for HVAC ad accounts. 3. Compute CPA and margin. 4. Draft Slack message. 5. Wait for approval. 6. Post to #hvac-reports." → dev writes 6 stages, maybe 5 with approval as a gate. |
| 4 | **"What data does the agent need to START (a date range, a ClickUp task ID, a form submission, nothing?), and what does it PRODUCE at the end (a Slack message, a ClickUp ticket, a report document, a row in a database)? Who receives the final output?"** | Maps to the workflow's input contract (what `orchestrator.submitJob(request, instanceId)` passes as `request`) AND the terminal notification stage (Slack channel ID, email recipient, ClickUp list). Also tells the dev whether to build a blog-style, reporting-style, intake-style, or data-import workflow. |
| 5 | **"Where does a human need to review or approve something mid-process? And if something goes wrong — a data source is down, a number looks anomalous, a required field is missing — what should the agent do? Retry silently, skip that step, flag it and continue, or halt and alert?"** | Two BPA concerns rolled into one: **decision gates** (approval stages in the workflow) AND **exception paths** (retry policy, soft-fail vs hard-fail, anomaly flagging). Without this, devs default to "retry 2x then fail" which is often wrong — a P&L agent producing $0 revenue on a hard-fail quarter is worse than producing the report with a flag. |
| 6 | **"What should the output sound like (voice, tone, formatting conventions), what should it NEVER do (compliance rules, 'no dollar figures in public channels', 'never mention competitors by name'), and 30 days from launch what numbers would tell us this agent is actually working?"** | Three related concerns: **style** feeds `identity.md`/`soul.md` and the system-prompt blurb; **guardrails** feed hard rules in the stage prompts; **success metrics** feed the observability requirements (what to log, what to alert on). Accepts attachments (dashboard: paste/drop screenshots; Slack: paste examples inline). |

**Adaptive follow-ups (Claude is prompted to ask when relevant):**

- *Trigger ambiguity (after Q2).* If the trigger is "manual / on-demand": "Should we also offer a scheduled fallback so the agent runs if nobody remembers to kick it off?"
- *Monolith check (after Q3).* If the step-by-step has more than ~7 steps, OR spans multiple unrelated verticals, OR touches 5+ integrations: "That's drifting toward monolith territory. Is there a natural split point — e.g. one agent that pulls and normalizes data, and a second that composes the narrative — or does this all really need to live together?"
- *Unknown integration (after Q3).* If a named system doesn't match our integration list: "We don't have a {X} integration yet. Does building that integration need to happen first (separate ticket), or is there a workaround (existing integration, manual paste-in, CSV drop)?"
- *Decision-type drill (after Q5).* If multiple decision points are described: "Some of those decisions sound rule-based (e.g. 'if spend > $X, pause') and others sound judgment calls (e.g. 'if the copy feels off-brand'). Which are which? Rule-based ones we automate; judgment ones need a human gate."
- *Failure cost (after Q5 if no failure path is given).* "If this agent ran with incomplete data for a week and nobody noticed, what would the business cost be? That tells us how loud the failure signals need to be."
- *Stale silence (after Q6 if no metrics).* "If this agent silently stopped running for a week, how would you find out? If the answer is 'we wouldn't,' we need to design a heartbeat — what metric would you check on a dashboard?"
- *Generic voice (after Q6).* If voice is described only in adjectives ("professional", "friendly") with no examples: "Got it — any past outputs (ours or a competitor's) that capture the right tone? Even a screenshot of one paragraph helps the dev more than a word list."
- *Agent-to-agent (anywhere).* If another agent is named as a dependency: "Should the new agent trigger {existing agent} as a step, or just consume its output after it runs on its own schedule? (These are different integration patterns.)"
- *Contradiction check.* If answers conflict: "Earlier you said {X}, now you mentioned {Y}. Which is the priority?"

**Hard stop at 9 total questions.** If the spec is still ambiguous, the ticket gets an "Open Questions" section at the bottom listing what wasn't resolved. Engineering picks it up from there.

### Coaching guide for Claude's system prompt

The question list above is the *content*. The *style* matters equally — Claude is prompted to:

- **Ask one question at a time.** Stacking questions produces shallow answers.
- **Echo back a one-line summary of each answer before moving on.** Confirms understanding and lets the user correct.
- **Quote existing agents / integrations by name when useful.** "This sounds similar to `hvac-reporting` — want to use that as a template?"
- **Push back on monoliths early.** If Q3's step list starts getting long, interrupt and propose a split before Q4.
- **Never invent steps or data sources the user didn't mention.** If an answer is thin, ask a follow-up; don't fill gaps with plausible-sounding detail that ends up in the ticket.
- **Offer concrete defaults.** "Default retry policy is 2 retries with exponential backoff. Override only if this agent needs different behavior."
- **Stay short.** Each Claude-authored message should be under 100 words outside of Q3's walkthrough (where the user's answer is the long part).

---

## 5. Topology

```
┌────────────────────────────────────────────────────────────────────┐
│                         User entry points                          │
│                                                                    │
│  Slack:  @Elevarus I want a bot that...                            │
│  Slack:  @Elevarus <question bot can't answer>                     │
│          ↳ bot replies: "Want to spin up a new agent?"             │
│  Dashboard:  /agents → "+ New Agent" button → /agents/new          │
└──────────────────┬─────────────────────────────────────────────────┘
                   ▼
┌────────────────────────────────────────────────────────────────────┐
│              src/core/agent-builder/ (shared module)               │
│                                                                    │
│  session.ts        — start session, append turn, mark complete     │
│  prompts.ts        — 5 canonical questions + follow-up guide       │
│  prd-renderer.ts   — transcript → ClickUp task body                │
│  slack-tools.ts    — QATool[] exposing the above to Claude's loop  │
└──────┬─────────────────────────────────────────┬───────────────────┘
       │                                         │
       ▼                                         ▼
┌─────────────────────────┐         ┌────────────────────────────────┐
│  agent_builder_sessions │         │  ClickUp                       │
│  (Supabase)             │         │  "Agent Requests" list          │
│  one row per session    │         │  title: "Agent: {name}"         │
│  transcript JSONB       │         │  body: rendered PRD markdown   │
│  status: open/submitted │         │  tags: vertical:x, capability:y│
└─────────────────────────┘         └────────────────────────────────┘
                                              │
                                              ▼
                                    ┌────────────────────────┐
                                    │  Engineering review    │
                                    │  POST /api/instances   │
                                    │  scaffoldInstance...() │
                                    │  new agent lives       │
                                    └────────────────────────┘
```

---

## 6. ClickUp Ticket Shape (the PRD we create)

Every ticket uses the same markdown template, rendered by `prd-renderer.ts` from the session transcript. Sections are ordered and named so the reviewing engineer can skim top-to-bottom and implement. Missing answers render as `_(not specified — see transcript)_` so the structure is stable.

```markdown
## Proposed Agent: {display_name}   `(id: {slug})`

**Requested by:** {slack_user_id or dashboard_user_email}
**Captured:** {iso_timestamp}
**Session:** {agent_builder_sessions.id}
**Estimated effort:** {rough-guess from stage count + integration surface}

---

### 1. Problem & current workaround
**Problem:** {Q1 — one-sentence problem}
**Who feels it:** {Q1 — user / role}
**Current workaround:** {Q1 — manual spreadsheet, someone's head, etc.}

### 2. Trigger
- **Type:** `cron` | `webhook` | `slack_mention` | `clickup_task_landing` | `agent_handoff` | `on_demand_only`
- **Details:** {cadence + timezone for cron; URL + auth for webhook; channel + phrase pattern for slack; list ID for clickup; upstream agent ID for handoff}
- **Fallback:** {if manual, propose a scheduled safety net — or explicitly "none, manual only"}

### 3. Workflow stages (the dev's build list)
{numbered step-by-step from Q3, one bullet per stage, with the data source named for data-fetching steps}

Example rendering:
```
1. data.ringba_revenue   — pull Ringba revenue (last 7d, HVAC campaign)
2. data.ads_spend        — pull Meta + Google Ads spend for HVAC accounts
3. compute.margin        — aggregate spend, revenue, margin, CPA
4. draft.slack_summary   — compose the narrative (Claude, voice from §6)
5. approval.human_gate   — wait for approver (see §5)
6. notify.slack_post     — post to #hvac-reports
```

**Integrations used:** {list} — ✅ already wired / 🔴 requires new integration

### 4. Input & output contract
- **Input (what the agent needs to START):** {Q4 — shape of the trigger payload; often `{ startDate, endDate }` for reporting or `{ title, brief }` for content}
- **Output (what the agent PRODUCES):** {Q4 — final artifact type, format, recipient}
- **Artifact persistence:** {does it go in job_store? also in a dedicated table? email/slack only?}

### 5. Decision gates & exception handling
- **Approval gates:** {from Q5 — which stages block on human approval, who the approver is, via Slack button or dashboard}
- **Retry policy:** {per-stage default = 2 retries w/ exponential backoff; overrides if called out}
- **On data source failure:** `skip-with-flag` | `halt-and-alert` | `use-cache` | `fail-loudly`
- **Anomaly handling:** {e.g. "if revenue < 10% of trailing-7d average, flag in the message and tag @shane"}
- **Failure cost:** {from the adaptive follow-up — informs alerting aggressiveness}

### 6. Voice, tone, format & guardrails
- **Voice / tone:** {extracted from Q6}
- **Format conventions:** {headers, bullet structure, length caps, emoji usage, etc.}
- **Hard rules (NEVER do this):** {compliance, competitors, PII, dollar figures in public channels, etc.}
- **Reference examples:** {attachment URLs from Supabase Storage + inline examples}

### 7. Success metrics (30-day check-in)
- **Is-it-working signal:** {the metric a dashboard would show if we built one}
- **Stale-silence detection:** {how we'd notice if the agent stopped running}
- **Success criteria:** {accuracy target / coverage / response-time expectations}

### 8. Inter-agent coordination
{if another agent was named as upstream/downstream, describe the handoff pattern; otherwise "standalone"}

### 9. Suggested instance.md (scaffold starting point)
```yaml
id: {slug}
name: {display_name}
baseWorkflow: {reporting | blog | intake | data-import | custom}
enabled: false   # start disabled until reviewed
brand:
  voice:    "{from §6}"
  tone:     "{from §6}"
  audience: "{from §1}"
  industry: "{vertical tag}"
notify:
  approver:     "{from §5, if any}"
  slackChannel: "{from §4, if slack output}"
schedule:
  enabled: {true|false}
  cron:    "{from §2, if cron trigger}"
  timezone: "{from §2}"
# Integration configs — engineering to populate per-vertical
```

### 10. Open questions / ambiguities
{any contradictions or unresolved items flagged during the session}

### Full transcript
<details>
<summary>Expand to see the Q&A session</summary>

{full conversation — one Q + A per block, attachment thumbnails inlined}

</details>
```

- **ClickUp tags** applied automatically via `clickup_create_task`'s existing `tags[]` param: `agent-request`, plus a vertical tag extracted from Q1 by Claude (e.g. `vertical:hvac`, `vertical:u65`), plus a capability tag (e.g. `capability:reporting`, `capability:intake`).
- **Assignee:** defaults to Shane's ClickUp user ID (hardcoded to the member directory in `data/clickup-spaces.json`).
- **Status:** starts in `Open`.

---

## 7. Slack Surface

### Tools contributed via `agentBuilderManifest.liveTools[]`

| Tool | Purpose |
|---|---|
| `propose_agent` | Start a new session. Takes an initial user prompt. Returns the first question from the canonical list. Internally creates a row in `agent_builder_sessions`. |
| `refine_agent_spec` | Append an answer to the current session, return the next question (canonical or adaptive) or signal readiness to finalize. State-machine driven inside `session.ts`. |
| `create_agent_prd_ticket` | Finalize the session: render the PRD, call `clickup_create_task` with the rendered body, mark the session `submitted`, return the ClickUp task URL. |

The three-tool surface mirrors how `clickup_find_tasks` + `clickup_get_task` + `clickup_add_comment` work today — Claude orchestrates them in the conversation loop.

### Fallback detection (the "can't do X" trigger)

Injected via the manifest's `systemPromptBlurb`:

> "If the user asks for something that doesn't map to any existing agent, workflow, integration, or tool, proactively suggest building a new agent. Phrase it as a question: 'We don't have an agent for that yet — want me to help draft a PRD?' Do NOT propose this for questions you can answer with existing tools, for trivial requests, or for clarifications of existing capabilities. Use judgment: the right moment is when the user has a clear business need that repeatedly won't be solvable by today's stack."

This is intent-based, not regex on error strings (per Decision 5). Claude already has the integrations catalog in its context, so it can reason about what's in scope.

### Example Slack exchange

```
User:      @Elevarus what was our LinkedIn ad spend last week?
Elevarus:  We don't have a LinkedIn Ads integration wired up yet. Want me
           to help draft a PRD for a new agent that handles this? I'll ask
           six scoping questions.
User:      yeah

Elevarus:  [propose_agent]
           Q1 of 6: In one sentence, what problem does this agent solve,
           who feels the pain, and how are they solving it today?
User:      I need LinkedIn spend visible next to Meta and Google in the
           agency P&L. Right now I'm manually exporting LinkedIn CSVs
           every Monday and pasting numbers into the weekly report.

Elevarus:  Got it — agency-level LinkedIn spend parity with Meta/Google;
           replacing a weekly manual CSV paste.
           Q2 of 6: What event should trigger the agent, and how often?
User:      Weekly, Monday mornings 8am PT, same as the rest of the P&L.

Elevarus:  Q3 of 6: Walk me through step-by-step what the agent does —
           number each step, name the data source for any fetch.
User:      1. Pull LinkedIn spend last 7 days (agency account)
           2. Pull Meta + Google spend same window (already have these)
           3. Compute spend-by-platform rollup
           4. Render Slack summary
           5. Post to #agency-reports

           ... [continues through Q4, Q5, Q6]

Elevarus:  [create_agent_prd_ticket]
           Ticket created: https://app.clickup.com/t/abc123
           "Agent: LinkedIn Ads Reporting"
           Flagged: requires new LinkedIn Marketing API integration (Q3.1).
           Engineering will review within the next business day.
```

---

## 8. Dashboard Surface

### Pseudo-agent card on `/agents`

Pinned to the top of the grid. Same shape as real agent cards for visual consistency.

- **Title:** "Agent Builder"
- **Subtitle:** "Propose a new agent"
- **Avatar:** Gear / plus icon
- **CTA:** "New agent" button (replaces the usual "View jobs" link)
- **Badge:** None (real agents show Enabled/Disabled; this one is always active)

### `/agents/new` wizard

Same question logic as Slack, rendered as a chat-style UI — **not** a multi-step form. Messages in a scrolling pane; composer at the bottom with paste/drop/upload for screenshots, markdown rendering for assistant messages, copy buttons on code blocks. Chat-native feel because answers are often long, reference past outputs, and include screenshots — a form would fight the content.

**Library choice: `shadcn-chat`** ([github.com/jakobhoeg/shadcn-chat](https://github.com/jakobhoeg/shadcn-chat)).

- Drop-in React components (`ChatMessageList`, `ChatBubble`, `ChatInput`, `ChatMessageAction`, etc.) built on the same shadcn/ui primitives the dashboard already uses — no new design system to reconcile.
- MIT licensed, no runtime dependency on an LLM SDK (other libs like Vercel AI SDK's `useChat` and `assistant-ui` are good but LLM-streaming-oriented, which our deterministic dashboard path doesn't need).
- Supports message actions (copy, edit, regenerate), loading dots, typing indicators, and custom attachment slots out of the box.
- We wrap it with our own `AgentBuilderChat` component; shadcn-chat provides primitives, we own the state machine.

**Companion libs:**

- **`react-markdown`** + **`react-syntax-highlighter`** — render assistant messages (the canonical questions are plain text; assistant-authored summaries of the session may use markdown).
- **Native `onPaste` handler** on the composer — clipboard images get captured as blobs, uploaded to Supabase Storage, referenced as image markdown in the message. No extra library needed.
- **Native drag-and-drop** + `<input type="file" accept="image/*,application/pdf">` — same upload path as paste.
- **No `react-dropzone`** — native DnD + HTMLInputElement does everything we need. Skip the dep.

**Attachments storage:**

- Supabase Storage bucket `agent-builder-attachments`, one folder per session ID.
- Transcript JSONB stores the Storage object URL plus a thumbnail URL for images.
- Retention: attachments live as long as the session (7 days post-abandon / indefinitely for submitted sessions until the ClickUp ticket is closed).
- ClickUp ticket body links to the Supabase Storage URLs directly — no re-upload into ClickUp (which would fragment the source of truth).

**Under the hood:**

- `POST /api/agent-builder/session` — creates a session, returns `{ sessionId, firstQuestion }`
- `POST /api/agent-builder/session/:id/turn` — submits user answer (text + optional attachment URLs), returns `{ nextQuestion | readyToFinalize: true }`
- `POST /api/agent-builder/session/:id/attachments` — multipart form for file upload, returns Storage URL(s)
- `POST /api/agent-builder/session/:id/ticket` — renders and creates the ClickUp task, returns `{ ticketUrl, sessionStatus: "submitted" }`

"Submit PRD" button appears when the session returns `readyToFinalize`. The wizard stays active until submit — the user can scroll back, edit prior answers (each turn has an "Edit" action that re-opens the composer prefilled with their previous answer and truncates subsequent turns).

**No Claude loop on the dashboard path** — the question state machine is in `session.ts` and is deterministic (6 canonical + up to 3 adaptive). Dashboard never calls Claude directly; it only calls the `/api/agent-builder/*` endpoints. This keeps the surface predictable and costs zero tokens per dashboard-initiated session. **Slack** retains the full Claude loop for natural-language flow.

This does mean Slack and Dashboard ask questions slightly differently: Slack gets Claude's phrasing, Dashboard gets the fixed canonical text. Acceptable trade for determinism on the dashboard side.

---

## 9. Code Layout

### New files

```
src/core/agent-builder/
  session.ts           Session lifecycle + state machine
  prompts.ts           Canonical questions, follow-up heuristics
  prd-renderer.ts      Transcript → markdown PRD
  slack-tools.ts       QATool[]: propose_agent, refine_agent_spec, create_agent_prd_ticket
  manifest.ts          Pseudo-manifest (no Supabase tables, just liveTools + systemPromptBlurb)
  index.ts             Barrel export

src/api/agent-builder.routes.ts     (new file — keep server.ts slim)
```

### Touched files

- `src/core/integration-registry.ts` — push `agentBuilderManifest`. The `status()` returns `"configured"` always (it has no env dependencies).
- `src/api/server.ts` — mount `agentBuilderRouter`, add 3 routes under `/api/agent-builder`.
- Dashboard:
  - `src/app/(dashboard)/agents/page.tsx` — render pseudo-agent card
  - `src/app/(dashboard)/agents/new/page.tsx` — new wizard page
  - `src/lib/api.ts` — typed fetch helpers for the three endpoints
- `data/schema-annotations.json` / migration — new table `agent_builder_sessions`:

```sql
CREATE TABLE agent_builder_sessions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT          NOT NULL,           -- 'slack' | 'dashboard'
  created_by      TEXT,                             -- slack_user_id or dashboard user email
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  status          TEXT          NOT NULL DEFAULT 'open',   -- open | submitted | abandoned
  transcript      JSONB         NOT NULL DEFAULT '[]',     -- [{role, content, attachments?, ts}, ...]
  attachments     JSONB         NOT NULL DEFAULT '[]',     -- [{url, mime_type, filename, size_bytes, uploaded_at}]
  proposed_name   TEXT,
  clickup_task_id TEXT                                     -- set when submitted
);
```

**Supabase Storage:** one bucket `agent-builder-attachments`, public-read (URLs are unguessable UUIDs), one folder per session ID. Bucket policies:

- `INSERT`: service role only (API uploads on behalf of the authenticated user)
- `SELECT`: public (so ClickUp previews and engineers reviewing tickets don't need credentials)
- Lifecycle: Supabase Storage doesn't have native lifecycle rules — a weekly cleanup cron deletes folders for sessions in `abandoned` state for >30 days.

**Dashboard (Next.js) additions:**

- `pnpm add react-markdown react-syntax-highlighter` (companion libs)
- `shadcn-chat` — not published to npm; install via CLI per their README (copies components into `src/components/chat/`, same pattern as `shadcn/ui`).
- No other new dependencies.

No changes to `instance-config.ts`, `workspace-scaffold.ts`, or `POST /api/instances` — those stay the post-approval path for when engineering decides to actually build the new agent.

---

## 10. Phased Rollout

| Phase | Deliverable | Effort | Gates |
|---|---|---|---|
| **0. ClickUp prerequisite** | `clickup_create_task` tool must be live (ClickUp PRD Phase 2). "Agent Requests" list created, `CLICKUP_DEFAULT_LIST_ID` set or per-call list override wired. | 0.5 day (mostly waiting on ClickUp PRD Phase 2) | Smoke test: Slack creates a test task in Agent Requests list. |
| **1. Core module + API** | `src/core/agent-builder/` files, `agent_builder_sessions` migration, 3 REST routes, manifest registered. No UI yet — test via curl + REPL. Includes the 6-question state machine, adaptive follow-up heuristics, and `prd-renderer.ts` matching the §6 ticket schema. | 2.5 days | `curl POST /api/agent-builder/session` → get Q1; answer 6 times → get `readyToFinalize: true`; finalize → ClickUp task appears with all 10 sections populated and the stage list formatted as a dev-ready build list. |
| **2. Slack surface** | `slack-tools.ts` with 3 tools; system-prompt blurb with fallback detection guidance; update `docs/qa-bot.md` with the new tools. | 1 day | Demo: "@Elevarus build me a LinkedIn spend bot" — full 5-question flow, ClickUp ticket posted. Also: ask a question the bot can't answer, get proactive "want to build one?" response. |
| **3. Dashboard surface** | `/agents` pseudo-agent card, `/agents/new` wizard page built on `shadcn-chat`, paste/drop/upload attachment support, Supabase Storage bucket + upload route, typed API helpers. | 2 days | Click "New agent" → chat wizard → paste a screenshot in Q6 → ticket URL shown on completion with Storage-hosted image visible in the ClickUp task body. |
| **4. Observability** | Audit every session-finalize via `auditQueryTool`. Weekly Slack digest of open/submitted sessions. | 0.5 day | Sessions surface in `/api/audit` (if/when that ships). Digest posts Fridays at 9am PT to the eng channel. |
| **5. (Deferred) Self-serve scaffold** | One-click "Create this agent" button on a submitted ticket that calls `POST /api/instances` + `scaffoldInstanceWorkspace()`. Gated behind a feature flag. | 2 days | Reviewer clicks button on a Reviewed ClickUp ticket → new agent shows up in `/agents` with `enabled: false` pending their final pass. |

**Total through Phase 4:** ~6.5 working days. Phase 5 optional, ship when we've seen 5+ tickets go through the Phase 1–4 path and the ticket schema has stabilized.

---

## 11. Risks & Open Questions

- **OQ-01 — Session abandonment.** Users start, answer 2 questions, walk away. How long until we mark a session `abandoned`? Suggest 7 days of inactivity, sweeper cron once a day. No notification.
- **OQ-02 — Duplicate agents.** Two users propose overlapping agents ("HVAC weekly summary" and "HVAC weekly report"). Detection is engineering's job at review time. Not worth automating in v1.
- **OQ-03 — Non-agent requests sneaking in.** Users will try to use Agent Builder to request features that aren't really agents ("make the dashboard show dark mode"). The Q1 framing (who feels the pain, what's the problem) filters some; Q3 (what's the output) catches more. If the resulting ticket is out-of-scope, engineering closes it with a comment.
- **OQ-04 — Adaptive follow-ups going off the rails.** Claude might ask 3 irrelevant follow-ups. The hard cap (9 total) is the safety net. If we see drift, tighten the follow-up guidance.
- **OQ-05 — PII in transcripts and attachments.** Transcripts are stored verbatim in Supabase; attachments (screenshots) may contain PII or credentials. Mitigations: (a) `prompts.ts` opens with a reminder — "don't paste tokens, passwords, or customer PII; redact before attaching screenshots"; (b) attachments are public-read but URLs are unguessable UUIDs; (c) engineering reviewers delete tickets containing inadvertent PII. Automated redaction is out of scope for v1.
- **OQ-09 — Attachment size and count limits.** Propose: 10 MB per file, 10 files per session, image/PDF only. Rejected uploads return an error message the chat renders inline. Enforcement in `POST /api/agent-builder/session/:id/attachments`.
- **OQ-06 — Naming collisions.** User proposes an agent with the same `id` as an existing one. Finalize step validates against `listInstanceIds()` and suggests a variant (`linkedin-ads-reporting-v2`).
- **OQ-07 — Can the Agent Builder propose a new integration?** Yes — if Q2's answer names a system we don't integrate with, the PRD ticket gets a "New integrations needed" flag. Engineering decides whether to spin off a separate integration PRD before the agent PRD becomes viable. Not automated; a judgment call.
- **OQ-08 — What about workflow variants we don't support?** If the user asks for something that doesn't fit `blog`, `reporting`, `intake`, or `custom`, the ticket gets flagged for workflow design review. Agent Builder doesn't invent new workflow types.

---

## 12. Related Docs

- [docs/prd-clickup-integration.md](./prd-clickup-integration.md) — the ClickUp write tools that Agent Builder depends on (Phase 0 gate).
- [docs/architecture.md](./architecture.md) — current agent / workflow / integration model.
- [docs/instances.md](./instances.md) — instance.md schema, which the PRD ticket's "Suggested Instance Config" block mirrors.
- [docs/qa-bot.md](./qa-bot.md) — Slack bot tool-use loop; will be updated with Agent Builder's tool inventory in Phase 2.
