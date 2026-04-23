# PRD: ElevarusOS Architecture Recommendations

**Version:** 1.0
**Date:** 2026-04-18
**Status:** Draft
**Owner:** Engineering
**Audience:** Engineering, Product, Leadership

---

## 1. Purpose

This PRD translates the findings of an end-to-end architecture review of ElevarusOS into a sequenced plan of work. The review compared the current codebase against the stated vision: an internal platform that (1) automates performance marketing reporting across Google, Meta, Bing, Ringba, LeadsProsper, and Everflow; (2) runs an agentic Slack bot that acts as an extension of the team; (3) grows into project management (ClickUp) and eventual ad creative deployment; and (4) centers on improving unit economics of the pay-per-call / pay-per-lead business through UTM-level attribution.

The goal of this document is to make the backlog legible, prioritized, and tied to business outcomes — not to re-describe what already exists.

---

## 2. Current State Snapshot

ElevarusOS today is a TypeScript workflow orchestration daemon with a Mission Control (MC) dashboard (git submodule), Supabase persistence, and a Slack surface. The engine is solid; the surface area of integrations is narrow.

| Area | Status | Notes |
|---|---|---|
| Core orchestrator / stage engine | Complete | `src/core/` — MCWorker, Orchestrator, stage interface, registry, scheduler, job store |
| Workflow: blog (9 stages, approval gate) | Complete | `src/workflows/blog/` |
| Workflow: PPC reporting (3 instances: final-expense, u65, hvac) | Complete | `src/workflows/*-reporting/` |
| Ringba integration (warehouse + sync) | Complete | `src/integrations/ringba/` |
| LeadsProsper integration (warehouse + sync) | Complete | `src/integrations/leadsprosper/` |
| Meta Ads integration | Partial | Spend only; no campaign breakdown, no conversion data |
| Google Ads integration | Missing | 0 LOC |
| Bing Ads integration | Missing | 0 LOC |
| Everflow integration | Missing | 0 LOC |
| ClickUp integration | Missing (spec exists) | `docs/prd-clickup-integration.md` is detailed but unimplemented |
| Slack bot: event reception + static Q&A | Complete | `src/core/slack-events.ts`, `slack-context.ts` |
| Slack bot: tool-using agent loop | Missing | Tools defined in `src/core/qa-tools.ts`; execution is TODO |
| UTM → profit attribution | Missing | Schema has `phone_normalized` join key; no UTM capture, no views |
| Ad creative deployment | Missing | 0 LOC |
| Tests | Missing | 0 test files |
| Observability (traces, metrics) | Minimal | Structured logs only; no request/trace IDs, no metrics |
| Auth / RBAC | Minimal | Optional `x-api-key`, HMAC webhooks, service-role Supabase |

**Architectural strengths to preserve:** strict TypeScript, clean stage interface, adapter pattern for blog workflow, checkpoint-driven sync pattern, declarative `instance.md` configs, webhook-driven MC integration.

**Architectural debts to pay down alongside new work:** inconsistent adapter use between blog (pluggable) and reporting (hardcoded); no unified fact table across platforms; no tests; thin observability; 24h in-memory approval promises; global-checkpoint syncs that can starve fast campaigns.

---

## 3. Business Goals & Success Metrics

ElevarusOS exists to improve the P&L, not to ship features. Every initiative in this PRD should move one of these metrics.

| Metric | Baseline (today) | Target (90 days) | Owner |
|---|---|---|---|
| Hours/week spent on manual media-buying reports | ~15–20 (estimated) | < 3 | Media team |
| Time-to-insight on a losing campaign | Days | < 2 hours | Media team |
| % of spend attributed to a known UTM path | Unknown / low | ≥ 90% | Analytics |
| % of leads/calls reconciled across LP ↔ Ringba | Unknown | ≥ 95% by `phone_normalized` within ±48h | Analytics |
| Slack questions answerable by bot without human | ~0% (bot is static) | ≥ 60% of "status / perf / why" questions | Platform |
| Mean stage failure recovery time | Manual | Auto-retry with jitter; alert on 3rd failure | Platform |

A quarterly review should re-measure these. If an initiative doesn't move one, cut it.

---

## 4. Guiding Principles

