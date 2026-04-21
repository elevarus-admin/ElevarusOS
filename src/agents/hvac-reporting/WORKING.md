# Working — HVAC Campaign Report Bot

Operational status log. Updated manually when behavior is confirmed or changed.

---

## Status

**ACTIVE**

Last confirmed working: 2026-04-21 (data-collection rewired to read Thumbtack from Supabase + combined revenue model)

Working sources:
- **Meta Ads** — account `24568971736103024` verified visible to System User token
- **Thumbtack** — reads `thumbtack_daily_sessions` (source='hvac'), populated nightly by the `hvac-thumbtack-import` agent

Pending sources:
- **Ringba** — code path wired; awaiting the exact HVAC campaign name to uncomment the `ringba:` block in `instance.md`.

---

## Configuration

| Setting | Value |
|---------|-------|
| Slack channel | `#cli-hvac` |
| Schedule | Once daily, Mon–Fri at 9am EST (reports yesterday + MTD) |
| Cron expression | `0 9 * * 1-5` |
| Timezone | `America/New_York` |
| Base workflow | `ppc-campaign-report` |
| Meta ad account | `24568971736103024` (SaveOnMyQuote.com. - HVAC) |
| Revenue sources | Thumbtack `owed_revenue` (Supabase) + Ringba `totalRevenue` (when configured) |

---

## Slack output format

Plain mrkdwn, 3 lines (header + Yesterday + MTD) posted directly — no Block Kit wrapper, no oneLiner section, no divider. Matches the `final-expense-reporting` condensed format. Layout defined by `src/workflows/_shared/compact-slack-format.ts`.

---

## Change Log

| Date | Change |
|------|--------|
| 2026-04-19 | Agent recreated post-MC-removal. Meta wired; Thumbtack revenue blocked on import-agent design. |
| 2026-04-21 | Data-collection rewritten: pulls Thumbtack (Supabase) + Ringba + Meta in parallel for Yesterday + MTD; combined revenue model. Slack-publish switched to plain mrkdwn (no Block Kit) to match FE condensed format. Analysis stage reshaped to emit yesterday/mtd periods. |
