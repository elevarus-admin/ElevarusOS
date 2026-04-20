# Working — HVAC Campaign Report Bot

Operational status log. Updated manually when behavior is confirmed or changed.

---

## Status

**ACTIVE — revenue source pending**

Last confirmed working: 2026-04-19 (recreated post-MC-removal)

Working sources:
- Meta Ads — account `24568971736103024` verified visible to System User token

Pending sources:
- **Thumbtack revenue** — needs `hvac-thumbtack-report-import` agent to ingest the shared "daily sessions" sheet into Supabase. Open question: what's the share format (Google Sheet URL, CSV email, Thumbtack API)?

---

## Configuration

| Setting | Value |
|---------|-------|
| Slack channel | `#cli-hvac` (placeholder — confirm) |
| Schedule | Once daily, Mon–Fri at 9am EST (reports yesterday + MTD) |
| Cron expression | `0 9 * * 1-5` |
| Timezone | `America/New_York` |
| Base workflow | `ppc-campaign-report` |
| Meta ad account | `24568971736103024` (SaveOnMyQuote.com. - HVAC) |
| Revenue source | Thumbtack daily sessions / owed revenue (PENDING) |

---

## Change Log

| Date | Change |
|------|--------|
| 2026-04-19 | Agent recreated post-MC-removal. Meta wired; Thumbtack revenue blocked on import-agent design. |