1. **Unit economics first.** Integrations that close the loop from ad spend → call/lead → disposition → revenue come before integrations that are merely "nice to have."
2. **One fact model.** Every new platform lands in the same shape: `client → repository → sync worker → upserts to a narrow warehouse table → joined into a unified attribution view`.
3. **Adapters, not hardcoded stages.** The reporting workflows should move toward the blog workflow's adapter pattern so new data sources and notify channels slot in without editing stage code.
4. **Agentic by default, with guardrails.** The Slack bot should execute tools, not just describe them. Write actions (create task, trigger workflow, publish ad) always require explicit confirmation or an approval gate.
5. **Observability is not optional.** Trace IDs and metrics go in *with* new code, not after. A future incident is cheaper to debug than to reconstruct.
6. **Tests for the critical path.** Stage execution, retry/backoff, approval gate, sync checkpoints, and webhook signature verification get unit tests before new surface area is added on top.

---

## 5. Roadmap

Three phases, roughly 0–30 / 30–60 / 60–120 days. Phase boundaries are guidance, not contracts — items can move forward if dependencies land early.

### Phase 1 — Foundation & Attribution (0–30 days)

Goal: make every dollar of ad spend attributable to a UTM, a call/lead, and a disposition; harden the engine so we can safely add surface area on top.

**P1.1 UTM capture + attribution view** (High impact, medium effort)
- Extract UTM params from `lp_leads.lead_data` into a dedicated `lp_lead_utms` table (`lead_id`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `landing_url`).
- Add `attribution_v1` view: `lp_lead_utms ⟕ lp_leads ⟕ ringba_calls` on `phone_normalized` within ±48h, with `cost`, `payout`, `revenue`, `profit` rolled up.
- Backfill from existing `lp_leads` via a one-shot script (`scripts/backfill-utms.ts`).
- Add SQL tests (fixtures → expected rows) using pgTAP or a simple test harness.

**P1.2 Google Ads ingestion** (High impact, medium effort)
- New integration package `src/integrations/google-ads/` following the Ringba/LP shape (client, repository, sync, types).
- Tables: `google_ads_campaigns`, `google_ads_daily_spend`, `google_ads_sync_state`.
- Scope for v1: campaign-level daily spend, impressions, clicks, conversions. Join to attribution view via `utm_campaign`.
- Use `google-ads-api` SDK; store refresh token per-account in Supabase, not `.env`.

**P1.3 Bing Ads ingestion** (Medium impact, medium effort)
- Same shape as Google Ads; Microsoft Advertising SDK.
- Tables: `bing_ads_campaigns`, `bing_ads_daily_spend`, `bing_ads_sync_state`.

**P1.4 Meta Ads — complete the integration** (High impact, low effort)
- Extend `src/integrations/meta/` from spend-only to campaign × adset × ad × day, including CPL, conversions, and creative IDs.
- Land in `meta_ads_daily` table, wire into attribution view.

**P1.5 Platform hardening** (High impact, low effort — do in parallel)
- Jest + tests for: stage retry/backoff, approval gate timeout, `phone_normalized` join correctness, webhook HMAC verification, sync checkpoint advancement.
- Exponential backoff with jitter and `Retry-After`/quota-header awareness in every integration client.
- Request/trace IDs: propagate a `traceId` from API request / MC webhook / scheduled trigger through the job and every stage log line.
- Structured JSON logs (one line per event) and a lightweight metrics emitter (counter/timer interface; start with stdout, swap to Datadog/OTel later).

**Exit criteria for Phase 1:**
- A single SQL query answers *"what did we spend on utm_campaign=X last week, how many calls/leads, what revenue, what profit?"* across Google/Meta/Bing → LP → Ringba.
- Critical-path code has ≥ 70% test coverage.
- Every job has a trace ID visible in logs and in MC.

### Phase 2 — Agentic Slack Bot & ClickUp (30–60 days)

Goal: move the Slack bot from a static responder to a tool-using assistant; bring project management into the loop.

**P2.1 Slack bot: tool execution (Phase 2 of existing `qa-bot` roadmap)**
- Wire the tools declared in `src/core/qa-tools.ts` to real handlers: `query_job_status`, `get_workflow_info`, `list_active_instances`, `get_campaign_performance`, `explain_attribution`.
- Multi-turn loop with `claude-converse.ts`; per-message cost cap and token logging.
- Read-only tools autorun; any write tool (trigger workflow, create task, mutate data) requires an explicit confirm step (button in Slack or "yes" reply).

