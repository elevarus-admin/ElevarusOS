# Working — U65 Campaign Report Bot

Operational status log. Updated manually when behavior is confirmed or changed. Not cleared between runs.

---

## Status

**ACTIVE — partial wiring**

Last confirmed working: 2026-04-19 (recreated post-MC-removal)

Working sources:
- **Meta** — `510515032059235` (Covered Health Plans U65 Private Health) — verified visible to System User token 2026-04-19
- **Everflow** — offer 8, INTERNAL exclusion — verified live 2026-04-19
- **Tier 1 fee** — config in place, `accruedTier1Cost` helper available

Pending sources:
- **Ringba** — campaign name placeholder; needs the exact U65 Ringba campaign string.
- **Google Ads** — OAuth refresh-token not configured (`GOOGLE_ADS_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` all blank in `.env`).
- **Bing Ads** — no Microsoft Advertising integration in repo.

---

## Configuration

| Setting | Value |
|---------|-------|
| Slack channel | `#cli-u65-bluejay` |
| Schedule | Mon–Fri every 2h: 9am, 11am, 1pm, 3pm, 5pm EST |
| Cron expression | `0 9,11,13,15,17 * * 1-5` |
| Timezone | `America/New_York` |
| Base workflow | `ppc-campaign-report` |
| Meta ad account | `510515032059235` (Covered Health Plans U65 Private Health) |
| Everflow offer | `8` — Private Health Insurance |
| Everflow excluded partners | substring match `INTERNAL` |
| Tier 1 fee | `$367/business day`, prorated 10am–6pm PT |

---

## Known Behavior

**Cost basis is multi-source** — never collapse Meta + Everflow + Tier 1 into a single "ad spend" number; the breakdown is the value.

**Tier 1 prorating:**
- Before 10am PT: $0
- During business hours: linear from $0 → $367 (e.g. 2pm = 4/8 hrs = $183.50)
- After 6pm PT: full $367
- Past days: full $367 each

**Everflow INTERNAL exclusion:**
The substring `INTERNAL` (case-insensitive) on partner name drops three known partners from rollups: `_Internal U65 CHP META`, `_INTERNAL U65 Google`, `INTERNAL Covered Health Plans Bing`. Confirmed via live API on 2026-04-19.

---

## Change Log

| Date | Change |
|------|--------|
| 2026-04-19 | Agent recreated post-MC-removal. Multi-source cost basis (Meta + Everflow + Tier 1) wired. Google Ads / Bing Ads stubbed pending integrations. |
