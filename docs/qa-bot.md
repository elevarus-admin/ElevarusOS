# ElevarusOS — Q&A Bot ("Ask Elevarus")

Product requirements and phased development plan for an in-channel Slack
assistant that answers questions about ElevarusOS state, instances, workflows,
and integrations.

- **Owner:** Shane McIntyre / Elevarus
- **Status:** Draft v1
- **Last updated:** 2026-04-17

---

## 1. Problem & Goal

The current Slack integration (`src/adapters/notify/slack.adapter.ts`,
`src/core/slack-client.ts`) is outbound only. It posts workflow lifecycle
notifications — job started, draft ready for approval, failure, completion —
but it does not receive messages.

Team members reading those notifications routinely have follow-up questions
that the bot could answer if it had read access to its own state:

- "Why did the HVAC report flag yellow this morning?"
- "Is the blog draft for <topic> stuck in editorial?"
- "What integrations does the U65 reporting agent use?"
- "Show me the last three final-expense reports."
- "Which bots haven't run today?"

**Goal:** let users ask these questions with `@Elevarus …` in any channel the
bot is invited to, and get a grounded answer that cites the three ElevarusOS
layers — **Instances (MC Agents), Workflows, Integrations** — and the live
job store.

---

## 2. Scope

### In scope (v1)

- `@Elevarus <question>` mentions in any channel the bot is a member of
- Direct messages to the bot
- Threaded replies (answers in-thread, preserving channel cleanliness)
- Claude-generated answers grounded in:
  - Instance catalog (`src/instances/*/instance.md`, `MISSION.md`, `soul.md`)
  - Workflow registry (types + stage sequences)
  - Integration catalog (Ringba, Meta, LeadsProsper capabilities)
  - Live job store (`/api/jobs`, `/api/jobs/:id/output`)
- Channel-aware context (last ~20 messages + channel name/purpose)
- Structured audit trail: every question becomes a `qa` job in the job store

### Out of scope (v1)

- Slash commands, interactive buttons, modals
- Multi-workspace OAuth / app-store distribution
- Proactive messaging (bot speaks unprompted)
- Write actions (approving jobs, kicking off a workflow, editing state)
- Streaming replies (Slack rewrites tokens poorly; we post a single message)
- File uploads / attachments (images, CSVs)

---

## 3. Architecture Fit

The existing modular pattern is preserved — Q&A is a **new instance**
(`elevarus-assistant`) backed by a **new workflow** (`qa-workflow`), re-using
existing adapters and integrations. No orchestrator or MC-worker changes.

```
Slack Events API (HTTPS)
    │
    ▼
POST /api/webhooks/slack              ◄── new route in src/api/server.ts
    │  (HMAC verify via SLACK_SIGNING_SECRET)
    │  (URL verification challenge returned for setup)
    │
    ▼
SlackEventRouter                       ◄── src/adapters/intake/slack-events.ts
    │  (app_mention, message.im → enqueue QA job)
    │
    ▼
QAWorkflow                             ◄── src/workflows/qa/
    ├─ Stage 1: context       (Slack: channel history, user info)
    ├─ Stage 2: knowledge     (instance / workflow / integration catalog)
    ├─ Stage 3: answer        (Claude tool-use loop → structured answer)
    └─ Stage 4: reply         (post threaded response via slack-client)
    │
    ▼
Tools available to Claude (via new claudeConverse()):
    • list_instances            → reads src/instances/*/instance.md
    • get_instance_mission      → reads MISSION.md / soul.md for an instance
    • list_workflows            → enumerates registered workflows + stages
    • list_integrations         → ringba / meta / leadsprosper capabilities
    • query_jobs                → GET /api/jobs?status=&instanceId=&limit=
    • get_job_output            → GET /api/jobs/:id/output
    • get_ringba_revenue        → existing integration query
    • get_meta_spend            → existing integration query
```

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | Events API (HTTP webhook) | Matches existing `/api/webhooks/mc` pattern and HMAC infra. Socket Mode adds a persistent WS we don't need. |
| Slack SDK | Add `@slack/web-api` | Current code uses raw `fetch`. For inbound + `conversations.history` + `users.info`, the SDK pays for itself. Keep `postToSlack` as a thin wrapper. |
| Invocation | `@mention` + DM only | Simplest UX; avoids slash-command registration churn. Slash commands can be a v1.1 add. |
| Claude mode | Tool-use loop (new `claudeConverse()`) | Current `claudeJSON()` is single-shot JSON. Q&A needs multi-turn + tool calls to stay grounded in live state instead of a stale prompt. |
| Context budget | Channel history capped at 20 msgs / ~6k tokens; catalog summarised, not dumped | Prevents runaway token spend on busy channels. |
| Where knowledge lives | Read at query time, not cached | Instance markdown files are small; job store is already indexed. Avoids cache-staleness when an instance is edited. |
| Ephemeral vs public reply | Public in-thread; ephemeral only for errors | Answers are useful to the whole channel; prevents repeat questions. |
| Auth | Any workspace member in invited channels; no per-user ACL in v1 | Matches current trust model. Add ACL when write-actions land. |