**P2.2 Slack bot: agentic performance triage**
- New tool: `diagnose_campaign(campaign, window)` — pulls spend, calls, leads, conversion rate, EPC, EPL, flags anomalies (e.g., >2σ drop in conversion rate, spend without calls). Returns a structured finding the bot narrates.
- Slash commands: `/elevarus status <instance>`, `/elevarus why <campaign>`, `/elevarus report <instance> today|mtd`.

**P2.3 ClickUp integration (Phase 1 outbound)**
- Implement per existing `docs/prd-clickup-integration.md`: `src/integrations/clickup/` (client, types, sync stage).
- Instance config gains a `clickup:` block (list ID, template IDs).
- Workflows emit task-create / task-update events to ClickUp at stage boundaries.

**P2.4 ClickUp Phase 2 (inbound)**
- Webhook receiver at `/api/webhooks/clickup` (HMAC-verified).
- Map ClickUp status changes to MC task state; map assignee changes to notifier routing.
- Slack notification when an assigned task goes stale (> SLA).

**Exit criteria for Phase 2:**
- ≥ 60% of routine Slack questions answered end-to-end by the bot (measured via reactions or an explicit "helpful?" prompt).
- Media leads can ask *"why did final-expense CPL spike yesterday?"* and get a multi-source answer without opening a dashboard.
- Every workflow stage that matters to ops produces or updates a ClickUp task automatically.

### Phase 3 — Everflow, Creative Deployment, Scale (60–120 days)

Goal: close the remaining data gaps, begin to *act* on the data (creative deployment), and prepare the platform for 10× throughput.

**P3.1 Everflow ingestion**
- Design decision: webhook-driven (preferred if Everflow supports it for our plan) vs. polling.
- Tables: `everflow_conversions`, `everflow_offers`, `everflow_sync_state`.
- Join into attribution view on `phone_normalized` + time window; surface disposition (e.g., approved / rejected / pending) as a column.

**P3.2 Creative deployment — Meta first**
- New workflow: `creative-deploy` with stages: intake (brief + asset URLs) → compliance check (Claude with policy prompt) → upload to Meta (image/video + ad set + ad) → approval gate → publish → notify.
- Schema: `creative_assets`, `creative_deployments` (one per platform × ad set).
- Explicit approval gate before publish; no auto-publish without a human.

**P3.3 Creative deployment — Google Ads + Bing**
- Extend the same workflow to Google Ads and Microsoft Advertising. One adapter per platform behind a common `CreativePublisher` interface.

**P3.4 Per-campaign sync checkpoints + backfill fairness**
- Replace global `*_sync_state` row with per-campaign checkpoints so a slow campaign doesn't starve fast ones.
- Concurrency limit per integration (e.g., N parallel campaign syncs).

**P3.5 Approval gate persistence**
- Move the in-memory approval promise to a DB-backed state machine keyed by `(job_id, stage_name)`. Survives restarts; removes the 24h in-memory hold.

**P3.6 AuthN / AuthZ v2**
- Per-user tokens with scopes (read / write / admin).
- Audit log table (`audit_events`): who, what, when, which job/task.
- RLS on any table that ever holds user-identifiable data.

**Exit criteria for Phase 3:**
- Attribution view spans Google / Meta / Bing → LP / Ringba / Everflow.
- A media buyer can ship a new Meta ad from a Slack command + approval click, end to end through ElevarusOS.
- Restarting the daemon does not lose in-flight approvals.
- Every API call is attributable to a user, with an audit record.

---

## 6. Cross-Cutting Workstreams

These run through all phases; they are not separate phases.

**Adapter convergence.** Refactor the PPC reporting workflows (`src/workflows/*-reporting/stages/01-data-collection.stage.ts`) to consume pluggable `DataSourceAdapter` instances rather than directly calling `ringba`/`meta` modules. Concretely: a `DataSourceAdapter` returns a `CampaignPerformanceSnapshot` shape regardless of upstream vendor. This makes Google/Bing/Everflow drop-in.

**Unified fact table.** As each integration lands, also upsert into a `perf_fact_daily` table keyed by `(date, platform, account_id, campaign_id, utm_campaign)` with a narrow set of columns (spend, impressions, clicks, leads, calls, conversions, revenue). This is the table the attribution view and the Slack bot read; the per-platform tables remain the source of truth.

**Cost & token governance.** Every Claude call logs tokens and a dollar estimate. Per-instance monthly budget in `instance.md` with soft-warn / hard-stop thresholds. Dashboard tile for spend by instance by week.