---

## 4. Data & API additions

### New environment variables

```
SLACK_SIGNING_SECRET=          # verifies inbound Slack event payloads
SLACK_APP_ID=                  # used to drop self-events so the bot doesn't
                               # reply to its own messages
QA_CHANNEL_HISTORY_LIMIT=20    # max channel messages used as context
QA_MAX_TOOL_ITERATIONS=6       # hard cap on agentic tool-use loop
```

### New routes in `src/api/server.ts`

- `POST /api/webhooks/slack` — Events API receiver
  - Handles `url_verification` challenge (returned verbatim for app setup)
  - Verifies `x-slack-signature` using `SLACK_SIGNING_SECRET`
  - Dispatches `app_mention` and `message.im` events
  - Acknowledges within 3 s (Slack's hard timeout)

### New files

```
src/adapters/intake/slack-events.ts   # parses events → QA job requests
src/workflows/qa/
  qa.workflow.ts                       # 4-stage workflow builder
  stages/context.stage.ts              # fetch channel history + user info
  stages/knowledge.stage.ts            # build catalog summary
  stages/answer.stage.ts               # Claude tool-use loop
  stages/reply.stage.ts                # post threaded response
src/core/claude-converse.ts            # multi-turn + tool-use helper
src/core/knowledge-catalog.ts          # reads instances/workflows/integrations
src/instances/elevarus-assistant/
  instance.md
  MISSION.md                           # tone, scope, refusals
```

### Job model

Reuse existing `Job` with `workflowType: "elevarus-assistant"`. Stage outputs
capture the question, tool calls made, and final answer — giving us an audit
trail and future analytics.

---

## 5. Phased Delivery

| Phase | Deliverable | Rough effort |
|---|---|---|
| **1. Echo** | Webhook + signature verify + `app_mention` handler. Bot replies "Got your question — working on it." in-thread. Proves the Slack event loop end-to-end. | 1 day |
| **2. Static knowledge** | `claudeConverse()` + `knowledge-catalog.ts`. Bot answers architecture questions ("what does the HVAC agent do?", "list the integrations") from instance markdown + registry. No tool use yet. | 2 days |
| **3. Live queries** | Tool-use loop. Adds `query_jobs`, `get_job_output`, `get_ringba_revenue`, `get_meta_spend`. Bot answers "did today's HVAC report run?" and "what was the CPL last week?". | 2–3 days |
| **4. Channel context** | Fetch `conversations.history` + `conversations.info`; inject last N messages into the system prompt so follow-ups resolve ("what about the other campaign?"). | 1 day |
| **5. Polish** | Rate limiting per-user, typing indicators, structured error replies, `/help` capability listing, audit logging. | 1–2 days |

Total: **~7–9 working days** to a production-ready v1.

---

## 6. Risks & open questions

1. **Socket Mode vs Events API in dev** — Events API needs a public URL. Use
   ngrok or Cloudflare Tunnel for local dev; document this in `setup.sh`.
2. **Token cost** — tool-use loops can chain. Cap at `QA_MAX_TOOL_ITERATIONS=6`
   with a hard failure if exceeded.
3. **Channel history privacy** — the bot will read history of channels it's
   invited to. Document this in the Slack app install notes.
4. **Write actions** (approving jobs, kicking off a workflow from Slack) — is
   explicitly deferred; needs per-user auth via Slack user → MC user mapping.
5. **Multi-workspace** — v1 assumes a single Elevarus workspace. Schema
   already supports `team_id` if we extend later.
6. **Latency budget** — Slack expects the webhook to 200 within 3 s. The
   answer workflow may take longer; we ack immediately and post the answer as
   a separate message when ready.

---

## 7. Success metrics

- ≥ 90 % of `@mentions` receive a reply within 10 s
- ≥ 80 % of test-set questions answered correctly (curated set covering all
  three layers — see `test/qa-eval.json` once defined)
- Tool-call audit trail present on every QA job (100 %)
- Zero cross-workspace leaks (100 % of replies posted to the originating
  channel only)

---

## 8. Slack app configuration (reference)

**Bot token scopes:**
- `app_mentions:read` — receive `@Elevarus` events
- `chat:write` — post replies
- `channels:history`, `groups:history`, `im:history` — read channel context
- `channels:read`, `groups:read`, `im:read` — channel metadata
- `users:read` — asker identity
- `im:write` — DM replies

**Event subscriptions:**
- `app_mention`
- `message.im`
- *(later: `message.channels` if we want reactive listening without mentions)*

**Request URL:**
`https://<ELEVARUS_PUBLIC_URL>/api/webhooks/slack`

---