**Secrets management.** Migrate integration credentials (Google, Bing, Meta refresh tokens, ClickUp, Everflow, Ringba, LP API keys) out of `.env` and into Supabase with encryption at rest; rotate-able per-account. `.env` keeps only bootstrap secrets (Supabase service key, signing secrets).

**Documentation discipline.** Every new integration adds a one-page `docs/integrations/<name>.md` (auth setup, rate limits, quirks, checkpoint semantics). Every new workflow adds an entry to `docs/workflows.md`.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Attribution view produces wrong profit numbers (phone-match false positives) | Medium | High | Explicit ±48h window, reconciliation sampling script, weekly audit against manual spot-checks; publish confidence column |
| Slack bot takes a write action a user didn't want | Medium | High | No write tool autoruns; always require explicit confirm; audit log of every tool call |
| Ad-creative auto-publish violates platform policy | Low | High | Compliance-check stage (Claude with policy prompt) + human approval gate + no auto-publish path |
| Vendor API rate limits / quota outages stall reporting | Medium | Medium | Per-campaign checkpoints, adaptive backoff, circuit breaker, stale-cache fallback for reports |
| Claude cost creep as agent loops grow | Medium | Medium | Per-instance budget, token logs, prompt caching for static catalogs, Haiku for low-stakes tool selection |
| Regression in existing blog / reporting flows during refactor | Medium | Medium | Tests on the critical path *before* the adapter refactor; feature-flag the new adapter path |
| Lost in-flight work on daemon restart (in-memory approval promise) | High (existing) | Medium | Phase 3 DB-backed approval state; until then, document and avoid restarts during active approvals |

---

## 8. Out of Scope (for this PRD)

- Rebuilding Mission Control — it's a separate repo and product.
- Customer-facing dashboards / white-labeling.
- Non-phone-based attribution (email, chat) — revisit when a client needs it.
- Full data warehouse (Snowflake/BigQuery) — Supabase is sufficient until it isn't; re-evaluate at 10× current row counts.

---

## 9. Open Questions

1. **Everflow transport:** does our Everflow plan expose webhooks, or are we polling the reporting API? This drives P3.1 timing.
2. **Google Ads auth model:** one MCC refresh token vs. per-account tokens? Per-account is safer but more ops.
3. **Creative deployment approvers:** who signs off on a Meta ad going live from ElevarusOS — media lead, compliance, or both?
4. **ClickUp as source of truth:** when MC task state and ClickUp task state disagree, which wins? Proposal: MC wins for workflow state, ClickUp wins for human-facing task fields (assignee, due date, description).
5. **Cost attribution for Claude:** charge per-instance, per-workflow, or pooled? Affects the budget tiles.
6. **Slack bot write-tool confirmation UX:** buttons (richer, more setup) vs. "reply yes" (simpler, laggier)?

---

## 10. Appendix: Priority-Ordered Backlog

Top of the list = do next. Lower numbers are roughly sequential; items inside a phase can parallelize.

1. Jest + tests for stage retry, approval gate, HMAC verification, phone-match join, sync checkpoint.
2. Trace IDs + structured JSON logs across MCWorker / Orchestrator / stages / integration clients.
3. UTM extraction from `lp_leads` → `lp_lead_utms` + `attribution_v1` view + backfill script.
4. Complete Meta Ads integration (campaign × adset × ad × day).
5. Google Ads ingestion (client, repository, sync, tables).
6. Bing Ads ingestion.
7. Unified `perf_fact_daily` table; migrate attribution view to read from it.
8. Slack bot Phase 2: tool execution with read/write separation and confirm step.
9. Slack bot: `diagnose_campaign` tool + `/elevarus why` command.
10. ClickUp Phase 1 (outbound) per existing PRD.
11. ClickUp Phase 2 (inbound webhook + status mapping).
12. Refactor PPC reporting stages to use `DataSourceAdapter`.
13. Everflow ingestion.
14. Creative deployment workflow — Meta.
15. Creative deployment — Google Ads + Bing.
16. Per-campaign sync checkpoints + concurrency limits.
17. DB-backed approval state machine.
18. Secrets migration from `.env` to Supabase with rotation.
19. Per-user tokens + audit log + RLS.

---

## 11. Review & Next Steps

- Circulate this PRD to engineering and the media leads for comment.
- Book a 60-minute review to resolve the Open Questions in §9.
- After review, convert Phase 1 items into tracked tasks in Mission Control (and once P2.3 ships, mirror to ClickUp).
- Re-measure §3 metrics at the 30 / 60 / 90 day marks; adjust priorities based on which ones move.
